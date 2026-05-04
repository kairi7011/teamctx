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
        scope: { paths: ["src/**"], domains: [], symbols: [], tags: [] },
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

test("formatHygieneReport renders review-only maintenance plans", () => {
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
      total_records: 2,
      active_records: 2,
      inactive_records: 0,
      expired_active_records: 0,
      not_yet_valid_active_records: 0,
      old_active_records: 0,
      unverified_active_records: 0,
      duplicate_active_text_records: 2,
      crowded_active_scope_records: 0,
      large_active_records: 0
    },
    risk_items: [],
    recovery_suggestions: [],
    maintenance_plan: {
      mode: "review_only",
      item_count: 1,
      items: [
        {
          category: "duplicate_review",
          action: "merge_or_supersede",
          severity: "warning",
          record_ids: ["rule-a", "rule-b"],
          title: "Merge or supersede duplicate active records",
          rationale: "The same normalized text appears across 2 active records.",
          review_commands: [
            "teamctx show rule-a",
            "teamctx explain rule-a",
            "teamctx show rule-b",
            "teamctx explain rule-b"
          ],
          candidate_write_commands: [
            "teamctx record-verified merged-observation.json",
            "teamctx normalize --dry-run",
            "teamctx normalize"
          ],
          observation_drafts: [
            {
              draft_status: "incomplete_requires_evidence_review",
              kind: "rule",
              text: "TODO: merge duplicate records.",
              source_type: "inferred_from_docs",
              scope: { paths: ["src/**"], domains: ["cli"], symbols: [], tags: [] },
              supersedes: ["rule-a", "rule-b"],
              evidence: [],
              instructions: ["Add evidence before running record-verified."]
            }
          ],
          notes: ["The merged observation should list the replaced record ids in `supersedes`."]
        }
      ],
      safety_notes: ["`teamctx hygiene --plan` is read-only and never mutates the context store."]
    }
  };

  const output = formatHygieneReport(report);

  assert.match(output, /maintenance_plan: review_only/);
  assert.match(output, /merge_or_supersede: rule-a, rule-b/);
  assert.match(output, /candidate_write:/);
  assert.match(output, /teamctx record-verified merged-observation\.json/);
  assert.match(output, /observation_drafts: 1 incomplete draft/);
  assert.match(output, /read-only and never mutates/);
});
