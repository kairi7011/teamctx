import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  summarizeContextStoreHygiene,
  summarizeRecordsHygiene
} from "../../src/core/hygiene/report.js";
import type { NormalizedRecord } from "../../src/schemas/normalized-record.js";
import { fixtureNormalizedRecord } from "../fixtures/normalized-record.js";

test("summarizeRecordsHygiene flags long-term active context rot risks", () => {
  const unverified = record("unverified");
  delete unverified.last_verified_at;

  const records: NormalizedRecord[] = [
    record("expired", {
      valid_until: "2026-03-01T00:00:00.000Z",
      last_verified_at: "2026-02-01T00:00:00.000Z"
    }),
    record("future", {
      valid_from: "2026-06-01T00:00:00.000Z",
      last_verified_at: "2026-04-01T00:00:00.000Z"
    }),
    record("old", {
      last_verified_at: "2025-12-01T00:00:00.000Z"
    }),
    unverified,
    record("duplicate-a", {
      text: "Use the shared cache helper for tenant state."
    }),
    record("duplicate-b", {
      text: "Use the shared cache helper for tenant state."
    }),
    ...Array.from({ length: 4 }, (_, index) =>
      record(`crowded-${index}`, {
        kind: "rule",
        text: `Crowded scoped rule ${index}.`,
        scope: commonScope()
      })
    ),
    record("large", {
      text: `${"alpha ".repeat(260)}omega`
    }),
    record("stale-old", {
      state: "stale",
      last_verified_at: "2025-01-01T00:00:00.000Z"
    })
  ];

  const report = summarizeRecordsHygiene(records, {
    now: () => new Date("2026-05-04T00:00:00.000Z"),
    olderThanDays: 90,
    largeRecordTokens: 250,
    limit: 50
  });

  assert.equal(report.counts.total_records, 12);
  assert.equal(report.counts.active_records, 11);
  assert.equal(report.counts.inactive_records, 1);
  assert.equal(report.counts.expired_active_records, 1);
  assert.equal(report.counts.not_yet_valid_active_records, 1);
  assert.equal(report.counts.old_active_records, 2);
  assert.equal(report.counts.unverified_active_records, 1);
  assert.equal(report.counts.duplicate_active_text_records, 2);
  assert.equal(report.counts.crowded_active_scope_records, 4);
  assert.equal(report.counts.large_active_records, 1);
  assert.equal(report.risk_items[0]?.risk, "expired_active");
  assert.ok(
    report.recovery_suggestions.some((suggestion) => suggestion.includes("validity-window"))
  );
  assert.equal(
    report.risk_items.some((item) => item.id === "stale-old"),
    false,
    "inactive records should not be reported as active context rot"
  );
});

test("summarizeContextStoreHygiene reads normalized records from store shards", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "teamctx-hygiene-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const storeRoot = join(directory, ".teamctx");

  writeRecord(
    storeRoot,
    "facts.jsonl",
    record("old-fact", {
      kind: "fact",
      last_verified_at: "2025-12-01T00:00:00.000Z"
    })
  );

  const report = summarizeContextStoreHygiene({
    storeRoot,
    now: () => new Date("2026-05-04T00:00:00.000Z"),
    olderThanDays: 90
  });

  assert.equal(report.counts.total_records, 1);
  assert.equal(report.counts.old_active_records, 1);
  assert.equal(report.risk_items[0]?.id, "old-fact");
});

function record(id: string, overrides: Partial<NormalizedRecord> = {}): NormalizedRecord {
  return fixtureNormalizedRecord({
    id,
    text: `${id} text`,
    scope: {
      paths: [`src/${id}/**`],
      domains: [id],
      symbols: [`${id}Symbol`],
      tags: []
    },
    last_verified_at: "2026-04-22T11:00:00.000Z",
    ...overrides
  });
}

function commonScope(): NormalizedRecord["scope"] {
  return {
    paths: ["src/shared/**"],
    domains: ["shared"],
    symbols: ["SharedCache"],
    tags: ["cache"]
  };
}

function writeRecord(storeRoot: string, file: string, normalizedRecord: NormalizedRecord): void {
  const directory = join(storeRoot, "normalized");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, file), `${JSON.stringify(normalizedRecord)}\n`, {
    flag: "a",
    encoding: "utf8"
  });
}
