import assert from "node:assert/strict";
import test from "node:test";
import { buildSupersedeDraft } from "../../src/core/hygiene/supersede-draft.js";
import { CoreError } from "../../src/core/errors.js";
import { fixtureNormalizedRecord } from "../fixtures/normalized-record.js";

test("buildSupersedeDraft creates an evidence-empty replacement draft", () => {
  const draft = buildSupersedeDraft([
    fixtureNormalizedRecord({
      id: "rule-context-start",
      kind: "rule",
      text: "Call teamctx context at session_start only.",
      scope: {
        paths: ["src/schemas/context-payload.ts", "src/core/context/compose-context.ts"],
        domains: ["context-composition", "schema", "canonical-docs"],
        symbols: ["CanonicalDocRef", "canonicalDocRefs"],
        tags: ["ce-08", "doc-retrieval"]
      }
    })
  ]);

  assert.equal(draft.mode, "review_only");
  assert.deepEqual(draft.record_ids, ["rule-context-start"]);
  assert.deepEqual(draft.review_commands, [
    "teamctx show rule-context-start",
    "teamctx explain rule-context-start"
  ]);
  assert.deepEqual(draft.candidate_write_commands, [
    "teamctx record-verified superseding-observation.json",
    "teamctx normalize --dry-run",
    "teamctx normalize"
  ]);
  assert.equal(draft.draft_observation.kind, "rule");
  assert.deepEqual(draft.draft_observation.scope.paths, [
    "src/schemas/context-payload.ts",
    "src/core/context/compose-context.ts"
  ]);
  assert.deepEqual(draft.draft_observation.scope.domains, [
    "context-composition",
    "schema",
    "canonical-docs"
  ]);
  assert.deepEqual(draft.draft_observation.supersedes, ["rule-context-start"]);
  assert.deepEqual(draft.draft_observation.evidence, []);
  assert.match(draft.draft_observation.instructions.at(-1) ?? "", /record-verified rejects/);
});

test("buildSupersedeDraft unions non-identical scopes and warns", () => {
  const draft = buildSupersedeDraft([
    fixtureNormalizedRecord({
      id: "workflow-a",
      kind: "workflow",
      scope: { paths: ["src/a.ts"], domains: ["cli"], symbols: [], tags: ["setup"] }
    }),
    fixtureNormalizedRecord({
      id: "workflow-b",
      kind: "workflow",
      scope: { paths: ["src/b.ts"], domains: ["cli"], symbols: ["bind"], tags: [] }
    })
  ]);

  assert.deepEqual(draft.draft_observation.scope, {
    paths: ["src/a.ts", "src/b.ts"],
    domains: ["cli"],
    symbols: ["bind"],
    tags: ["setup"]
  });
  assert.deepEqual(draft.draft_observation.supersedes, ["workflow-a", "workflow-b"]);
  assert.equal(draft.warnings.length, 1);
  assert.match(draft.warnings[0] ?? "", /union scope/);
});

test("buildSupersedeDraft rejects mixed knowledge kinds", () => {
  assert.throws(
    () =>
      buildSupersedeDraft([
        fixtureNormalizedRecord({ id: "rule-a", kind: "rule" }),
        fixtureNormalizedRecord({ id: "workflow-b", kind: "workflow" })
      ]),
    (error: unknown) =>
      error instanceof CoreError && error.kind === "validation" && /same kind/.test(error.message)
  );
});
