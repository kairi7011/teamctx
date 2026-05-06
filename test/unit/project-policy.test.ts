import assert from "node:assert/strict";
import test from "node:test";
import {
  createDefaultProjectPolicy,
  parseProjectPolicy,
  serializeProjectPolicy,
  validateProjectPolicy
} from "../../src/schemas/project-policy.js";

test("default project policy keeps automation disabled but reviewable", () => {
  const policy = createDefaultProjectPolicy();

  assert.equal(policy.schema_version, 1);
  assert.equal(policy.governance_level, "suggested_review");
  assert.equal(policy.candidate_automation.enabled, false);
  assert.deepEqual(policy.candidate_automation.allowed_kinds, ["fact", "pitfall", "workflow"]);
  assert.equal(policy.high_impact.require_reviewer, true);
  assert.deepEqual(policy.background_jobs.allowed_types, ["normalize", "compact", "index_refresh"]);
  assert.equal(policy.background_jobs.enabled, false);
});

test("parseProjectPolicy round-trips the default policy", () => {
  const policy = parseProjectPolicy(serializeProjectPolicy(createDefaultProjectPolicy()));

  assert.deepEqual(policy, createDefaultProjectPolicy());
});

test("validateProjectPolicy rejects unsupported automation kinds", () => {
  const policy = createDefaultProjectPolicy() as unknown as Record<string, unknown>;
  policy.candidate_automation = {
    enabled: false,
    allowed_kinds: ["fact", "temporary-note"],
    require_evidence: true,
    max_items_per_session: 5
  };

  assert.throws(
    () => validateProjectPolicy(policy),
    /candidate_automation\.allowed_kinds contains unsupported value/
  );
});
