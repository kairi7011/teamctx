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

test("explainContextQueryFromStore reports inferred and effective selectors", (context) => {
  const { directory, cleanup } = tempDirectory();
  context.after(cleanup);
  const storeRoot = join(directory, ".teamctx");
  const workflow = record("workflow-cli", "workflow", ["src/cli/index.ts"], ["context-preview"]);
  const fact = record("fact-cli-args", "fact", ["src/cli/cli-args.ts"], ["cli"]);

  writeIndexes(storeRoot, [workflow, fact], "2026-04-29T00:00:00.000Z");

  const explain = explainContextQueryFromStore(storeRoot, {
    domains: ["cli"],
    query:
      "Inspect src/cli/index.ts teamctx contextInput and src/cli/cli-args.ts selector flag parsing"
  });

  assert.deepEqual(explain.selectors.target_files, []);
  assert.deepEqual(explain.selectors.domains, ["cli"]);
  assert.deepEqual(explain.inferred_selectors.target_files, [
    "src/cli/index.ts",
    "src/cli/cli-args.ts"
  ]);
  assert.deepEqual(explain.inferred_selectors.symbols, ["contextInput"]);
  assert.deepEqual(explain.inferred_selectors.domains, ["context-preview"]);
  assert.deepEqual(explain.inferred_selectors.tags, [
    "get-context",
    "preview-cli",
    "selector-parsing"
  ]);
  assert.deepEqual(explain.effective_selectors.target_files, [
    "src/cli/index.ts",
    "src/cli/cli-args.ts"
  ]);
  assert.deepEqual(explain.effective_selectors.domains, ["cli", "context-preview"]);
  assert.deepEqual(explain.read_plan.selected_record_ids, ["fact-cli-args", "workflow-cli"]);
});

test("explainContextQueryFromStore reports project query aliases", (context) => {
  const { directory, cleanup } = tempDirectory();
  context.after(cleanup);
  const storeRoot = join(directory, ".teamctx");
  const workflow = record("workflow-release-handoff", "workflow", ["docs/release.md"], ["release"]);

  writeIndexes(storeRoot, [workflow], "2026-04-29T00:00:00.000Z");
  writeQueryAliases(storeRoot, {
    schema_version: 1,
    aliases: [
      {
        id: "release-handoff",
        match: { patterns: ["ship it"] },
        expand: { token_groups: [["release", "handoff"]] }
      }
    ]
  });

  const explain = explainContextQueryFromStore(storeRoot, { query: "ship it" });

  assert.deepEqual(explain.query_expansion.matched_aliases, ["project:release-handoff"]);
  assert.deepEqual(explain.query_expansion.token_groups, [["handoff", "release"]]);
  assert.deepEqual(explain.read_plan.selected_record_ids, ["workflow-release-handoff"]);
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

function writeQueryAliases(storeRoot: string, content: unknown): void {
  const directory = join(storeRoot, "aliases");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "query-aliases.json"), `${JSON.stringify(content, null, 2)}\n`);
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
