import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getBoundStatus, type BoundStatusServices } from "../../src/core/status/status.js";
import { summarizeContextStore } from "../../src/core/status/summary.js";
import { statusTool } from "../../src/mcp/tools/status.js";
import type { AuditLogEntry } from "../../src/schemas/audit.js";
import type { NormalizedRecord, RecordState } from "../../src/schemas/normalized-record.js";
import type { Binding } from "../../src/schemas/types.js";

function tempDirectory(): { directory: string; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "teamctx-status-"));

  return {
    directory,
    cleanup: () => rmSync(directory, { recursive: true, force: true })
  };
}

test("summarizeContextStore returns local status buckets and last normalize result", (context) => {
  const { directory, cleanup } = tempDirectory();
  context.after(cleanup);
  const storeRoot = join(directory, ".teamctx");

  writeRecord(storeRoot, record("pitfall-auth-order", "active"));
  writeRecord(storeRoot, record("pitfall-old-cache", "stale"));
  writeRecord(
    storeRoot,
    record("pitfall-token-refresh", "contested", ["pitfall-token-refresh-alt"])
  );
  writeRecord(
    storeRoot,
    record("pitfall-token-refresh-alt", "contested", ["pitfall-token-refresh"])
  );
  writeAudit(storeRoot, [
    auditEntry({
      id: "audit-1",
      at: "2026-04-22T11:00:00.000Z",
      action: "created",
      itemId: "pitfall-auth-order"
    }),
    auditEntry({
      id: "audit-2",
      at: "2026-04-22T11:01:00.000Z",
      action: "dropped",
      reason: "evidence minimum check failed",
      sourceEventIds: ["event-dropped"]
    }),
    auditEntry({
      id: "audit-3",
      at: "2026-04-22T11:02:00.000Z",
      action: "contested",
      itemId: "pitfall-token-refresh",
      reason: "conflicting same-scope assertion detected",
      sourceEventIds: ["file:src/auth/middleware.ts"]
    })
  ]);
  writeLastNormalize(storeRoot);

  const summary = summarizeContextStore({ storeRoot });

  assert.equal(summary.last_normalize_result?.normalizedAt, "2026-04-22T11:02:00.000Z");
  assert.equal(summary.counts.total_records, 4);
  assert.equal(summary.counts.active_records, 1);
  assert.equal(summary.counts.contested_records, 2);
  assert.equal(summary.counts.stale_records, 1);
  assert.equal(summary.counts.promoted_records, 1);
  assert.equal(summary.counts.dropped_events, 1);
  assert.equal(summary.recent_promoted_items[0]?.item_id, "pitfall-auth-order");
  assert.equal(
    summary.recent_promoted_items[0]?.record?.text,
    "Auth middleware must run before tenant resolution."
  );
  assert.equal(summary.dropped_items[0]?.reason, "evidence minimum check failed");
  assert.equal(summary.stale_items[0]?.item_id, "pitfall-old-cache");
  assert.equal(summary.contested_items[0]?.item_id, "pitfall-token-refresh");
  assert.equal(
    summary.contested_items[0]?.competing_items[0]?.item_id,
    "pitfall-token-refresh-alt"
  );
  assert.equal(
    summary.contested_items[0]?.contest_audit_entries[0]?.reason,
    "conflicting same-scope assertion detected"
  );
  assert.equal(summary.contested_items[0]?.evidence[0]?.kind, "code");
});

test("getBoundStatus and statusTool include local store summaries", (context) => {
  const { directory, cleanup } = tempDirectory();
  context.after(cleanup);
  const storeRoot = join(directory, ".teamctx");
  writeRecord(storeRoot, record("pitfall-auth-order", "active"));

  const services = servicesFor(directory);
  const status = getBoundStatus({ services });

  assert.equal(status.enabled, true);

  if (!status.enabled) {
    throw new Error("expected enabled status");
  }

  assert.equal(status.local_store, true);
  assert.equal(status.summary?.counts.active_records, 1);

  const toolStatus = statusTool({}, services) as { enabled: boolean; summary?: unknown };
  assert.equal(toolStatus.enabled, true);
  assert.ok(toolStatus.summary);
});

function writeRecord(storeRoot: string, normalizedRecord: NormalizedRecord): void {
  const directory = join(storeRoot, "normalized");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "pitfalls.jsonl"), `${JSON.stringify(normalizedRecord)}\n`, {
    flag: "a",
    encoding: "utf8"
  });
}

function writeAudit(storeRoot: string, entries: AuditLogEntry[]): void {
  const directory = join(storeRoot, "audit");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "changes.jsonl"),
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8"
  );
}

function writeLastNormalize(storeRoot: string): void {
  const directory = join(storeRoot, "indexes");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "last-normalize.json"),
    `${JSON.stringify(
      {
        normalizedAt: "2026-04-22T11:02:00.000Z",
        rawEventsRead: 2,
        recordsWritten: 1,
        droppedEvents: 1,
        auditEntriesWritten: 2
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

function record(id: string, state: RecordState, conflictsWith: string[] = []): NormalizedRecord {
  return {
    id,
    schema_version: 1,
    normalizer_version: "0.1.0",
    kind: "pitfall",
    state,
    text: textFor(id),
    scope: {
      paths: ["src/auth/**"],
      domains: ["auth"],
      symbols: ["AuthMiddleware"],
      tags: []
    },
    evidence: [
      {
        kind: "code",
        repo: "github.com/team/service",
        commit: "abc123",
        file: "src/auth/middleware.ts"
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
    conflicts_with: conflictsWith
  };
}

function textFor(id: string): string {
  if (id === "pitfall-old-cache") {
    return "Legacy cache keys are stale after tenant migration.";
  }

  if (id === "pitfall-token-refresh") {
    return "Token refresh behavior has conflicting evidence.";
  }

  if (id === "pitfall-token-refresh-alt") {
    return "Token refresh must use the legacy cache path.";
  }

  return "Auth middleware must run before tenant resolution.";
}

function auditEntry(options: {
  id: string;
  at: string;
  action: AuditLogEntry["action"];
  itemId?: string;
  reason?: string;
  sourceEventIds?: string[];
}): AuditLogEntry {
  const entry: AuditLogEntry = {
    schema_version: 1,
    id: options.id,
    at: options.at,
    action: options.action,
    source_event_ids: options.sourceEventIds ?? ["event-1"]
  };

  if (options.itemId !== undefined) {
    entry.item_id = options.itemId;
  }

  if (options.action === "created") {
    entry.after_state = "active";
  }

  if (options.reason !== undefined) {
    entry.reason = options.reason;
  }

  return entry;
}

function servicesFor(root: string): BoundStatusServices {
  const binding: Binding = {
    repo: "github.com/team/service",
    root,
    contextStore: {
      provider: "github",
      repo: "github.com/team/service",
      path: ".teamctx"
    },
    createdAt: "2026-04-22T10:00:00.000Z"
  };

  return {
    getRepoRoot: () => root,
    getOriginRemote: () => "git@github.com:team/service.git",
    getCurrentBranch: () => "main",
    getHeadCommit: () => "abc123",
    findBinding: () => binding
  };
}
