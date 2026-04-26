import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalContextStore } from "../../src/adapters/store/local-store.js";
import {
  compactBoundStoreAsync,
  compactBoundStore,
  compactContextStore,
  compactStore,
  type CompactServices
} from "../../src/core/retention/compact.js";
import { serializeProjectConfig, type ProjectConfig } from "../../src/schemas/project.js";
import type { AuditLogEntry } from "../../src/schemas/audit.js";
import type { NormalizedRecord } from "../../src/schemas/normalized-record.js";
import type { RawObservation } from "../../src/schemas/observation.js";
import type { Binding } from "../../src/schemas/types.js";

function tempDirectory(): { directory: string; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "teamctx-compact-"));

  return {
    directory,
    cleanup: () => rmSync(directory, { recursive: true, force: true })
  };
}

test("compactStore archives expired local retention targets", (context) => {
  const { directory, cleanup } = tempDirectory();
  context.after(cleanup);
  const storeRoot = join(directory, ".teamctx");
  writeProject(storeRoot);
  writeRaw(storeRoot, observation("candidate-old", "candidate", "2026-04-19T10:00:00.000Z"));
  writeRaw(storeRoot, observation("verified-old", "verified", "2026-04-19T10:00:00.000Z"));
  writeAudit(storeRoot, [
    auditEntry("audit-old", "2026-04-19T10:00:00.000Z"),
    auditEntry("audit-new", "2026-04-22T10:00:00.000Z")
  ]);
  writeRecords(storeRoot, [
    record("pitfall-archived", "archived"),
    record("pitfall-active", "active")
  ]);

  const result = compactStore({
    storeRoot,
    now: () => new Date("2026-04-22T12:00:00.000Z")
  });

  assert.equal(result.rawCandidateEventsArchived, 1);
  assert.equal(result.rawEventsRetained, 1);
  assert.equal(result.auditEntriesArchived, 1);
  assert.equal(result.auditEntriesRetained, 1);
  assert.equal(result.archivedRecordsArchived, 1);
  assert.equal(result.normalizedRecordsRetained, 1);
  assert.equal(
    existsSync(
      join(storeRoot, "archive", "raw", "events", "2026-04-19", "session-1-candidate-old.json")
    ),
    true
  );
  assert.equal(
    existsSync(join(storeRoot, "raw", "events", "2026-04-19", "session-1-verified-old.json")),
    true
  );

  const retainedAudit = readJsonl(join(storeRoot, "audit", "changes.jsonl"));
  assert.equal(retainedAudit.length, 1);
  assert.equal(retainedAudit[0]?.id, "audit-new");
  assert.equal(
    readJsonl(join(storeRoot, "archive", "audit", "changes-20260422T120000.000Z.jsonl"))[0]?.id,
    "audit-old"
  );

  const retainedRecords = readJsonl(join(storeRoot, "normalized", "pitfalls.jsonl"));
  assert.equal(retainedRecords.length, 1);
  assert.equal(retainedRecords[0]?.id, "pitfall-active");
  assert.equal(
    readJsonl(join(storeRoot, "archive", "normalized", "pitfalls.jsonl"))[0]?.id,
    "pitfall-archived"
  );
});

test("compactStore dryRun reports planned archives without touching the store", (context) => {
  const { directory, cleanup } = tempDirectory();
  context.after(cleanup);
  const storeRoot = join(directory, ".teamctx");
  writeProject(storeRoot);
  writeRaw(storeRoot, observation("candidate-old", "candidate", "2026-04-19T10:00:00.000Z"));
  writeAudit(storeRoot, [auditEntry("audit-old", "2026-04-19T10:00:00.000Z")]);
  writeRecords(storeRoot, [record("pitfall-archived", "archived")]);

  const result = compactStore({
    storeRoot,
    now: () => new Date("2026-04-22T12:00:00.000Z"),
    dryRun: true
  });

  assert.equal(result.rawCandidateEventsArchived, 1);
  assert.equal(result.auditEntriesArchived, 1);
  assert.equal(result.archivedRecordsArchived, 1);
  // Source files should remain in place because dry-run skips writes.
  assert.equal(
    existsSync(join(storeRoot, "raw", "events", "2026-04-19", "session-1-candidate-old.json")),
    true
  );
  assert.equal(
    existsSync(
      join(storeRoot, "archive", "raw", "events", "2026-04-19", "session-1-candidate-old.json")
    ),
    false
  );
  const retainedAudit = readJsonl(join(storeRoot, "audit", "changes.jsonl"));
  assert.equal(retainedAudit.length, 1);
  assert.equal(retainedAudit[0]?.id, "audit-old");
  assert.equal(existsSync(join(storeRoot, "archive", "audit")), false);
});

test("compactBoundStore resolves the same-repository binding", (context) => {
  const { directory, cleanup } = tempDirectory();
  context.after(cleanup);
  const storeRoot = join(directory, ".teamctx");
  writeProject(storeRoot);

  const result = compactBoundStore({
    services: servicesFor(directory),
    now: () => new Date("2026-04-22T12:00:00.000Z")
  });

  assert.equal(result.storeRoot, storeRoot);
});

test("compactContextStore archives expired adapter-backed retention targets", async (context) => {
  const { directory, cleanup } = tempDirectory();
  context.after(cleanup);
  const storeRoot = join(directory, "remote-store");
  writeProject(storeRoot);
  writeRaw(storeRoot, observation("candidate-old", "candidate", "2026-04-19T10:00:00.000Z"));
  writeRaw(storeRoot, observation("verified-old", "verified", "2026-04-19T10:00:00.000Z"));
  writeAudit(storeRoot, [
    auditEntry("audit-old", "2026-04-19T10:00:00.000Z"),
    auditEntry("audit-new", "2026-04-22T10:00:00.000Z")
  ]);
  writeRecords(storeRoot, [
    record("pitfall-archived", "archived"),
    record("pitfall-active", "active")
  ]);

  const result = await compactContextStore({
    store: new LocalContextStore(storeRoot),
    storeRoot: "github.com/team/context/contexts/service",
    now: () => new Date("2026-04-22T12:00:00.000Z")
  });

  assert.equal(result.rawCandidateEventsArchived, 1);
  assert.equal(result.rawEventsRetained, 1);
  assert.equal(result.auditEntriesArchived, 1);
  assert.equal(result.auditEntriesRetained, 1);
  assert.equal(result.archivedRecordsArchived, 1);
  assert.equal(result.normalizedRecordsRetained, 1);
  assert.equal(
    existsSync(
      join(storeRoot, "archive", "raw", "events", "2026-04-19", "session-1-candidate-old.json")
    ),
    true
  );
  assert.equal(
    existsSync(join(storeRoot, "raw", "events", "2026-04-19", "session-1-candidate-old.json")),
    false
  );
  assert.equal(
    readJsonl(join(storeRoot, "archive", "audit", "changes-20260422T120000.000Z.jsonl"))[0]?.id,
    "audit-old"
  );
  assert.equal(
    readJsonl(join(storeRoot, "archive", "normalized", "pitfalls.jsonl"))[0]?.id,
    "pitfall-archived"
  );
});

test("compactBoundStoreAsync resolves remote context store adapters", async (context) => {
  const { directory, cleanup } = tempDirectory();
  context.after(cleanup);
  const remoteRoot = join(directory, "remote-store");
  writeProject(remoteRoot);

  const result = await compactBoundStoreAsync({
    services: remoteServicesFor(directory, remoteRoot),
    now: () => new Date("2026-04-22T12:00:00.000Z")
  });

  assert.equal(result.storeRoot, "github.com/team/context/contexts/service");
});

function writeProject(storeRoot: string): void {
  mkdirSync(storeRoot, { recursive: true });
  writeFileSync(
    join(storeRoot, "project.yaml"),
    serializeProjectConfig({
      format_version: 1,
      project_id: "github.com/team/service",
      normalizer_version: "0.1.0",
      retention: {
        raw_candidate_days: 1,
        audit_days: 1,
        archive_path: "archive/"
      }
    } satisfies ProjectConfig),
    "utf8"
  );
}

function writeRaw(storeRoot: string, rawObservation: RawObservation): void {
  const directory = join(storeRoot, "raw", "events", rawObservation.observed_at.slice(0, 10));
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, `${rawObservation.session_id}-${rawObservation.event_id}.json`),
    `${JSON.stringify(rawObservation)}\n`,
    "utf8"
  );
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

function writeRecords(storeRoot: string, records: NormalizedRecord[]): void {
  const directory = join(storeRoot, "normalized");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "pitfalls.jsonl"),
    `${records.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8"
  );
}

function observation(
  eventId: string,
  trust: RawObservation["trust"],
  observedAt: string
): RawObservation {
  return {
    schema_version: 1,
    event_id: eventId,
    session_id: "session-1",
    observed_at: observedAt,
    recorded_by: "codex",
    trust,
    kind: "pitfall",
    text: "Auth middleware must run before tenant resolution.",
    source_type: trust === "verified" ? "inferred_from_code" : "manual_assertion",
    evidence:
      trust === "verified"
        ? [
            {
              kind: "code",
              repo: "github.com/team/service",
              commit: "abc123",
              file: "src/auth/middleware.ts"
            }
          ]
        : [],
    supersedes: []
  };
}

function auditEntry(id: string, at: string): AuditLogEntry {
  return {
    schema_version: 1,
    id,
    at,
    action: "created",
    item_id: "pitfall-active",
    after_state: "active",
    reason: "evidence minimum check passed",
    source_event_ids: ["event-1"]
  };
}

function record(id: string, state: NormalizedRecord["state"]): NormalizedRecord {
  return {
    id,
    schema_version: 1,
    normalizer_version: "0.1.0",
    kind: "pitfall",
    state,
    text: "Auth middleware must run before tenant resolution.",
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
      observed_at: "2026-04-19T10:00:00.000Z"
    },
    confidence_level: "medium",
    confidence_score: 0.65,
    last_verified_at: "2026-04-19T11:00:00.000Z",
    supersedes: [],
    conflicts_with: []
  };
}

function servicesFor(root: string): CompactServices {
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
    findBinding: () => binding
  };
}

function remoteServicesFor(root: string, remoteStoreRoot: string): CompactServices {
  const binding: Binding = {
    repo: "github.com/team/service",
    root,
    contextStore: {
      provider: "github",
      repo: "github.com/team/context",
      path: "contexts/service"
    },
    createdAt: "2026-04-22T10:00:00.000Z"
  };

  return {
    getRepoRoot: () => root,
    getOriginRemote: () => "git@github.com:team/service.git",
    findBinding: () => binding,
    createContextStore: () => new LocalContextStore(remoteStoreRoot)
  };
}

function readJsonl(path: string): Array<Record<string, unknown>> {
  const content = readFileSync(path, "utf8").trim();

  if (content.length === 0) {
    return [];
  }

  return content.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}
