import assert from "node:assert/strict";
import test from "node:test";
import {
  fixtureCanonicalDocRef,
  fixtureDisabledContextPayload,
  fixtureEnabledContextPayload,
  fixtureEpisodeReference,
  fixtureGetContextInput
} from "../fixtures/context-payload.js";

test("fixtureEnabledContextPayload populates every section", () => {
  const payload = fixtureEnabledContextPayload();

  assert.equal(payload.enabled, true);
  assert.equal(payload.identity.repo, "github.com/team/service");
  assert.equal(payload.identity.branch, "main");
  assert.equal(payload.identity.head_commit, "abc123");
  assert.equal(payload.identity.context_store, "github.com/team/context/contexts/service");
  assert.equal(payload.identity.store_head, null);
  assert.equal(payload.identity.normalizer_version, "0.1.0");
  assert.match(payload.identity.context_payload_hash, /^sha256:[a-f0-9]{64}$/);

  assert.equal(payload.normalized_context.scoped.length, 1);
  const scoped = payload.normalized_context.scoped[0];
  assert.ok(scoped);
  assert.equal(scoped.id, "rule-auth-order");
  assert.equal(scoped.kind, "rule");
  assert.equal(typeof scoped.rank_score, "number");
  assert.ok(scoped.rank_reasons.length > 0);

  assert.ok(payload.normalized_context.must_follow_rules.length > 0);
  assert.ok(payload.normalized_context.recent_decisions.length > 0);
  assert.ok(payload.normalized_context.active_pitfalls.length > 0);
  assert.ok(payload.normalized_context.applicable_workflows.length > 0);
  assert.ok(payload.normalized_context.glossary_terms.length > 0);

  assert.equal(payload.relevant_episodes.length, 1);
  assert.equal(payload.canonical_doc_refs.length, 1);

  assert.ok(payload.diagnostics.contested_items.length > 0);
  assert.ok(payload.diagnostics.stale_items.length > 0);
  assert.ok(payload.diagnostics.dropped_items.length > 0);
  assert.ok(payload.diagnostics.excluded_items.length > 0);
  assert.ok(payload.diagnostics.budget_rejected.length > 0);
  assert.deepEqual(payload.diagnostics.index_warnings, []);

  assert.equal(payload.write_policy.record_observation_candidate, "allowed");
  assert.equal(payload.write_policy.record_observation_verified, "allowed_with_evidence");
  assert.equal(payload.write_policy.invalidate, "human_only");
  assert.equal(payload.write_policy.docs_evidence, "allowed_with_doc_role");
});

test("fixtureEnabledContextPayload applies shallow overrides", () => {
  const payload = fixtureEnabledContextPayload({
    relevant_episodes: [],
    canonical_doc_refs: []
  });

  assert.deepEqual(payload.relevant_episodes, []);
  assert.deepEqual(payload.canonical_doc_refs, []);
  assert.equal(payload.normalized_context.scoped.length, 1);
});

test("fixtureDisabledContextPayload defaults to unbound reason and accepts overrides", () => {
  const defaults = fixtureDisabledContextPayload();
  assert.deepEqual(defaults, {
    enabled: false,
    reason: "No teamctx binding found for this git root."
  });

  const overridden = fixtureDisabledContextPayload({
    reason: "No git repository with an origin remote found for this workspace."
  });
  assert.equal(overridden.enabled, false);
  assert.equal(
    overridden.reason,
    "No git repository with an origin remote found for this workspace."
  );
});

test("fixtureCanonicalDocRef populates required and optional fields", () => {
  const ref = fixtureCanonicalDocRef();
  assert.equal(ref.repo, "github.com/team/context");
  assert.equal(ref.path, "docs/auth.md");
  assert.equal(ref.commit, "abc123");
  assert.equal(ref.item_id, "rule-auth-order");
  assert.equal(ref.reason, "scoped docs evidence");
  assert.equal(ref.doc_role, "runbook");
  assert.deepEqual(ref.lines, [10, 20]);
  assert.ok(ref.fetch_url?.startsWith("https://raw.githubusercontent.com/"));
  assert.ok(ref.url?.startsWith("https://github.com/"));
});

test("fixtureEpisodeReference exposes summary, scope, and source ids", () => {
  const episode = fixtureEpisodeReference({ episode_id: "episode-x" });
  assert.equal(episode.episode_id, "episode-x");
  assert.equal(episode.schema_version, 1);
  assert.ok(episode.source_event_ids.length > 0);
  assert.equal(episode.scope.domains?.[0], "auth");
  assert.equal(episode.evidence[0]?.kind, "code");
  assert.deepEqual(episode.selection_reasons, ["target file match: src/auth/middleware.ts"]);
});

test("fixtureGetContextInput defaults to scoped auth selectors", () => {
  const input = fixtureGetContextInput();
  assert.deepEqual(input.target_files, ["src/auth/middleware.ts"]);
  assert.deepEqual(input.domains, ["auth"]);
  assert.deepEqual(input.symbols, ["AuthMiddleware"]);
  assert.deepEqual(input.tags, ["request-lifecycle"]);

  const overridden = fixtureGetContextInput({ query: "auth ordering" });
  assert.equal(overridden.query, "auth ordering");
  assert.deepEqual(overridden.target_files, ["src/auth/middleware.ts"]);
});
