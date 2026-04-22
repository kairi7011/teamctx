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
  composeContextFromStore
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
        reason: "target file match; pitfall context; medium confidence"
      },
      {
        id: "decision-auth-order",
        kind: "decision",
        content: "decision-auth-order text",
        reason: "target file match; decision context; medium confidence"
      }
    ]
  );
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

  const composed = composeContextFromStore(storeRoot, {
    domains: ["AUTH"],
    symbols: ["AuthMiddleware"],
    tags: ["request-lifecycle"]
  });

  assert.deepEqual(
    composed.normalized_context.scoped.map((entry) => entry.content),
    ["pitfall-symbol text", "decision-domain text", "workflow-tag text"]
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
  await writeRemoteRecord(store, "workflows.jsonl", unrelatedWorkflow);
  await writeRemoteRecord(store, "decisions.jsonl", contestedDecision);
  await writeRemoteIndexes(
    store,
    [matchingPitfall, globalRule, unrelatedWorkflow, contestedDecision],
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
      doc_role: "runbook",
      lines: [4, 12]
    }
  ]);
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
      source_type: episode.source_type
    })),
    [
      {
        source_event_ids: ["event-1"],
        summary: "Auth middleware must run before tenant resolution.",
        trust: "verified",
        source_type: "inferred_from_code"
      }
    ]
  );
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
  await store.writeText(`normalized/${file}`, `${JSON.stringify(normalizedRecord)}\n`, {
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
  return {
    id,
    schema_version: 1,
    normalizer_version: "0.1.0",
    kind,
    state,
    text: `${id} text`,
    scope,
    evidence: [
      {
        kind: "code",
        repo: "github.com/team/service",
        commit: "abc123",
        file: "src/auth/middleware.ts"
      }
    ],
    provenance: {
      recorded_by: "codex",
      session_id: "session-1",
      observed_at: "2026-04-22T10:00:00.000Z"
    },
    confidence_level: "medium",
    confidence_score: 0.65,
    last_verified_at: "2026-04-22T11:00:00.000Z",
    supersedes: [],
    conflicts_with: []
  };
}

function observation(): RawObservation {
  return {
    schema_version: 1,
    event_id: "event-1",
    session_id: "session-1",
    observed_at: "2026-04-22T10:00:00.000Z",
    recorded_by: "codex",
    trust: "verified",
    kind: "pitfall",
    text: "Auth middleware must run before tenant resolution.",
    source_type: "inferred_from_code",
    evidence: [
      {
        kind: "code",
        repo: "github.com/team/service",
        commit: "abc123",
        file: "src/auth/middleware.ts"
      }
    ],
    scope: {
      paths: ["src/auth/**"],
      domains: ["auth"],
      symbols: ["AuthMiddleware"],
      tags: ["request-lifecycle"]
    },
    supersedes: []
  };
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
