import assert from "node:assert/strict";
import test from "node:test";
import { formatShowRecord } from "../../src/core/show/record.js";
import type { ExplainItemResult } from "../../src/core/audit/control.js";

test("formatShowRecord renders a human-readable normalized record", () => {
  const output = formatShowRecord(recordResult());

  assert.match(output, /^pitfall-auth-order\n/);
  assert.match(output, / {2}kind: pitfall/);
  assert.match(output, / {2}confidence: medium \(0\.65\)/);
  assert.match(output, / {2}paths: src\/auth\/\*\*/);
  assert.match(
    output,
    / {2}evidence:\n {4}- code \| github.com\/team\/service \| src\/auth\/middleware.ts \| lines 4-12 \| commit abc123/
  );
  assert.match(
    output,
    / {2}audit:\n {4}- 2026-04-22T11:00:00.000Z \| created \| none -> active \| evidence minimum check passed \| run run-1/
  );
});

test("formatShowRecord renders missing items clearly", () => {
  assert.equal(
    formatShowRecord({ found: false, item_id: "missing-record" }),
    "Context item not found: missing-record"
  );
});

function recordResult(): ExplainItemResult {
  return {
    found: true,
    record: {
      id: "pitfall-auth-order",
      schema_version: 1,
      normalizer_version: "0.1.0",
      kind: "pitfall",
      state: "active",
      text: "Auth middleware must run before tenant resolution.",
      scope: {
        paths: ["src/auth/**"],
        domains: ["auth"],
        symbols: ["AuthMiddleware"],
        tags: ["middleware"]
      },
      evidence: [
        {
          kind: "code",
          repo: "github.com/team/service",
          commit: "abc123",
          file: "src/auth/middleware.ts",
          lines: [4, 12]
        }
      ],
      provenance: {
        recorded_by: "codex",
        session_id: "session-1",
        observed_at: "2026-04-22T10:00:00.000Z"
      },
      confidence_level: "medium",
      confidence_score: 0.65,
      last_verified_at: "2026-04-22T11:00:00.000Z",
      supersedes: [],
      conflicts_with: []
    },
    audit_entries: [
      {
        schema_version: 1,
        id: "audit-1",
        at: "2026-04-22T11:00:00.000Z",
        action: "created",
        item_id: "pitfall-auth-order",
        after_state: "active",
        reason: "evidence minimum check passed",
        source_event_ids: ["event-1"],
        run_id: "run-1"
      }
    ]
  };
}
