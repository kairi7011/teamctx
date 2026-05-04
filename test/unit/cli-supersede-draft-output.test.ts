import assert from "node:assert/strict";
import test from "node:test";
import { formatSupersedeDraft } from "../../src/cli/index.js";
import type { SupersedeDraftResult } from "../../src/core/hygiene/supersede-draft.js";

test("formatSupersedeDraft renders review commands and the incomplete observation draft", () => {
  const output = formatSupersedeDraft({
    mode: "review_only",
    record_ids: ["rule-a", "rule-b"],
    record_count: 2,
    records: [
      {
        id: "rule-a",
        kind: "rule",
        state: "active",
        text: "Use the canonical helper.",
        scope: { paths: ["src/a.ts"], domains: ["cli"], symbols: [], tags: [] }
      },
      {
        id: "rule-b",
        kind: "rule",
        state: "active",
        text: "Use the canonical helper.",
        scope: { paths: ["src/a.ts"], domains: ["cli"], symbols: [], tags: [] }
      }
    ],
    warnings: ["Review duplicate evidence before merging."],
    review_commands: [
      "teamctx show rule-a",
      "teamctx explain rule-a",
      "teamctx show rule-b",
      "teamctx explain rule-b"
    ],
    candidate_write_commands: [
      "teamctx record-verified superseding-observation.json",
      "teamctx normalize --dry-run",
      "teamctx normalize"
    ],
    draft_observation: {
      draft_status: "incomplete_requires_evidence_review",
      kind: "rule",
      text: "TODO: Write one evidence-backed statement that replaces: rule-a, rule-b.",
      source_type: "inferred_from_docs",
      scope: { paths: ["src/a.ts"], domains: ["cli"], symbols: [], tags: [] },
      supersedes: ["rule-a", "rule-b"],
      evidence: [],
      instructions: ["Add evidence before running record-verified."]
    }
  } satisfies SupersedeDraftResult);

  assert.match(output, /^Supersede draft:/);
  assert.match(output, /records: rule-a, rule-b/);
  assert.match(output, /teamctx show rule-a/);
  assert.match(output, /warnings:/);
  assert.match(output, /teamctx record-verified superseding-observation\.json/);
  assert.match(output, /"draft_status": "incomplete_requires_evidence_review"/);
  assert.match(output, /"supersedes": \[\n\s+"rule-a",\n\s+"rule-b"\n\s+\]/);
});
