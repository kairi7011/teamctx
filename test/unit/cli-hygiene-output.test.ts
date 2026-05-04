import assert from "node:assert/strict";
import test from "node:test";
import { formatHygieneReport } from "../../src/cli/index.js";
import type { BoundHygieneReport } from "../../src/core/hygiene/report.js";

test("formatHygieneReport renders disabled reports", () => {
  assert.equal(
    formatHygieneReport({
      enabled: false,
      reason: "No teamctx binding found for this git root.",
      repo: "github.com/team/service"
    }),
    [
      "Context hygiene unavailable:",
      "  reason: No teamctx binding found for this git root.",
      "  repo: github.com/team/service"
    ].join("\n")
  );
});

test("formatHygieneReport renders counts, risks, and suggestions", () => {
  const report: BoundHygieneReport = {
    enabled: true,
    repo: "github.com/team/service",
    root: "/repo",
    branch: "main",
    head_commit: "abc123",
    context_store: "github.com/team/context/contexts/service",
    store_head: "store123",
    local_store: false,
    checked_at: "2026-05-04T00:00:00.000Z",
    older_than_days: 90,
    large_record_tokens: 250,
    counts: {
      total_records: 3,
      active_records: 2,
      inactive_records: 1,
      expired_active_records: 1,
      not_yet_valid_active_records: 0,
      old_active_records: 1,
      unverified_active_records: 0,
      duplicate_active_text_records: 0,
      crowded_active_scope_records: 0,
      large_active_records: 0
    },
    risk_items: [
      {
        risk: "expired_active",
        severity: "action",
        id: "decision-old",
        kind: "decision",
        text: "Use the old branch layout.",
        scope_summary: "paths=src/**",
        age_days: 120,
        related_ids: [],
        detail: "valid_until 2026-03-01T00:00:00.000Z is before 2026-05-04T00:00:00.000Z",
        suggested_action: "Invalidate the record."
      }
    ],
    recovery_suggestions: ["Fix validity-window risks first."]
  };

  const output = formatHygieneReport(report);

  assert.match(output, /Context hygiene:/);
  assert.match(output, /records: total=3 active=2 inactive=1/);
  assert.match(output, /risks: expired=1 future=0 old=1/);
  assert.match(output, /\[action\] expired_active decision-old \(decision\) age=120d/);
  assert.match(output, /suggestions:/);
});
