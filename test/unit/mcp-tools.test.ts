import assert from "node:assert/strict";
import test from "node:test";
import { getContextTool, type GetContextServices } from "../../src/mcp/tools/get-context.js";
import { statusTool } from "../../src/mcp/tools/status.js";
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
    branch: "main",
    head_commit: "abc123",
    context_store: "github.com/team/service/.teamctx",
    store_head: null,
    normalizer_version: "0.1.0"
  });
});
