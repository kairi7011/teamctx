import assert from "node:assert/strict";
import test from "node:test";
import { formatStatusReport } from "../../src/cli/index.js";
import type { BoundStatus } from "../../src/core/status/status.js";
import type { StatusSummary } from "../../src/core/status/summary.js";

const baseCounts: StatusSummary["counts"] = {
  total_records: 0,
  active_records: 0,
  contested_records: 0,
  stale_records: 0,
  superseded_records: 0,
  archived_records: 0,
  audit_entries: 0,
  promoted_records: 0,
  dropped_events: 0
};

function emptySummary(overrides: Partial<StatusSummary> = {}): StatusSummary {
  return {
    last_normalize_result: null,
    counts: { ...baseCounts },
    recent_promoted_items: [],
    contested_items: [],
    dropped_items: [],
    stale_items: [],
    normalize_lease: { state: "none" },
    policy: {
      state: "valid",
      path: "policy/project-policy.json",
      governance_level: "suggested_review",
      candidate_automation_enabled: false,
      candidate_automation_allowed_kinds: ["fact", "pitfall", "workflow"],
      candidate_automation_max_items_per_session: 5,
      high_impact_kinds: ["rule", "workflow", "decision"],
      high_impact_require_reviewer: true,
      background_jobs_enabled: false,
      background_job_types: ["normalize", "compact", "index_refresh"],
      warnings: []
    },
    index_warnings: [],
    recovery_suggestions: [],
    ...overrides
  };
}

function enabledStatus(overrides: Partial<BoundStatus> = {}): BoundStatus {
  return {
    enabled: true,
    repo: "github.com/team/service",
    root: "C:/work/service",
    branch: "main",
    head_commit: "abc123",
    context_store: "github.com/team/context/contexts/service",
    store_head: null,
    local_store: false,
    summary: emptySummary(),
    ...overrides
  } as BoundStatus;
}

function assertContainsLine(formatted: string, line: string): void {
  assert.ok(formatted.split("\n").includes(line), `expected line "${line}" in:\n${formatted}`);
}

test("formatStatusReport renders disabled status with reason only", () => {
  const formatted = formatStatusReport({
    enabled: false,
    reason: "No teamctx binding found for this git root."
  });

  assert.equal(
    formatted,
    ["teamctx disabled", "  reason: No teamctx binding found for this git root."].join("\n")
  );
});

test("formatStatusReport includes the repo line on disabled status when known", () => {
  const formatted = formatStatusReport({
    enabled: false,
    reason: "No teamctx binding found for this git root.",
    repo: "github.com/team/service"
  });

  assert.equal(
    formatted,
    [
      "teamctx disabled",
      "  repo: github.com/team/service",
      "  reason: No teamctx binding found for this git root."
    ].join("\n")
  );
});

test("formatStatusReport reports the unavailable summary reason", () => {
  const formatted = formatStatusReport(
    enabledStatus({
      summary: null,
      summary_unavailable_reason: "remote store inaccessible"
    })
  );

  const lines = formatted.split("\n");
  assert.equal(lines[0], "teamctx enabled");
  assertContainsLine(formatted, "  summary: remote store inaccessible");
});

test("formatStatusReport renders never as last_normalize when unset", () => {
  const formatted = formatStatusReport(enabledStatus({ summary: emptySummary() }));
  assertContainsLine(formatted, "  last_normalize: never");
  assertContainsLine(
    formatted,
    "  policy: suggested_review candidate_automation=off background_jobs=off"
  );
  assertContainsLine(formatted, "  records: active=0 contested=0 stale=0 archived=0");
});

test("formatStatusReport renders last_normalize details when present", () => {
  const formatted = formatStatusReport(
    enabledStatus({
      summary: emptySummary({
        last_normalize_result: {
          runId: "run-123",
          normalizedAt: "2026-04-22T11:00:00.000Z",
          rawEventsRead: 5,
          recordsWritten: 4,
          droppedEvents: 1,
          auditEntriesWritten: 4
        }
      })
    })
  );

  assertContainsLine(
    formatted,
    "  last_normalize: 2026-04-22T11:00:00.000Z run=run-123 raw=5 promoted=4 dropped=1"
  );
});

test("formatStatusReport renders an active normalize lease line", () => {
  const formatted = formatStatusReport(
    enabledStatus({
      summary: emptySummary({
        normalize_lease: {
          state: "active",
          lease: {
            format_version: 1,
            operation: "normalize",
            lease_id: "lease-1",
            owner: { tool: "teamctx", hostname: "host-1", pid: 4242 },
            created_at: "2026-04-22T10:00:00.000Z",
            expires_at: "2026-04-22T10:05:00.000Z",
            store_revision: null
          }
        }
      })
    })
  );

  assertContainsLine(
    formatted,
    "  normalize_lease: active owner=host-1:4242 expires=2026-04-22T10:05:00.000Z"
  );
});

test("formatStatusReport renders status lists with truncation totals", () => {
  const formatted = formatStatusReport(
    enabledStatus({
      summary: emptySummary({
        counts: {
          ...baseCounts,
          promoted_records: 5,
          contested_records: 1,
          dropped_events: 1,
          stale_records: 1
        },
        recent_promoted_items: [
          {
            item_id: "rule-auth-order",
            promoted_at: "2026-04-22T11:00:00.000Z",
            source_event_ids: ["event-1"],
            record: {
              item_id: "rule-auth-order",
              kind: "rule",
              state: "active",
              text: "auth before tenant",
              scope: { paths: [], domains: [], symbols: [], tags: [] },
              confidence_level: "medium",
              evidence: [],
              conflicts_with: []
            }
          }
        ],
        contested_items: [
          {
            item_id: "rule-conflict",
            kind: "rule",
            state: "contested",
            text: "two competing rules",
            scope: { paths: [], domains: [], symbols: [], tags: [] },
            confidence_level: "medium",
            evidence: [],
            conflicts_with: ["rule-other"],
            competing_items: [
              {
                item_id: "rule-other",
                kind: "rule",
                state: "contested",
                text: "other",
                scope: { paths: [], domains: [], symbols: [], tags: [] },
                confidence_level: "medium",
                evidence: [],
                conflicts_with: []
              }
            ],
            contest_audit_entries: [
              {
                schema_version: 1,
                id: "audit-1",
                action: "contested",
                at: "2026-04-22T10:30:00.000Z",
                item_id: "rule-conflict",
                source_event_ids: ["event-3"],
                reason: "negated assertion"
              }
            ]
          }
        ],
        dropped_items: [
          {
            dropped_at: "2026-04-22T10:31:00.000Z",
            source_event_ids: ["event-2"],
            reason: "no evidence"
          }
        ],
        stale_items: [
          {
            item_id: "rule-stale",
            kind: "rule",
            state: "stale",
            text: "stale rule",
            scope: { paths: [], domains: [], symbols: [], tags: [] },
            confidence_level: "low",
            evidence: [],
            conflicts_with: []
          }
        ]
      })
    })
  );

  assertContainsLine(formatted, "  recent_promoted: 1 of 5 shown");
  assertContainsLine(formatted, "    - rule-auth-order: auth before tenant");
  assertContainsLine(
    formatted,
    "    - rule-conflict: two competing rules | conflicts_with=rule-other | reason=negated assertion"
  );
  assertContainsLine(formatted, "    - event-2: no evidence");
  assertContainsLine(formatted, "    - rule-stale: stale rule");
});

test("formatStatusReport falls back to (unknown event) for dropped items without ids", () => {
  const formatted = formatStatusReport(
    enabledStatus({
      summary: emptySummary({
        counts: { ...baseCounts, dropped_events: 1 },
        dropped_items: [
          {
            dropped_at: "2026-04-22T10:31:00.000Z",
            source_event_ids: [],
            reason: "validation failed"
          }
        ]
      })
    })
  );

  assertContainsLine(formatted, "    - (unknown event): validation failed");
});

test("formatStatusReport renders index warnings and recovery suggestions when present", () => {
  const formatted = formatStatusReport(
    enabledStatus({
      summary: emptySummary({
        index_warnings: ["path-index missing", "text-index stale"],
        recovery_suggestions: ["run teamctx normalize"]
      })
    })
  );

  assertContainsLine(formatted, "  index_warnings:");
  assertContainsLine(formatted, "    - path-index missing");
  assertContainsLine(formatted, "    - text-index stale");
  assertContainsLine(formatted, "  recovery:");
  assertContainsLine(formatted, "    - run teamctx normalize");
});
