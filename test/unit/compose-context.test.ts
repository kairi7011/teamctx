import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { composeContextFromStore } from "../../src/core/context/compose-context.js";
import {
  buildRecordIndexes,
  serializePathIndex,
  serializeSymbolIndex
} from "../../src/core/indexes/record-index.js";
import { getContextTool, type GetContextServices } from "../../src/mcp/tools/get-context.js";
import type { NormalizedRecord } from "../../src/schemas/normalized-record.js";
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

  assert.deepEqual(composed.normalized_context.scoped, [
    {
      scope: {
        paths: ["src/auth/**"],
        domains: ["auth"],
        symbols: ["AuthMiddleware"],
        tags: ["request-lifecycle"]
      },
      content: "decision-auth-order text"
    },
    {
      scope: {
        paths: ["src/auth/**"],
        domains: ["auth"],
        symbols: ["AuthMiddleware"],
        tags: ["request-lifecycle"]
      },
      content: "pitfall-auth-order text"
    }
  ]);
  assert.deepEqual(composed.normalized_context.active_pitfalls, ["pitfall-auth-order text"]);
  assert.deepEqual(composed.normalized_context.recent_decisions, ["decision-auth-order text"]);
  assert.deepEqual(composed.diagnostics.contested_items, ["rule-auth-order"]);
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
    ["decision-domain text", "pitfall-symbol text", "workflow-tag text"]
  );
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
