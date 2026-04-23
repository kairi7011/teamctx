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
import type { NormalizedRecord } from "../../src/schemas/normalized-record.js";
import type { Binding } from "../../src/schemas/types.js";

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
  assert.deepEqual(context.normalized_context.active_pitfalls, []);
  assert.equal(context.write_policy.record_observation_verified, "allowed_with_evidence");
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
      stale_items: []
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
  return {
    id: "pitfall-auth",
    schema_version: 1,
    normalizer_version: "0.1.0",
    kind: "pitfall",
    state: "active",
    text: "Auth middleware ordering is easy to break.",
    scope: {
      paths: ["src/auth/**"],
      domains: ["auth"],
      symbols: ["AuthMiddleware"],
      tags: []
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
