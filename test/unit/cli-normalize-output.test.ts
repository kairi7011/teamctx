import assert from "node:assert/strict";
import test from "node:test";
import { formatNormalizeResult } from "../../src/cli/index.js";

const result = {
  runId: "run-1234",
  normalizedAt: "2026-04-22T11:00:00.000Z",
  rawEventsRead: 2,
  recordsWritten: 1,
  droppedEvents: 0,
  auditEntriesWritten: 1
};

test("formatNormalizeResult renders the normal summary", () => {
  assert.equal(
    formatNormalizeResult(result),
    [
      "Normalized context store:",
      "  run_id: run-1234",
      "  normalized_at: 2026-04-22T11:00:00.000Z",
      "  raw_events_read: 2",
      "  records_written: 1",
      "  dropped_events: 0",
      "  audit_entries_written: 1"
    ].join("\n")
  );
});

test("formatNormalizeResult renders dry-run and lease notes", () => {
  assert.match(
    formatNormalizeResult(result, { dryRun: true }),
    /note: no files were written; rerun without --dry-run to apply/
  );
  assert.match(formatNormalizeResult(result, { useLease: true }), /lease: acquired and released/);
  assert.doesNotMatch(
    formatNormalizeResult(result, { dryRun: true, useLease: true }),
    /lease: acquired and released/
  );
});
