import assert from "node:assert/strict";
import test from "node:test";
import type {
  ContextStoreAdapter,
  ContextStoreFile,
  ContextStoreWriteOptions,
  ContextStoreWriteResult
} from "../../src/adapters/store/context-store.js";
import {
  getContextTool,
  getContextToolAsync,
  type GetContextServices
} from "../../src/mcp/tools/get-context.js";
import { statusTool, statusToolAsync } from "../../src/mcp/tools/status.js";
import { toolDefinitions } from "../../src/mcp/tools/definitions.js";
import type { NormalizedRecord } from "../../src/schemas/normalized-record.js";
import type { Binding } from "../../src/schemas/types.js";
import { fixtureNormalizedRecord } from "../fixtures/normalized-record.js";

const binding: Binding = {
  repo: "github.com/team/service",
  root: "C:/work/service",
  contextStore: {
    provider: "github",
    repo: "github.com/team/service",
    path: ".teamctx"
  },
  createdAt: "2026-04-21T10:00:00.000Z"
};

const boundServices: GetContextServices = {
  getRepoRoot: () => "C:/work/service",
  getOriginRemote: () => "git@github.com:team/service.git",
  getCurrentBranch: () => "main",
  getHeadCommit: () => "abc123",
  findBinding: () => binding
};

test("getContextTool returns disabled when no git repo can be resolved", () => {
  const context = getContextTool(
    {},
    {
      ...boundServices,
      getRepoRoot: () => {
        throw new Error("not a git repo");
      }
    }
  );

  assert.deepEqual(context, {
    enabled: false,
    reason: "No git repository with an origin remote found for this workspace."
  });
});

test("getContextTool returns disabled when the repo is unbound", () => {
  const context = getContextTool(
    {},
    {
      ...boundServices,
      findBinding: () => undefined
    }
  );

  assert.deepEqual(context, {
    enabled: false,
    reason: "No teamctx binding found for this git root."
  });
});

test("getContextTool returns an empty enabled payload with identity fields", () => {
  const context = getContextTool({ branch: "feature/auth", head_commit: "def456" }, boundServices);

  assert.equal(context.enabled, true);

  if (!context.enabled) {
    throw new Error("expected enabled context");
  }

  assert.equal(context.identity.repo, "github.com/team/service");
  assert.equal(context.identity.branch, "feature/auth");
  assert.equal(context.identity.head_commit, "def456");
  assert.equal(context.identity.context_store, "github.com/team/service/.teamctx");
  assert.equal(context.identity.store_head, null);
  assert.equal(context.identity.normalizer_version, "0.1.0");
  assert.match(context.identity.context_payload_hash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(context.context_unchanged, false);
  assert.equal(context.delivery_policy.call_reason, "task_start");
  assert.equal(context.delivery_policy.session_start_required, true);
  assert.equal(context.delivery_policy.should_inject, true);
  assert.deepEqual(context.normalized_context.active_pitfalls, []);
  assert.equal(context.write_policy.record_observation_verified, "allowed_with_evidence");
});

test("getContextTool skips reinjecting unchanged non-explicit context", () => {
  const firstContext = getContextTool({ changed_files: ["src/auth/middleware.ts"] }, boundServices);

  if (!firstContext.enabled) {
    throw new Error("expected enabled context");
  }

  const secondContext = getContextTool(
    {
      changed_files: ["src/auth/middleware.ts"],
      call_reason: "task_start",
      previous_context_payload_hash: firstContext.identity.context_payload_hash
    },
    boundServices
  );

  assert.equal(secondContext.enabled, true);

  if (!secondContext.enabled) {
    throw new Error("expected enabled context");
  }

  assert.equal(
    secondContext.identity.context_payload_hash,
    firstContext.identity.context_payload_hash
  );
  assert.equal(secondContext.context_unchanged, true);
  assert.equal(secondContext.delivery_policy.unchanged_from_previous, true);
  assert.equal(secondContext.delivery_policy.should_inject, false);
  assert.deepEqual(secondContext.normalized_context.scoped, []);
  assert.equal(secondContext.diagnostics.baseline_context.mode, "task_scoped");
});

test("getContextTool returns full context for session start and explicit refresh", () => {
  const firstContext = getContextTool({ changed_files: ["src/auth/middleware.ts"] }, boundServices);

  if (!firstContext.enabled) {
    throw new Error("expected enabled context");
  }

  for (const callReason of ["session_start", "explicit_user_request"] as const) {
    const refreshedContext = getContextTool(
      {
        changed_files: ["src/auth/middleware.ts"],
        call_reason: callReason,
        previous_context_payload_hash: firstContext.identity.context_payload_hash
      },
      boundServices
    );

    assert.equal(refreshedContext.enabled, true);

    if (!refreshedContext.enabled) {
      throw new Error("expected enabled context");
    }

    assert.equal(refreshedContext.context_unchanged, false);
    assert.equal(refreshedContext.delivery_policy.call_reason, callReason);
    assert.equal(refreshedContext.delivery_policy.unchanged_from_previous, true);
    assert.equal(refreshedContext.delivery_policy.should_inject, true);
    assert.equal(
      refreshedContext.diagnostics.baseline_context.mode,
      callReason === "session_start" ? "task_scoped_with_baseline" : "task_scoped"
    );
  }
});

test("getContextTool returns an isolated write policy object", () => {
  const firstContext = getContextTool({}, boundServices);
  const secondContext = getContextTool({}, boundServices);

  if (!firstContext.enabled || !secondContext.enabled) {
    throw new Error("expected enabled context");
  }

  (firstContext.write_policy as { invalidate: string }).invalidate = "allowed";

  assert.equal(secondContext.write_policy.invalidate, "human_only");
});

test("invalidate tool schema requires human confirmation", () => {
  const definition = toolDefinitions.find((tool) => tool.name === "teamctx.invalidate");
  assert.ok(definition);

  const inputSchema = asRecord(definition.inputSchema);
  const properties = asRecord(inputSchema.properties);

  assert.deepEqual(inputSchema.required, ["item_id", "human_confirmed"]);
  assert.deepEqual(properties.human_confirmed, { const: true });
});

test("get_context tool schema advertises call policy inputs", () => {
  const definition = toolDefinitions.find((tool) => tool.name === "teamctx.get_context");
  assert.ok(definition);

  const inputSchema = asRecord(definition.inputSchema);
  const properties = asRecord(inputSchema.properties);

  assert.deepEqual(properties.call_reason, {
    type: "string",
    enum: ["session_start", "task_start", "context_changed", "explicit_user_request"]
  });
  assert.deepEqual(properties.previous_context_payload_hash, { type: "string" });
  assert.deepEqual(properties.force_refresh, { type: "boolean" });
});

test("statusTool returns the enabled binding summary", () => {
  assert.deepEqual(statusTool({}, boundServices), {
    enabled: true,
    repo: "github.com/team/service",
    root: "C:/work/service",
    branch: "main",
    head_commit: "abc123",
    context_store: "github.com/team/service/.teamctx",
    store_head: null,
    local_store: true,
    summary: {
      last_normalize_result: null,
      counts: {
        total_records: 0,
        active_records: 0,
        contested_records: 0,
        stale_records: 0,
        superseded_records: 0,
        archived_records: 0,
        audit_entries: 0,
        promoted_records: 0,
        dropped_events: 0
      },
      recent_promoted_items: [],
      contested_items: [],
      dropped_items: [],
      stale_items: [],
      normalize_lease: {
        state: "none"
      },
      index_warnings: [],
      recovery_suggestions: []
    }
  });
});

test("getContextToolAsync composes context from a remote context store adapter", async () => {
  const store = new MemoryContextStore("remote-head-1");
  await store.writeText("normalized/pitfalls.jsonl", `${JSON.stringify(record())}\n`, {
    message: "seed"
  });

  const context = await getContextToolAsync(
    { target_files: ["src/auth/middleware.ts"] },
    remoteServices(store)
  );

  assert.equal(context.enabled, true);

  if (!context.enabled) {
    throw new Error("expected enabled context");
  }

  assert.equal(context.identity.context_store, "github.com/team/context/contexts/service");
  assert.equal(context.identity.store_head, "remote-head-1");
  assert.deepEqual(context.normalized_context.active_pitfalls, [
    "Auth middleware ordering is easy to break."
  ]);
  assert.equal(context.normalized_context.scoped.length, 1);
});

test("getContextToolAsync returns non-empty full context for explicit refreshes", async () => {
  const store = new MemoryContextStore("remote-head-1");
  await store.writeText("normalized/pitfalls.jsonl", `${JSON.stringify(record())}\n`, {
    message: "seed"
  });

  const firstContext = await getContextToolAsync(
    { target_files: ["src/auth/middleware.ts"] },
    remoteServices(store)
  );

  assert.equal(firstContext.enabled, true);

  if (!firstContext.enabled) {
    throw new Error("expected enabled context");
  }

  for (const input of [
    { call_reason: "session_start" as const },
    { call_reason: "explicit_user_request" as const },
    { force_refresh: true }
  ]) {
    const refreshedContext = await getContextToolAsync(
      {
        target_files: ["src/auth/middleware.ts"],
        previous_context_payload_hash: firstContext.identity.context_payload_hash,
        ...input
      },
      remoteServices(store)
    );

    assert.equal(refreshedContext.enabled, true);

    if (!refreshedContext.enabled) {
      throw new Error("expected enabled context");
    }

    assert.equal(refreshedContext.context_unchanged, false);
    assert.equal(refreshedContext.delivery_policy.should_inject, true);
    assert.equal(
      refreshedContext.diagnostics.baseline_context.mode,
      input.call_reason === "session_start" ? "task_scoped_with_baseline" : "task_scoped"
    );
    assert.equal(
      refreshedContext.identity.context_payload_hash,
      firstContext.identity.context_payload_hash
    );
    assert.equal(refreshedContext.normalized_context.scoped.length, 1);
    assert.deepEqual(refreshedContext.normalized_context.active_pitfalls, [
      "Auth middleware ordering is easy to break."
    ]);
  }
});

test("statusToolAsync summarizes a remote context store adapter", async () => {
  const store = new MemoryContextStore("remote-head-1");
  await store.writeText("normalized/pitfalls.jsonl", `${JSON.stringify(record())}\n`, {
    message: "seed"
  });
  await store.writeText(
    "audit/changes.jsonl",
    `${JSON.stringify({
      schema_version: 1,
      id: "audit-1",
      at: "2026-04-22T11:00:00.000Z",
      action: "created",
      item_id: "pitfall-auth",
      after_state: "active",
      reason: "evidence minimum check passed",
      source_event_ids: ["event-1"]
    })}\n`,
    { message: "seed" }
  );

  const status = (await statusToolAsync({}, remoteServices(store))) as {
    enabled: boolean;
    store_head?: string | null;
    local_store?: boolean;
    summary?: { counts: { active_records: number }; recent_promoted_items: unknown[] };
  };

  assert.equal(status.enabled, true);
  assert.equal(status.store_head, "remote-head-1");
  assert.equal(status.local_store, false);
  assert.equal(status.summary?.counts.active_records, 1);
  assert.equal(status.summary?.recent_promoted_items.length, 1);
});

function remoteServices(store: ContextStoreAdapter): GetContextServices {
  return {
    getRepoRoot: () => "C:/work/service",
    getOriginRemote: () => "git@github.com:team/service.git",
    getCurrentBranch: () => "main",
    getHeadCommit: () => "abc123",
    findBinding: () => ({
      ...binding,
      contextStore: {
        provider: "github",
        repo: "github.com/team/context",
        path: "contexts/service"
      }
    }),
    createContextStore: () => store
  };
}

function record(): NormalizedRecord {
  return fixtureNormalizedRecord({
    id: "pitfall-auth",
    text: "Auth middleware ordering is easy to break.",
    scope: {
      paths: ["src/auth/**"],
      domains: ["auth"],
      symbols: ["AuthMiddleware"],
      tags: []
    }
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);

  return value as Record<string, unknown>;
}

class MemoryContextStore implements ContextStoreAdapter {
  private readonly files = new Map<string, string>();

  constructor(private readonly revision: string | null) {}

  async getRevision(): Promise<string | null> {
    return this.revision;
  }

  async readText(path: string): Promise<ContextStoreFile | undefined> {
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

    return { path, revision: null, storeRevision: this.revision };
  }

  async deleteText(
    path: string,
    _options: ContextStoreWriteOptions
  ): Promise<ContextStoreWriteResult> {
    this.files.delete(path);

    return { path, revision: null, storeRevision: this.revision };
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

  async listFiles(): Promise<string[]> {
    return [...this.files.keys()].sort();
  }
}
