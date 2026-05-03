import assert from "node:assert/strict";
import test from "node:test";
import { formatCompactResult } from "../../src/cli/index.js";

const result = {
  compactedAt: "2026-04-22T11:00:00.000Z",
  storeRoot: "C:/work/service/.teamctx",
  archiveRoot: "C:/work/service/.teamctx/archive/2026-04-22",
  rawCandidateEventsArchived: 4,
  rawEventsRetained: 12,
  auditEntriesArchived: 2,
  auditEntriesRetained: 18,
  archivedRecordsArchived: 1,
  normalizedRecordsRetained: 23
};

test("formatCompactResult renders the normal summary", () => {
  assert.equal(
    formatCompactResult(result),
    [
      "Compacted context store:",
      "  compacted_at: 2026-04-22T11:00:00.000Z",
      "  archive_root: C:/work/service/.teamctx/archive/2026-04-22",
      "  raw_candidate_events_archived: 4",
      "  raw_events_retained: 12",
      "  audit_entries_archived: 2",
      "  audit_entries_retained: 18",
      "  archived_records_archived: 1",
      "  normalized_records_retained: 23"
    ].join("\n")
  );
});

test("formatCompactResult renders the dry-run header and note", () => {
  const formatted = formatCompactResult(result, { dryRun: true });
  assert.match(formatted, /^Compacted context store \(dry-run\):/);
  assert.match(formatted, /note: no files were archived; rerun without --dry-run to apply$/m);
});

test("formatCompactResult omits the dry-run note for normal runs", () => {
  assert.doesNotMatch(formatCompactResult(result), /no files were archived/);
});
