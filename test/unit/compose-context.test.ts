import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  ContextStoreAdapter,
  ContextStoreFile,
  ContextStoreWriteOptions,
  ContextStoreWriteResult
} from "../../src/adapters/store/context-store.js";
import {
  composeContextFromContextStore,
  composeContextFromStore,
  rankContextFromStore
} from "../../src/core/context/compose-context.js";
import {
  buildRecordIndexes,
  serializePathIndex,
  serializeSymbolIndex,
  serializeTextIndex
} from "../../src/core/indexes/record-index.js";
import { buildEpisodeIndex, serializeEpisodeIndex } from "../../src/core/indexes/episode-index.js";
import { getContextTool, type GetContextServices } from "../../src/mcp/tools/get-context.js";
import type { NormalizedRecord } from "../../src/schemas/normalized-record.js";
import type { RawObservation } from "../../src/schemas/observation.js";
import type { Binding } from "../../src/schemas/types.js";
import { fixtureObservation } from "../fixtures/observation.js";
import { fixtureNormalizedRecord } from "../fixtures/normalized-record.js";

function tempDirectory(): { directory: string; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "teamctx-compose-"));

  return {
    directory,
    cleanup: () => rmSync(directory, { recursive: true, force: true })
  };
}

test("composeContextFromStore returns active scoped context and diagnostics", (context) => {
  const { directory, cleanup } = tempDirectory();
  context.after(cleanup);
  const storeRoot = join(directory, ".teamctx");

  writeRecord(storeRoot, "pitfalls.jsonl", record("pitfall-auth-order", "pitfall", "active"));
  writeRecord(
    storeRoot,
    "pitfalls.jsonl",
    record("pitfall-billing-order", "pitfall", "active", {
      paths: ["src/billing/**"],
      domains: ["billing"],
      symbols: ["BillingMiddleware"],
      tags: ["request-lifecycle"]
    })
  );
  writeRecord(storeRoot, "decisions.jsonl", record("decision-auth-order", "decision", "active"));
  writeRecord(storeRoot, "rules.jsonl", record("rule-auth-order", "rule", "contested"));

  const composed = composeContextFromStore(storeRoot, {
    target_files: ["src/auth/middleware.ts"]
  });

  assert.deepEqual(
    composed.normalized_context.scoped.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      content: entry.content,
      reason: entry.reason
    })),
    [
      {
        id: "pitfall-auth-order",
        kind: "pitfall",
        content: "pitfall-auth-order text",
        reason: "target file match: src/auth/middleware.ts; pitfall context; medium confidence"
      },
      {
        id: "decision-auth-order",
        kind: "decision",
        content: "decision-auth-order text",
        reason: "target file match: src/auth/middleware.ts; decision context; medium confidence"
      }
    ]
  );
  assert.equal(composed.normalized_context.scoped[0]?.rank_score, 123);
  assert.deepEqual(composed.normalized_context.scoped[0]?.rank_reasons, [
    "target file match: src/auth/middleware.ts",
    "pitfall context",
    "medium confidence"
  ]);
  assert.deepEqual(composed.normalized_context.scoped[0]?.scope, {
    paths: ["src/auth/**"],
    domains: ["auth"],
    symbols: ["AuthMiddleware"],
    tags: ["request-lifecycle"]
  });
  assert.deepEqual(composed.normalized_context.active_pitfalls, ["pitfall-auth-order text"]);
  assert.deepEqual(composed.normalized_context.recent_decisions, ["decision-auth-order text"]);
  assert.deepEqual(composed.diagnostics.contested_items, ["rule-auth-order"]);
  assert.deepEqual(composed.diagnostics.excluded_items, [
    {
      id: "rule-auth-order",
      state: "contested",
      reason: "excluded because competing same-scope assertions need human review"
    }
  ]);
});

test("composeContextFromStore uses generated indexes for scoped selection", (context) => {
  const { directory, cleanup } = tempDirectory();
  context.after(cleanup);
  const storeRoot = join(directory, ".teamctx");
  const indexedRecord = record("decision-indexed", "decision", "active", {
    paths: ["src/legacy/**"],
    domains: ["billing"],
    symbols: ["LegacyMiddleware"],
    tags: ["legacy"]
  });

  writeRecord(storeRoot, "decisions.jsonl", indexedRecord);
  writeIndexes(storeRoot, [indexedRecord], "2026-04-22T11:00:00.000Z");

  const pathIndexPath = join(storeRoot, "indexes", "path-index.json");
  const pathIndex = JSON.parse(readFileSync(pathIndexPath, "utf8")) as {
    paths: Record<string, string[]>;
  };
  pathIndex.paths["src/auth/**"] = [indexedRecord.id];
  writeFileSync(pathIndexPath, `${JSON.stringify(pathIndex, null, 2)}\n`, "utf8");

  const composed = composeContextFromStore(storeRoot, {
    target_files: ["src/auth/middleware.ts"]
  });

  assert.deepEqual(
    composed.normalized_context.scoped.map((entry) => entry.content),
    ["decision-indexed text"]
  );
});

test("composeContextFromStore retrieves by domain symbol and tag indexes", (context) => {
  const { directory, cleanup } = tempDirectory();
  context.after(cleanup);
  const storeRoot = join(directory, ".teamctx");
  const domainRecord = record("decision-domain", "decision", "active", {
    paths: [],
    domains: ["auth"],
    symbols: [],
    tags: []
  });
  const symbolRecord = record("pitfall-symbol", "pitfall", "active", {
    paths: [],
    domains: [],
    symbols: ["AuthMiddleware"],
    tags: []
  });
  const tagRecord = record("workflow-tag", "workflow", "active", {
    paths: [],
    domains: [],
    symbols: [],
    tags: ["request-lifecycle"]
  });

  writeRecord(storeRoot, "decisions.jsonl", domainRecord);
  writeRecord(storeRoot, "pitfalls.jsonl", symbolRecord);
  writeRecord(storeRoot, "workflows.jsonl", tagRecord);
  writeIndexes(storeRoot, [domainRecord, symbolRecord, tagRecord], "2026-04-22T11:00:00.000Z");

  const weakSelectorComposed = composeContextFromStore(storeRoot, {
    domains: ["AUTH"],
    tags: ["request-lifecycle"]
  });

  assert.deepEqual(
    weakSelectorComposed.normalized_context.scoped.map((entry) => entry.content),
    ["decision-domain text", "workflow-tag text"]
  );

  const strongSelectorComposed = composeContextFromStore(storeRoot, {
    domains: ["AUTH"],
    symbols: ["AuthMiddleware"],
    tags: ["request-lifecycle"]
  });

  assert.deepEqual(
    strongSelectorComposed.normalized_context.scoped.map((entry) => entry.content),
    ["pitfall-symbol text"]
  );
});

test("composeContextFromStore does not let weak selectors broaden target-file retrieval", (context) => {
  const { directory, cleanup } = tempDirectory();
  context.after(cleanup);
  const storeRoot = join(directory, ".teamctx");
  const pathRecord = record("pitfall-auth", "pitfall", "active");
  const targetOnlyRecord = record("fact-target-only", "fact", "active", {
    paths: ["src/auth/**"],
    domains: [],
    symbols: [],
    tags: []
  });
  const symbolOnlyRecord = record("fact-symbol-only", "fact", "active", {
    paths: ["src/auth/**"],
    domains: ["auth"],
    symbols: ["AuthMiddleware"],
    tags: []
  });
  const taggedFactRecord = record("fact-tagged", "fact", "active", {
    paths: ["src/auth/**"],
    domains: [],
    symbols: [],
    tags: ["request-lifecycle"]
  });
  const domainOnlyRecord = record("decision-auth-domain", "decision", "active", {
    paths: [],
    domains: ["auth"],
    symbols: [],
    tags: []
  });
  const tagOnlyRecord = record("workflow-lifecycle", "workflow", "active", {
    paths: [],
    domains: [],
    symbols: [],
    tags: ["request-lifecycle"]
  });

  writeRecord(storeRoot, "pitfalls.jsonl", pathRecord);
  writeRecord(storeRoot, "facts.jsonl", targetOnlyRecord);
  writeRecord(storeRoot, "facts.jsonl", symbolOnlyRecord);
  writeRecord(storeRoot, "facts.jsonl", taggedFactRecord);
  writeRecord(storeRoot, "decisions.jsonl", domainOnlyRecord);
  writeRecord(storeRoot, "workflows.jsonl", tagOnlyRecord);
  writeIndexes(
    storeRoot,
    [
      pathRecord,
      targetOnlyRecord,
      symbolOnlyRecord,
      taggedFactRecord,
      domainOnlyRecord,
      tagOnlyRecord
    ],
    "2026-04-22T11:00:00.000Z"
  );

  const composed = composeContextFromStore(storeRoot, {
    target_files: ["src/auth/middleware.ts"],
    domains: ["auth"],
    symbols: ["AuthMiddleware"],
    tags: ["request-lifecycle"]
  });

  assert.deepEqual(
    composed.normalized_context.scoped.map((entry) => entry.id),
    ["pitfall-auth", "fact-symbol-only", "fact-tagged"]
  );
  assert.deepEqual(composed.normalized_context.recent_decisions, []);
  assert.deepEqual(composed.normalized_context.applicable_workflows, []);
});

test("composeContextFromStore ignores untokenizable query text for rich selector pruning", (context) => {
  const { directory, cleanup } = tempDirectory();
  context.after(cleanup);
  const storeRoot = join(directory, ".teamctx");
  const pathRecord = record("fact-target-file", "fact", "active", {
    paths: ["src/auth/**"],
    domains: [],
    symbols: [],
    tags: []
  });

  writeRecord(storeRoot, "facts.jsonl", pathRecord);
  writeIndexes(storeRoot, [pathRecord], "2026-04-22T11:00:00.000Z");

  const composed = composeContextFromStore(storeRoot, {
    target_files: ["src/auth/middleware.ts"],
    query: "the and of"
  });

  assert.deepEqual(
    composed.normalized_context.scoped.map((entry) => entry.id),
    ["fact-target-file"]
  );
});

test("composeContextFromStore reports stale index diagnostics", (context) => {
  const { directory, cleanup } = tempDirectory();
  context.after(cleanup);
  const storeRoot = join(directory, ".teamctx");
  const indexedRecord = record("decision-indexed", "decision", "active");

  writeRecord(storeRoot, "decisions.jsonl", indexedRecord);
  writeIndexes(storeRoot, [indexedRecord], "2026-04-22T10:00:00.000Z");
  writeEpisodeIndex(storeRoot, [observation()], "2026-04-22T10:00:00.000Z");
  writeLastNormalize(storeRoot, "2026-04-22T11:00:00.000Z");

  const composed = composeContextFromStore(storeRoot, {
    target_files: ["src/auth/middleware.ts"]
  });

  assert.deepEqual(composed.diagnostics.index_warnings, [
    "path index generated_at 2026-04-22T10:00:00.000Z differs from last normalize 2026-04-22T11:00:00.000Z",
    "symbol index generated_at 2026-04-22T10:00:00.000Z differs from last normalize 2026-04-22T11:00:00.000Z",
    "text index generated_at 2026-04-22T10:00:00.000Z differs from last normalize 2026-04-22T11:00:00.000Z",
    "episode index generated_at 2026-04-22T10:00:00.000Z differs from last normalize 2026-04-22T11:00:00.000Z"
  ]);
});

test("composeContextFromStore retrieves by deterministic full-text query and time filters", (context) => {
  const { directory, cleanup } = tempDirectory();
  context.after(cleanup);
  const storeRoot = join(directory, ".teamctx");
  const matchingRecord = {
    ...record("decision-cache", "decision", "active", {
      paths: [],
      domains: [],
      symbols: [],
      tags: []
    }),
    text: "Cache tokens must expire after tenant migration."
  } satisfies NormalizedRecord;
  const olderRecord = {
    ...record("decision-cache-old", "decision", "active", {
      paths: [],
      domains: [],
      symbols: [],
      tags: []
    }),
    text: "Cache tokens must expire after tenant migration.",
    last_verified_at: "2026-04-21T11:00:00.000Z"
  } satisfies NormalizedRecord;
  const unrelatedRecord = {
    ...record("decision-tenant", "decision", "active", {
      paths: [],
      domains: [],
      symbols: [],
      tags: []
    }),
    text: "Tenant routing must use region pinning."
  } satisfies NormalizedRecord;

  writeRecord(storeRoot, "decisions.jsonl", matchingRecord);
  writeRecord(storeRoot, "decisions.jsonl", olderRecord);
  writeRecord(storeRoot, "decisions.jsonl", unrelatedRecord);
  writeIndexes(
    storeRoot,
    [matchingRecord, olderRecord, unrelatedRecord],
    "2026-04-22T11:00:00.000Z"
  );

  const composed = composeContextFromStore(storeRoot, {
    query: "cache tokens",
    since: "2026-04-22T00:00:00.000Z"
  });

  assert.deepEqual(
    composed.normalized_context.scoped.map((entry) => entry.id),
    ["decision-cache"]
  );
});

test("composeContextFromContextStore uses indexes to avoid unrelated remote shards", async () => {
  const store = new MemoryContextStore();
  const matchingPitfall = record("pitfall-auth", "pitfall", "active");
  const globalRule = record("rule-global", "rule", "active", {
    paths: [],
    domains: [],
    symbols: [],
    tags: []
  });
  const unrelatedRule = record("rule-billing", "rule", "active", {
    paths: ["src/billing/**"],
    domains: ["billing"],
    symbols: ["BillingRule"],
    tags: []
  });
  const unrelatedWorkflow = record("workflow-billing", "workflow", "active", {
    paths: ["src/billing/**"],
    domains: ["billing"],
    symbols: ["BillingWorkflow"],
    tags: []
  });
  const contestedDecision = record("decision-contested", "decision", "contested", {
    paths: ["src/billing/**"],
    domains: ["billing"],
    symbols: ["BillingDecision"],
    tags: []
  });

  await writeRemoteRecord(store, "pitfalls.jsonl", matchingPitfall);
  await writeRemoteRecord(store, "rules.jsonl", globalRule);
  await writeRemoteRecord(store, "rules.jsonl", unrelatedRule);
  await writeRemoteRecord(store, "workflows.jsonl", unrelatedWorkflow);
  await writeRemoteRecord(store, "decisions.jsonl", contestedDecision);
  await writeRemoteIndexes(
    store,
    [matchingPitfall, globalRule, unrelatedRule, unrelatedWorkflow, contestedDecision],
    "2026-04-22T11:00:00.000Z"
  );

  const composed = await composeContextFromContextStore(store, {
    target_files: ["src/auth/middleware.ts"]
  });

  assert.deepEqual(
    composed.normalized_context.scoped.map((entry) => entry.id),
    ["pitfall-auth"]
  );
  assert.deepEqual(composed.normalized_context.active_pitfalls, ["pitfall-auth text"]);
  assert.deepEqual(composed.normalized_context.must_follow_rules, ["rule-global text"]);
  assert.deepEqual(composed.normalized_context.applicable_workflows, []);
  assert.deepEqual(composed.diagnostics.contested_items, ["decision-contested"]);
  assert.deepEqual(composed.diagnostics.excluded_items, [
    {
      id: "decision-contested",
      state: "contested",
      reason: "excluded because competing same-scope assertions need human review"
    }
  ]);
  assert.ok(store.readPaths.includes("normalized/pitfalls.jsonl"));
  assert.ok(store.readPaths.includes("normalized/rules.jsonl"));
  assert.equal(store.readPaths.includes("normalized/decisions.jsonl"), false);
  assert.equal(store.readPaths.includes("normalized/workflows.jsonl"), false);
});

test("composeContextFromStore returns canonical doc refs for scoped docs evidence", (context) => {
  const { directory, cleanup } = tempDirectory();
  context.after(cleanup);
  const storeRoot = join(directory, ".teamctx");
  const docsRecord = {
    ...record("rule-docs", "rule", "active"),
    evidence: [
      {
        kind: "docs",
        repo: "github.com/team/service",
        commit: "abc123",
        file: "docs/auth-runbook.md",
        lines: [4, 12],
        doc_role: "runbook"
      }
    ]
  } satisfies NormalizedRecord;

  writeRecord(storeRoot, "rules.jsonl", docsRecord);
  writeIndexes(storeRoot, [docsRecord], "2026-04-22T11:00:00.000Z");

  const composed = composeContextFromStore(storeRoot, {
    target_files: ["src/auth/middleware.ts"]
  });

  assert.deepEqual(composed.canonical_doc_refs, [
    {
      repo: "github.com/team/service",
      path: "docs/auth-runbook.md",
      commit: "abc123",
      item_id: "rule-docs",
      reason: "scope_match",
      fetch_url: "https://raw.githubusercontent.com/team/service/abc123/docs/auth-runbook.md",
      doc_role: "runbook",
      lines: [4, 12]
    }
  ]);
});

test("composeContextFromStore omits fetch_url for non-github canonical docs", (context) => {
  const { directory, cleanup } = tempDirectory();
  context.after(cleanup);
  const storeRoot = join(directory, ".teamctx");
  const docsRecord = {
    ...record("rule-docs-gitlab", "rule", "active"),
    evidence: [
      {
        kind: "docs",
        repo: "gitlab.com/team/service",
        commit: "def456",
        file: "docs/auth-runbook.md",
        doc_role: "runbook",
        url: "https://gitlab.com/team/service/-/blob/def456/docs/auth-runbook.md"
      }
    ]
  } satisfies NormalizedRecord;

  writeRecord(storeRoot, "rules.jsonl", docsRecord);
  writeIndexes(storeRoot, [docsRecord], "2026-04-22T11:00:00.000Z");

  const composed = composeContextFromStore(storeRoot, {
    target_files: ["src/auth/middleware.ts"]
  });

  assert.deepEqual(composed.canonical_doc_refs, [
    {
      repo: "gitlab.com/team/service",
      path: "docs/auth-runbook.md",
      commit: "def456",
      item_id: "rule-docs-gitlab",
      reason: "scope_match",
      doc_role: "runbook",
      url: "https://gitlab.com/team/service/-/blob/def456/docs/auth-runbook.md"
    }
  ]);
});

test("composeContextFromStore sorts canonical doc refs deterministically", (context) => {
  const { directory, cleanup } = tempDirectory();
  context.after(cleanup);
  const storeRoot = join(directory, ".teamctx");

  const ruleA = {
    ...record("rule-z", "rule", "active"),
    evidence: [
      {
        kind: "docs",
        repo: "github.com/team/service",
        commit: "abc",
        file: "docs/zeta.md",
        doc_role: "runbook"
      }
    ]
  } satisfies NormalizedRecord;
  const ruleB = {
    ...record("rule-a", "rule", "active"),
    evidence: [
      {
        kind: "docs",
        repo: "github.com/team/service",
        commit: "abc",
        file: "docs/alpha.md",
        doc_role: "runbook"
      }
    ]
  } satisfies NormalizedRecord;

  writeRecord(storeRoot, "rules.jsonl", ruleA);
  writeRecord(storeRoot, "rules.jsonl", ruleB);
  writeIndexes(storeRoot, [ruleA, ruleB], "2026-04-22T11:00:00.000Z");

  const composed = composeContextFromStore(storeRoot, {
    target_files: ["src/auth/middleware.ts"]
  });

  assert.deepEqual(
    composed.canonical_doc_refs.map((ref) => ref.path),
    ["docs/alpha.md", "docs/zeta.md"]
  );
});

test("composeContextFromStore returns relevant episode references from the episode index", (context) => {
  const { directory, cleanup } = tempDirectory();
  context.after(cleanup);
  const storeRoot = join(directory, ".teamctx");

  writeEpisodeIndex(storeRoot, [observation()], "2026-04-22T11:00:00.000Z");

  const composed = composeContextFromStore(storeRoot, {
    target_files: ["src/auth/middleware.ts"]
  });

  assert.deepEqual(
    composed.relevant_episodes.map((episode) => ({
      source_event_ids: episode.source_event_ids,
      summary: episode.summary,
      trust: episode.trust,
      source_type: episode.source_type,
      reason: episode.reason,
      selection_reasons: episode.selection_reasons
    })),
    [
      {
        source_event_ids: ["event-1"],
        summary: "Auth middleware must run before tenant resolution.",
        trust: "verified",
        source_type: "inferred_from_code",
        reason: "target file match: src/auth/middleware.ts",
        selection_reasons: ["target file match: src/auth/middleware.ts"]
      }
    ]
  );
});

test("composeContextFromStore filters relevant episodes by source evidence and time", (context) => {
  const { directory, cleanup } = tempDirectory();
  context.after(cleanup);
  const storeRoot = join(directory, ".teamctx");

  writeEpisodeIndex(
    storeRoot,
    [
      observation(),
      observation({
        event_id: "event-2",
        observed_at: "2026-04-20T10:00:00.000Z",
        source_type: "inferred_from_diff",
        evidence: [
          {
            kind: "code",
            repo: "github.com/team/service",
            commit: "abc123",
            file: "src/auth/legacy.ts"
          }
        ]
      })
    ],
    "2026-04-22T11:00:00.000Z"
  );

  const composed = composeContextFromStore(storeRoot, {
    source_types: ["inferred_from_code"],
    evidence_files: ["src/auth/middleware.ts"],
    since: "2026-04-22T00:00:00.000Z"
  });

  assert.deepEqual(
    composed.relevant_episodes.map((episode) => episode.source_event_ids[0]),
    ["event-1"]
  );
  assert.deepEqual(composed.relevant_episodes[0]?.selection_reasons, [
    "source_type match: inferred_from_code",
    "evidence file match: src/auth/middleware.ts",
    "time window match: since 2026-04-22T00:00:00.000Z"
  ]);
});

test("composeContextFromStore ranks categories and reports budget overflow", (context) => {
  const { directory, cleanup } = tempDirectory();
  context.after(cleanup);
  const storeRoot = join(directory, ".teamctx");

  writeRecord(storeRoot, "rules.jsonl", record("rule-auth", "rule", "active"));
  writeRecord(storeRoot, "glossary.jsonl", record("glossary-auth", "glossary", "active"));

  for (let index = 0; index < 21; index += 1) {
    writeRecord(
      storeRoot,
      "pitfalls.jsonl",
      record(`pitfall-${String(index).padStart(2, "0")}`, "pitfall", "active")
    );
  }

  const composed = composeContextFromStore(storeRoot, {
    target_files: ["src/auth/middleware.ts"]
  });

  assert.deepEqual(composed.normalized_context.must_follow_rules, ["rule-auth text"]);
  assert.deepEqual(composed.normalized_context.glossary_terms, ["glossary-auth text"]);
  assert.equal(composed.normalized_context.scoped.length, 20);
  assert.equal(composed.normalized_context.scoped[0]?.id, "rule-auth");
  assert.deepEqual(composed.diagnostics.dropped_items, [
    "budget:glossary-auth",
    "budget:pitfall-19",
    "budget:pitfall-20"
  ]);
});

test("composeContextFromStore honors project.yaml context_budgets overrides", (context) => {
  const { directory, cleanup } = tempDirectory();
  context.after(cleanup);
  const storeRoot = join(directory, ".teamctx");

  for (let index = 0; index < 5; index += 1) {
    writeRecord(
      storeRoot,
      "pitfalls.jsonl",
      record(`pitfall-${String(index).padStart(2, "0")}`, "pitfall", "active")
    );
  }

  writeFileSync(
    join(storeRoot, "project.yaml"),
    [
      "format_version: 1",
      'project_id: "test"',
      'normalizer_version: "0.1.0"',
      "retention:",
      "  raw_candidate_days: 30",
      "  audit_days: 180",
      '  archive_path: "archive/"',
      "context_budgets:",
      "  pitfalls: 2",
      "  scoped_items: 3",
      ""
    ].join("\n"),
    "utf8"
  );

  const composed = composeContextFromStore(storeRoot, {
    target_files: ["src/auth/middleware.ts"]
  });

  assert.equal(composed.normalized_context.active_pitfalls.length, 2);
  assert.equal(composed.normalized_context.scoped.length, 3);

  const overflowReasons = composed.diagnostics.budget_rejected.map(
    (entry) => entry.exclusion_reason
  );
  assert.ok(
    overflowReasons.some((reason) => reason === "budget_overflow:pitfall"),
    `expected pitfall overflow under tighter budget (got: ${overflowReasons.join(", ")})`
  );
});

test("composeContextFromStore reports budget_rejected with rank scores for overflow records", (context) => {
  const { directory, cleanup } = tempDirectory();
  context.after(cleanup);
  const storeRoot = join(directory, ".teamctx");

  for (let index = 0; index < 12; index += 1) {
    writeRecord(
      storeRoot,
      "pitfalls.jsonl",
      record(`pitfall-${String(index).padStart(2, "0")}`, "pitfall", "active")
    );
  }

  const composed = composeContextFromStore(storeRoot, {
    target_files: ["src/auth/middleware.ts"]
  });

  const rejected = composed.diagnostics.budget_rejected;
  assert.ok(rejected.length > 0, "expected budget_rejected to have entries");

  for (const entry of rejected) {
    assert.ok(typeof entry.id === "string", "rejected entry must have id");
    assert.ok(typeof entry.kind === "string", "rejected entry must have kind");
    assert.ok(typeof entry.rank_score === "number", "rejected entry must have rank_score");
    assert.ok(Array.isArray(entry.rank_reasons), "rejected entry must have rank_reasons");
    assert.ok(
      entry.exclusion_reason.startsWith("budget_overflow:"),
      "exclusion_reason must start with budget_overflow:"
    );
  }

  const rejectedIds = rejected.map((entry) => entry.id);

  assert.ok(
    rejectedIds.includes("pitfall-10") || rejectedIds.includes("pitfall-11"),
    "overflow pitfalls should appear in budget_rejected"
  );

  for (let index = 0; index < rejected.length - 1; index += 1) {
    const current = rejected[index];
    const next = rejected[index + 1];
    assert.ok(
      current !== undefined && next !== undefined && current.rank_score >= next.rank_score,
      "budget_rejected should be sorted by rank_score descending"
    );
  }
});

test("composeContextFromStore reports global budget overflow diagnostics", (context) => {
  const { directory, cleanup } = tempDirectory();
  context.after(cleanup);
  const storeRoot = join(directory, ".teamctx");

  for (let index = 0; index < 22; index += 1) {
    writeRecord(
      storeRoot,
      "facts.jsonl",
      record(`fact-global-${String(index).padStart(2, "0")}`, "fact", "active", {
        paths: [],
        domains: [],
        symbols: [],
        tags: []
      })
    );
  }

  const composed = composeContextFromStore(storeRoot, {});

  assert.equal(composed.normalized_context.global.split("\n").length, 20);
  assert.ok(composed.diagnostics.dropped_items.includes("budget:fact-global-20"));
  assert.ok(composed.diagnostics.dropped_items.includes("budget:fact-global-21"));
  assert.deepEqual(
    composed.diagnostics.budget_rejected
      .filter((entry) => entry.exclusion_reason === "budget_overflow:global")
      .map((entry) => entry.id),
    ["fact-global-20", "fact-global-21"]
  );

  const trace = rankContextFromStore(storeRoot, {});
  assert.equal(
    trace.entries.find((entry) => entry.id === "fact-global-20")?.exclusion_reason,
    "budget_overflow:global"
  );
});

test("composeContextFromStore caps payload size under large stores at default budgets", (context) => {
  const { directory, cleanup } = tempDirectory();
  context.after(cleanup);
  const storeRoot = join(directory, ".teamctx");
  const longText = `${"alpha bravo charlie delta echo foxtrot golf hotel ".repeat(60)}end`;
  const seed: Array<{ file: string; kind: NormalizedRecord["kind"]; count: number }> = [
    { file: "rules.jsonl", kind: "rule", count: 200 },
    { file: "pitfalls.jsonl", kind: "pitfall", count: 200 },
    { file: "decisions.jsonl", kind: "decision", count: 200 },
    { file: "workflows.jsonl", kind: "workflow", count: 200 },
    { file: "glossary.jsonl", kind: "glossary", count: 200 },
    { file: "facts.jsonl", kind: "fact", count: 200 }
  ];

  for (const entry of seed) {
    for (let index = 0; index < entry.count; index += 1) {
      const seededRecord = record(
        `${entry.kind}-${String(index).padStart(3, "0")}`,
        entry.kind,
        "active"
      );

      writeRecord(storeRoot, entry.file, { ...seededRecord, text: longText });
    }
  }

  const composed = composeContextFromStore(storeRoot, {
    target_files: ["src/auth/middleware.ts"]
  });

  assert.ok(
    composed.normalized_context.scoped.length <= 20,
    `scoped entries (${composed.normalized_context.scoped.length}) must stay within scopedItems budget`
  );

  const expectedCategoryCaps: Array<{ key: string; list: string[]; cap: number }> = [
    { key: "must_follow_rules", list: composed.normalized_context.must_follow_rules, cap: 20 },
    { key: "active_pitfalls", list: composed.normalized_context.active_pitfalls, cap: 10 },
    { key: "recent_decisions", list: composed.normalized_context.recent_decisions, cap: 10 },
    {
      key: "applicable_workflows",
      list: composed.normalized_context.applicable_workflows,
      cap: 10
    },
    { key: "glossary_terms", list: composed.normalized_context.glossary_terms, cap: 10 }
  ];

  for (const { key, list, cap } of expectedCategoryCaps) {
    assert.ok(list.length <= cap, `${key} category (${list.length}) must not exceed budget ${cap}`);
  }

  for (const entry of composed.normalized_context.scoped) {
    assert.ok(
      entry.content.length <= longText.length,
      `scoped content (${entry.content.length}) should be bounded`
    );
    assert.ok(
      entry.content.length < longText.length,
      "scoped content should be truncated below the original long text"
    );
  }

  for (const { list } of expectedCategoryCaps) {
    for (const text of list) {
      assert.ok(
        text.length < longText.length,
        "category text must be token-budgeted, not raw record text"
      );
    }
  }
});

test("getContextTool composes normalized records for same-repository stores", (context) => {
  const { directory, cleanup } = tempDirectory();
  context.after(cleanup);
  const storeRoot = join(directory, ".teamctx");
  writeRecord(storeRoot, "workflows.jsonl", record("workflow-test", "workflow", "active"));

  const binding: Binding = {
    repo: "github.com/team/service",
    root: directory,
    contextStore: {
      provider: "github",
      repo: "github.com/team/service",
      path: ".teamctx"
    },
    createdAt: "2026-04-22T10:00:00.000Z"
  };
  const services: GetContextServices = {
    getRepoRoot: () => directory,
    getOriginRemote: () => "git@github.com:team/service.git",
    getCurrentBranch: () => "main",
    getHeadCommit: () => "abc123",
    findBinding: () => binding
  };
  const result = getContextTool({ changed_files: ["src/auth/middleware.ts"] }, services);

  assert.equal(result.enabled, true);

  if (!result.enabled) {
    throw new Error("expected enabled context");
  }

  assert.deepEqual(result.normalized_context.applicable_workflows, ["workflow-test text"]);
  assert.deepEqual(
    result.normalized_context.scoped.map((entry) => entry.content),
    ["workflow-test text"]
  );
});

test("rankContextFromStore returns full ranked list with in_context and exclusion annotations", (context) => {
  const { directory, cleanup } = tempDirectory();
  context.after(cleanup);
  const storeRoot = join(directory, ".teamctx");

  writeRecord(storeRoot, "rules.jsonl", record("rule-in-scope", "rule", "active"));
  writeRecord(
    storeRoot,
    "pitfalls.jsonl",
    record("pitfall-out-scope", "pitfall", "active", {
      paths: ["src/billing/**"],
      domains: ["billing"],
      symbols: [],
      tags: []
    })
  );
  writeRecord(storeRoot, "decisions.jsonl", record("decision-contested", "decision", "contested"));

  const trace = rankContextFromStore(storeRoot, {
    target_files: ["src/auth/middleware.ts"],
    domains: ["auth"]
  });

  assert.equal(trace.total_records, 3);
  assert.equal(trace.active_records, 2);

  const inContextEntry = trace.entries.find((e) => e.id === "rule-in-scope");
  const outScopeEntry = trace.entries.find((e) => e.id === "pitfall-out-scope");
  const excludedEntry = trace.entries.find((e) => e.id === "decision-contested");

  assert.ok(inContextEntry, "rule-in-scope should appear in trace");
  assert.ok(inContextEntry?.in_context, "rule-in-scope should be in_context");
  assert.ok(inContextEntry?.rank_score > 0, "rule-in-scope should have positive rank score");
  assert.ok(Array.isArray(inContextEntry?.rank_reasons), "rank_reasons should be an array");

  assert.ok(outScopeEntry, "pitfall-out-scope should appear in trace");
  assert.equal(outScopeEntry?.in_context, false, "pitfall-out-scope should not be in_context");
  assert.equal(outScopeEntry?.exclusion_reason, "scope_not_matched");

  assert.ok(excludedEntry, "decision-contested should appear in trace");
  assert.equal(excludedEntry?.in_context, false);
  assert.equal(excludedEntry?.exclusion_reason, "state_excluded:contested");
  assert.equal(excludedEntry?.rank_score, 0);
});

test("rankContextFromStore sorts in_context entries before non-in_context, then by score descending", (context) => {
  const { directory, cleanup } = tempDirectory();
  context.after(cleanup);
  const storeRoot = join(directory, ".teamctx");

  writeRecord(storeRoot, "rules.jsonl", record("rule-in-scope", "rule", "active"));
  writeRecord(storeRoot, "facts.jsonl", record("fact-in-scope", "fact", "active"));
  writeRecord(
    storeRoot,
    "pitfalls.jsonl",
    record("pitfall-no-scope", "pitfall", "active", {
      paths: [],
      domains: [],
      symbols: [],
      tags: []
    })
  );

  const trace = rankContextFromStore(storeRoot, {
    target_files: ["src/auth/middleware.ts"]
  });

  const inContextEntries = trace.entries.filter((e) => e.in_context);
  const outContextEntries = trace.entries.filter((e) => !e.in_context && e.state === "active");

  assert.ok(inContextEntries.length > 0, "should have in-context entries");

  for (let i = 1; i < inContextEntries.length; i++) {
    assert.ok(
      (inContextEntries[i - 1]?.rank_score ?? 0) >= (inContextEntries[i]?.rank_score ?? 0),
      "in-context entries should be sorted by score descending"
    );
  }

  const lastInContextIndex = trace.entries.findIndex((e) => !e.in_context);
  const firstOutIndex = inContextEntries.length;
  assert.equal(
    lastInContextIndex,
    firstOutIndex,
    "all in_context entries should come before non-in_context entries"
  );
  assert.ok(outContextEntries.length >= 0);
});

function writeRecord(storeRoot: string, file: string, normalizedRecord: NormalizedRecord): void {
  const directory = join(storeRoot, "normalized");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, file), `${JSON.stringify(normalizedRecord)}\n`, { flag: "a" });
}

function writeIndexes(storeRoot: string, records: NormalizedRecord[], generatedAt: string): void {
  const indexes = buildRecordIndexes(records, generatedAt);
  const directory = join(storeRoot, "indexes");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "path-index.json"), serializePathIndex(indexes.pathIndex), "utf8");
  writeFileSync(
    join(directory, "symbol-index.json"),
    serializeSymbolIndex(indexes.symbolIndex),
    "utf8"
  );
  writeFileSync(join(directory, "text-index.json"), serializeTextIndex(indexes.textIndex), "utf8");
}

function writeEpisodeIndex(
  storeRoot: string,
  observations: RawObservation[],
  generatedAt: string
): void {
  const directory = join(storeRoot, "indexes");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "episode-index.json"),
    serializeEpisodeIndex(buildEpisodeIndex(observations, generatedAt)),
    "utf8"
  );
}

function writeLastNormalize(storeRoot: string, normalizedAt: string): void {
  const directory = join(storeRoot, "indexes");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "last-normalize.json"),
    `${JSON.stringify(
      {
        normalizedAt,
        rawEventsRead: 1,
        recordsWritten: 1,
        droppedEvents: 0,
        auditEntriesWritten: 1
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

async function writeRemoteRecord(
  store: MemoryContextStore,
  file: string,
  normalizedRecord: NormalizedRecord
): Promise<void> {
  await store.appendJsonl(`normalized/${file}`, [normalizedRecord], {
    message: "seed"
  });
}

async function writeRemoteIndexes(
  store: MemoryContextStore,
  records: NormalizedRecord[],
  generatedAt: string
): Promise<void> {
  const indexes = buildRecordIndexes(records, generatedAt);
  await store.writeText("indexes/path-index.json", serializePathIndex(indexes.pathIndex), {
    message: "seed path index"
  });
  await store.writeText("indexes/symbol-index.json", serializeSymbolIndex(indexes.symbolIndex), {
    message: "seed symbol index"
  });
  await store.writeText("indexes/text-index.json", serializeTextIndex(indexes.textIndex), {
    message: "seed text index"
  });
}

function record(
  id: string,
  kind: NormalizedRecord["kind"],
  state: NormalizedRecord["state"],
  scope: NormalizedRecord["scope"] = {
    paths: ["src/auth/**"],
    domains: ["auth"],
    symbols: ["AuthMiddleware"],
    tags: ["request-lifecycle"]
  }
): NormalizedRecord {
  return fixtureNormalizedRecord({
    id,
    kind,
    state,
    text: `${id} text`,
    scope
  });
}

function observation(overrides: Partial<RawObservation> = {}): RawObservation {
  return fixtureObservation({ evidenceLines: false, ...overrides });
}

class MemoryContextStore implements ContextStoreAdapter {
  readonly readPaths: string[] = [];
  private readonly files = new Map<string, string>();

  async getRevision(): Promise<string | null> {
    return "memory-head";
  }

  async readText(path: string): Promise<ContextStoreFile | undefined> {
    this.readPaths.push(path);
    const content = this.files.get(path);

    if (content === undefined) {
      return undefined;
    }

    return { path, content, revision: null };
  }

  async writeText(
    path: string,
    content: string,
    _options: ContextStoreWriteOptions
  ): Promise<ContextStoreWriteResult> {
    this.files.set(path, content);

    return { path, revision: null, storeRevision: "memory-head" };
  }

  async deleteText(
    path: string,
    _options: ContextStoreWriteOptions
  ): Promise<ContextStoreWriteResult> {
    this.files.delete(path);

    return { path, revision: null, storeRevision: "memory-head" };
  }

  async appendJsonl(
    path: string,
    rows: unknown[],
    options: ContextStoreWriteOptions
  ): Promise<ContextStoreWriteResult> {
    const current = this.files.get(path) ?? "";

    return this.writeText(
      path,
      `${current}${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
      options
    );
  }

  async listFiles(path: string): Promise<string[]> {
    return [...this.files.keys()].filter((file) => file.startsWith(path)).sort();
  }
}
