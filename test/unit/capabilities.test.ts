import assert from "node:assert/strict";
import test from "node:test";
import { describeBindingCapabilities } from "../../src/core/capabilities.js";
import type { Binding } from "../../src/schemas/types.js";

test("describeBindingCapabilities reports unbound when binding is missing", () => {
  const caps = describeBindingCapabilities(undefined, undefined);

  assert.equal(caps.bound, false);
  assert.equal(caps.store_kind, "unbound");
  assert.equal(caps.normalize_supported, false);
  assert.equal(caps.policy_config, false);
  assert.equal(caps.background_jobs, false);
  for (const value of Object.values(caps.store)) {
    assert.equal(value, false);
  }
});

test("describeBindingCapabilities reports local store when bound to same repo", () => {
  const binding: Binding = {
    repo: "github.com/team/service",
    root: "/work/service",
    contextStore: {
      provider: "github",
      repo: "github.com/team/service",
      path: ".teamctx"
    },
    createdAt: "2026-04-22T10:00:00.000Z"
  };

  const caps = describeBindingCapabilities(binding, "github.com/team/service");

  assert.equal(caps.bound, true);
  assert.equal(caps.store_kind, "local");
  assert.equal(caps.store.remote_writes, false);
  assert.equal(caps.store.optimistic_concurrency, false);
  assert.equal(caps.store.append_only_jsonl, true);
  assert.equal(caps.normalize_supported, true);
  assert.equal(caps.policy_config, true);
  assert.equal(caps.background_jobs, false);
});

test("describeBindingCapabilities reports github store when bound to different repo", () => {
  const binding: Binding = {
    repo: "github.com/team/service",
    root: "/work/service",
    contextStore: {
      provider: "github",
      repo: "github.com/team/team-context",
      path: "contexts/service"
    },
    createdAt: "2026-04-22T10:00:00.000Z"
  };

  const caps = describeBindingCapabilities(binding, "github.com/team/service");

  assert.equal(caps.bound, true);
  assert.equal(caps.store_kind, "github");
  assert.equal(caps.store.remote_writes, true);
  assert.equal(caps.store.optimistic_concurrency, true);
  assert.equal(caps.store.revision_tracking, true);
  assert.equal(caps.store.append_only_jsonl, true);
  assert.equal(caps.store.batch_writes, false);
  assert.equal(caps.store.semantic_features, false);
  assert.equal(caps.policy_config, true);
});
