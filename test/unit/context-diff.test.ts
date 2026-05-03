import assert from "node:assert/strict";
import test from "node:test";
import { diffContextPayloads } from "../../src/core/context/context-diff.js";
import type { EnabledContextPayload } from "../../src/schemas/context-payload.js";
import {
  fixtureDisabledContextPayload,
  fixtureEnabledContextPayload
} from "../fixtures/context-payload.js";

test("diffContextPayloads reports scoped and diagnostic changes", () => {
  const left = payload({
    hash: "sha256:left",
    scopedIds: ["rule-auth", "pitfall-auth"],
    rules: ["rule text"],
    contested: ["decision-old"],
    budgetRejected: ["workflow-big"]
  });
  const right = payload({
    hash: "sha256:right",
    scopedIds: ["rule-auth", "workflow-auth"],
    rules: ["rule text", "new rule text"],
    contested: [],
    budgetRejected: ["workflow-big", "pitfall-big"]
  });

  const diff = diffContextPayloads(
    left,
    right,
    { domains: ["auth"] },
    { domains: ["auth"], query: "workflow" }
  );

  assert.equal(diff.enabled, true);

  if (!diff.enabled) {
    throw new Error("expected enabled diff");
  }

  assert.deepEqual(diff.scoped.added, ["workflow-auth"]);
  assert.deepEqual(diff.scoped.removed, ["pitfall-auth"]);
  assert.deepEqual(diff.scoped.unchanged, ["rule-auth"]);
  assert.deepEqual(diff.categories.must_follow_rules.added, ["new rule text"]);
  assert.equal(diff.categories.must_follow_rules.unchanged_count, 1);
  assert.deepEqual(diff.diagnostics.contested_items.removed, ["decision-old"]);
  assert.deepEqual(diff.diagnostics.budget_rejected.added, ["pitfall-big"]);
  assert.equal(diff.left.context_payload_hash, "sha256:left");
  assert.equal(diff.right.input.query, "workflow");
});

test("diffContextPayloads reports disabled sides without comparing context", () => {
  const diff = diffContextPayloads(
    fixtureDisabledContextPayload(),
    payload({ hash: "sha256:right", scopedIds: ["rule-auth"] }),
    {},
    { target_files: ["src/auth.ts"] }
  );

  assert.deepEqual(diff, {
    enabled: false,
    left: {
      input: {},
      enabled: false,
      reason: "No teamctx binding found for this git root."
    },
    right: {
      input: { target_files: ["src/auth.ts"] },
      enabled: true,
      context_payload_hash: "sha256:right"
    }
  });
});

function payload(input: {
  hash: string;
  scopedIds: string[];
  rules?: string[];
  contested?: string[];
  budgetRejected?: string[];
}): EnabledContextPayload {
  const base = fixtureEnabledContextPayload();
  return {
    ...base,
    identity: { ...base.identity, context_payload_hash: input.hash },
    normalized_context: {
      ...base.normalized_context,
      scoped: input.scopedIds.map((id) => ({
        id,
        kind: "rule",
        scope: {},
        content: `${id} content`,
        reason: "test",
        rank_score: 10,
        rank_reasons: ["test"],
        confidence_level: "medium"
      })),
      must_follow_rules: input.rules ?? [],
      recent_decisions: [],
      active_pitfalls: [],
      applicable_workflows: [],
      glossary_terms: []
    },
    relevant_episodes: [],
    canonical_doc_refs: [],
    diagnostics: {
      contested_items: input.contested ?? [],
      stale_items: [],
      dropped_items: [],
      excluded_items: [],
      budget_rejected: (input.budgetRejected ?? []).map((id) => ({
        id,
        kind: "workflow",
        rank_score: 1,
        rank_reasons: ["test"],
        exclusion_reason: "budget_overflow:workflow",
        overflow_reasons: ["budget_overflow:workflow"],
        included_in: [],
        fully_excluded: true
      })),
      index_warnings: []
    }
  };
}
