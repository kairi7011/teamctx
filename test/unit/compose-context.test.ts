import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { composeContextFromStore } from "../../src/core/context/compose-context.js";
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

function record(
  id: string,
  kind: NormalizedRecord["kind"],
  state: NormalizedRecord["state"]
): NormalizedRecord {
  return {
    id,
    schema_version: 1,
    normalizer_version: "0.1.0",
    kind,
    state,
    text: `${id} text`,
    scope: {
      paths: ["src/auth/**"],
      domains: ["auth"],
      symbols: ["AuthMiddleware"],
      tags: ["request-lifecycle"]
    },
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
