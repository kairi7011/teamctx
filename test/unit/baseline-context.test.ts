import assert from "node:assert/strict";
import test from "node:test";
import { explainBaselineContext } from "../../src/core/context/baseline-context.js";

test("explainBaselineContext marks bare session_start as baseline eligible", () => {
  const diagnostics = explainBaselineContext({ call_reason: "session_start" });

  assert.equal(diagnostics.mode, "session_baseline");
  assert.equal(diagnostics.eligible, true);
  assert.equal(diagnostics.selector_count, 0);
  assert.equal(diagnostics.budget_tokens, 800);
  assert.deepEqual(diagnostics.included_sections, [
    "must_follow_rules",
    "recent_decisions",
    "active_pitfalls",
    "applicable_workflows",
    "glossary_terms",
    "global"
  ]);
});

test("explainBaselineContext keeps first-turn selectors task scoped with baseline", () => {
  const diagnostics = explainBaselineContext({
    call_reason: "session_start",
    target_files: ["src/cli/index.ts"],
    domains: ["cli"],
    query: "help flag side effects"
  });

  assert.equal(diagnostics.mode, "task_scoped_with_baseline");
  assert.equal(diagnostics.eligible, true);
  assert.equal(diagnostics.selector_count, 3);
  assert.ok(
    diagnostics.reasons.includes(
      "session_start with selectors composes task-scoped context plus baseline sections"
    )
  );
});

test("explainBaselineContext avoids implicit baseline outside session_start", () => {
  const diagnostics = explainBaselineContext({
    call_reason: "explicit_user_request",
    symbols: ["writeIfChanged"]
  });

  assert.equal(diagnostics.mode, "task_scoped");
  assert.equal(diagnostics.eligible, false);
  assert.equal(diagnostics.selector_count, 1);
  assert.deepEqual(diagnostics.included_sections, []);
  assert.deepEqual(diagnostics.reasons, [
    "explicit_user_request returns the requested scoped context without implicit baseline"
  ]);
});
