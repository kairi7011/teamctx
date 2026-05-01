import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { explainContextQueryFromStore } from "../../src/core/context/query-explain.js";
import {
  buildRecordIndexes,
  serializePathIndex,
  serializeSymbolIndex,
  serializeTextIndex
} from "../../src/core/indexes/record-index.js";
import type { NormalizedRecord } from "../../src/schemas/normalized-record.js";
import { fixtureNormalizedRecord } from "../fixtures/normalized-record.js";

test("explainContextQueryFromStore reports indexed normalized shard reads", (context) => {
  const { directory, cleanup } = tempDirectory();
  context.after(cleanup);
  const storeRoot = join(directory, ".teamctx");
  const generatedAt = "2026-04-29T00:00:00.000Z";
  const records = [
    record("rule-auth", "rule", ["src/auth.ts"], ["auth"]),
    record("workflow-auth", "workflow", ["src/auth.ts"], ["auth"]),
    record("pitfall-billing", "pitfall", ["src/billing.ts"], ["billing"])
  ];

  writeIndexes(storeRoot, records, generatedAt);

  const explain = explainContextQueryFromStore(storeRoot, {
    target_files: ["src/auth.ts"],
    domains: ["auth"]
  });

  assert.equal(explain.read_plan.mode, "indexed_normalized_shards");
  assert.deepEqual(explain.read_plan.selected_record_ids, ["rule-auth", "workflow-auth"]);
  assert.deepEqual(explain.read_plan.normalized_files, [
    "facts.jsonl",
    "rules.jsonl",
    "workflows.jsonl",
    "glossary.jsonl"
  ]);
  assert.equal(explain.indexes.path_index.used, true);
  assert.equal(explain.indexes.symbol_index.used, false);
  assert.deepEqual(explain.indexes.warnings, []);
});

test("explainContextQueryFromStore reports full scans when query index is missing", (context) => {
  const { directory, cleanup } = tempDirectory();
  context.after(cleanup);
  const storeRoot = join(directory, ".teamctx");

  const explain = explainContextQueryFromStore(storeRoot, { query: "auth workflow" });

  assert.equal(explain.read_plan.mode, "full_normalized_scan");
  assert.equal(explain.read_plan.reason, "path index is missing or not generated");
  assert.deepEqual(explain.read_plan.normalized_files, [
    "facts.jsonl",
    "rules.jsonl",
    "pitfalls.jsonl",
    "decisions.jsonl",
    "workflows.jsonl",
    "glossary.jsonl"
  ]);
  assert.deepEqual(explain.read_plan.selected_record_ids, []);
  assert.equal(explain.indexes.path_index.present, false);
});

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
  writeFileSync(
    join(directory, "last-normalize.json"),
    `${JSON.stringify({ normalizedAt: generatedAt })}\n`,
    "utf8"
  );
}

function record(
  id: string,
  kind: NormalizedRecord["kind"],
  paths: string[],
  domains: string[]
): NormalizedRecord {
  return fixtureNormalizedRecord({
    id,
    kind,
    text: `${id} context text`,
    scope: {
      paths,
      domains,
      symbols: [],
      tags: []
    },
    evidence: [
      {
        kind: "code",
        repo: "github.com/team/service",
        commit: "abc123",
        file: paths[0] ?? "src/index.ts"
      }
    ],
    provenance: {
      session_id: "test-session",
      observed_at: "2026-04-29T00:00:00.000Z",
      recorded_by: "test"
    },
    last_verified_at: "2026-04-29T00:00:00.000Z"
  });
}

function tempDirectory(): { directory: string; cleanup: () => void } {
  const directory = join(tmpdir(), `teamctx-query-explain-${Date.now()}-${Math.random()}`);
  mkdirSync(directory, { recursive: true });

  return {
    directory,
    cleanup: () => rmSync(directory, { recursive: true, force: true })
  };
}
