import assert from "node:assert/strict";
import test from "node:test";
import { formatContextDiff } from "../../src/cli/index.js";
import { diffContextPayloads } from "../../src/core/context/context-diff.js";
import type { EnabledContextPayload } from "../../src/schemas/context-payload.js";
import {
  fixtureDisabledContextPayload,
  fixtureEnabledContextPayload
} from "../fixtures/context-payload.js";

test("formatContextDiff renders terminal-friendly context changes", () => {
  const diff = diffContextPayloads(
    payload({
      hash: "sha256:left",
      scopedIds: ["rule-auth", "pitfall-auth"],
      episodes: ["episode-old"],
      rules: ["rule text"],
      contested: ["decision-old"]
    }),
    payload({
      hash: "sha256:right",
      scopedIds: ["rule-auth", "workflow-auth"],
      episodes: ["episode-new"],
      rules: ["rule text", "new rule text"],
      contested: []
    }),
    { domains: ["auth"] },
    { domains: ["auth"], query: "workflow" }
  );

  const formatted = formatContextDiff(diff);

  assert.match(formatted, /^Context diff:/);
  assert.ok(formatted.includes("  left_hash: sha256:left"));
  assert.ok(formatted.includes("  right_hash: sha256:right"));
  assert.ok(formatted.includes("  scoped: +1 -1 =1"));
  assert.ok(formatted.includes("    + workflow-auth"));
  assert.ok(formatted.includes("    - pitfall-auth"));
  assert.ok(formatted.includes("  relevant_episodes: +1 -1 =0"));
  assert.ok(formatted.includes("    + episode-new"));
  assert.ok(formatted.includes("    - episode-old"));
  assert.ok(formatted.includes("    must_follow_rules: +1 -0 =1"));
  assert.ok(formatted.includes("      + new rule text"));
  assert.ok(formatted.includes("    contested_items: +0 -1 =0"));
  assert.ok(formatted.includes("      - decision-old"));
});

test("formatContextDiff explains disabled sides without dumping JSON", () => {
  const diff = diffContextPayloads(
    fixtureDisabledContextPayload(),
    payload({ hash: "sha256:right", scopedIds: ["rule-auth"] }),
    {},
    { target_files: ["src/auth.ts"] }
  );

  assert.deepEqual(formatContextDiff(diff).split("\n"), [
    "Context diff unavailable:",
    "  left: disabled reason=No teamctx binding found for this git root.",
    "  right: enabled hash=sha256:right"
  ]);
});

function payload(input: {
  hash: string;
  scopedIds: string[];
  episodes?: string[];
  rules?: string[];
  contested?: string[];
}): EnabledContextPayload {
  const base = fixtureEnabledContextPayload();
  const baseEpisode = base.relevant_episodes[0];

  if (!baseEpisode) {
    throw new Error("fixture must include an episode reference");
  }

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
    relevant_episodes: (input.episodes ?? []).map((episodeId) => ({
      ...baseEpisode,
      episode_id: episodeId
    })),
    canonical_doc_refs: [],
    diagnostics: {
      contested_items: input.contested ?? [],
      stale_items: [],
      dropped_items: [],
      excluded_items: [],
      budget_rejected: [],
      query_warnings: [],
      index_warnings: [],
      baseline_context: base.diagnostics.baseline_context
    }
  };
}
