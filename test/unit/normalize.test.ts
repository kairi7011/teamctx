import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  normalizeBoundStore,
  normalizeBoundStoreAsync,
  normalizeStore,
  type NormalizeServices
} from "../../src/core/normalize/normalize.js";
import { LocalContextStore } from "../../src/adapters/store/local-store.js";
import { normalizeTool } from "../../src/mcp/tools/normalize.js";
import type { NormalizedRecord } from "../../src/schemas/normalized-record.js";
import type { RawObservation } from "../../src/schemas/observation.js";
import type { Binding } from "../../src/schemas/types.js";

function tempDirectory(): { directory: string; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "teamctx-normalize-"));

  return {
    directory,
    cleanup: () => rmSync(directory, { recursive: true, force: true })
  };
}

function writeRaw(storeRoot: string, observation: RawObservation): void {
  const date = observation.observed_at.slice(0, 10);
  const directory = join(storeRoot, "raw", "events", date);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, `${observation.session_id}-${observation.event_id}.json`),
    `${JSON.stringify(observation, null, 2)}\n`,
    "utf8"
  );
}

function observation(overrides: Partial<RawObservation> = {}): RawObservation {
  return {
    schema_version: 1,
    event_id: "event-1",
    session_id: "session-1",
    observed_at: "2026-04-22T10:00:00.000Z",
    recorded_by: "codex",
    trust: "verified",
    kind: "pitfall",
    text: "Auth middleware must run before tenant resolution.",
    source_type: "inferred_from_code",
    evidence: [
      {
        kind: "code",
        repo: "github.com/team/service",
        commit: "abc123",
        file: "src/auth/middleware.ts",
        lines: [10, 34]
      }
    ],
    scope: {
      paths: ["src/auth/**"],
      domains: ["auth"],
      symbols: ["AuthMiddleware"],
      tags: ["request-lifecycle"]
    },
    supersedes: [],
    ...overrides
  };
}

function fixedNow(): Date {
  return new Date("2026-04-22T11:00:00.000Z");
}

test("normalizeStore promotes verified raw events into normalized JSONL", (context) => {
  const { directory, cleanup } = tempDirectory();
  context.after(cleanup);
  const storeRoot = join(directory, ".teamctx");
  writeRaw(storeRoot, observation());

  const result = normalizeStore({
    repo: "github.com/team/service",
    storeRoot,
    now: fixedNow
  });

  assert.deepEqual(result, {
    normalizedAt: "2026-04-22T11:00:00.000Z",
    rawEventsRead: 1,
    recordsWritten: 1,
    droppedEvents: 0,
    auditEntriesWritten: 1
  });

  const records = readJsonl(join(storeRoot, "normalized", "pitfalls.jsonl"));
  assert.equal(records.length, 1);
  assert.equal(records[0]?.state, "active");
  assert.equal(records[0]?.confidence_level, "medium");
  assert.equal(records[0]?.confidence_score, 0.65);
  assert.equal(records[0]?.last_verified_at, "2026-04-22T11:00:00.000Z");
  assert.equal(records[0]?.valid_from, "2026-04-22T10:00:00.000Z");

  const audit = readJsonl(join(storeRoot, "audit", "changes.jsonl"));
  assert.equal(audit[0]?.action, "created");
  assert.equal(audit[0]?.after_state, "active");
  assert.deepEqual(audit[0]?.source_event_ids, ["event-1"]);

  assert.deepEqual(
    JSON.parse(readFileSync(join(storeRoot, "indexes", "last-normalize.json"), "utf8")),
    {
      normalizedAt: "2026-04-22T11:00:00.000Z",
      rawEventsRead: 1,
      recordsWritten: 1,
      droppedEvents: 0,
      auditEntriesWritten: 1
    }
  );

  const pathIndex = JSON.parse(
    readFileSync(join(storeRoot, "indexes", "path-index.json"), "utf8")
  ) as {
    paths: Record<string, string[]>;
    domains: Record<string, string[]>;
    tags: Record<string, string[]>;
    kinds: Record<string, string[]>;
    states: Record<string, string[]>;
  };
  const symbolIndex = JSON.parse(
    readFileSync(join(storeRoot, "indexes", "symbol-index.json"), "utf8")
  ) as {
    symbols: Record<string, string[]>;
  };
  const textIndex = JSON.parse(
    readFileSync(join(storeRoot, "indexes", "text-index.json"), "utf8")
  ) as {
    tokens: Record<string, string[]>;
  };
  const episodeIndex = JSON.parse(
    readFileSync(join(storeRoot, "indexes", "episode-index.json"), "utf8")
  ) as {
    episodes: Array<{
      source_event_ids: string[];
      summary: string;
      scope: { paths: string[] };
    }>;
    paths: Record<string, string[]>;
  };
  const recordId = records[0]?.id as string;
  const episodeId = episodeIndex.episodes[0]?.source_event_ids[0];

  assert.deepEqual(pathIndex.paths["src/auth/**"], [recordId]);
  assert.deepEqual(pathIndex.domains.auth, [recordId]);
  assert.deepEqual(pathIndex.tags["request-lifecycle"], [recordId]);
  assert.deepEqual(pathIndex.kinds.pitfall, [recordId]);
  assert.deepEqual(pathIndex.states.active, [recordId]);
  assert.deepEqual(symbolIndex.symbols.AuthMiddleware, [recordId]);
  assert.deepEqual(textIndex.tokens.auth, [recordId]);
  assert.deepEqual(textIndex.tokens.middleware, [recordId]);
  assert.equal(
    episodeIndex.episodes[0]?.summary,
    "Auth middleware must run before tenant resolution."
  );
  assert.deepEqual(episodeIndex.episodes[0]?.scope.paths, ["src/auth/**"]);
  assert.equal(episodeId, "event-1");
});

test("normalizeStore drops raw events that fail evidence minimum", (context) => {
  const { directory, cleanup } = tempDirectory();
  context.after(cleanup);
  const storeRoot = join(directory, ".teamctx");
  writeRaw(
    storeRoot,
    observation({
      trust: "candidate",
      source_type: "manual_assertion",
      evidence: []
    })
  );

  const result = normalizeStore({
    repo: "github.com/team/service",
    storeRoot,
    now: fixedNow
  });

  assert.equal(result.recordsWritten, 0);
  assert.equal(result.droppedEvents, 1);
  assert.equal(readFileSync(join(storeRoot, "normalized", "pitfalls.jsonl"), "utf8"), "");

  const audit = readJsonl(join(storeRoot, "audit", "changes.jsonl"));
  assert.equal(audit[0]?.action, "dropped");
  assert.equal(audit[0]?.reason, "evidence minimum check failed");
});

test("normalizeStore exact-dedupes matching records", (context) => {
  const { directory, cleanup } = tempDirectory();
  context.after(cleanup);
  const storeRoot = join(directory, ".teamctx");
  writeRaw(storeRoot, observation());
  writeRaw(
    storeRoot,
    observation({
      event_id: "event-2"
    })
  );

  const result = normalizeStore({
    repo: "github.com/team/service",
    storeRoot,
    now: fixedNow
  });

  assert.equal(result.rawEventsRead, 2);
  assert.equal(result.recordsWritten, 1);
  assert.equal(readJsonl(join(storeRoot, "normalized", "pitfalls.jsonl")).length, 1);
});

test("normalizeStore near-dedupes punctuation-only text variants", (context) => {
  const { directory, cleanup } = tempDirectory();
  context.after(cleanup);
  const storeRoot = join(directory, ".teamctx");
  writeRaw(storeRoot, observation());
  writeRaw(
    storeRoot,
    observation({
      event_id: "event-2",
      text: "Auth middleware must run before tenant resolution!"
    })
  );

  const result = normalizeStore({
    repo: "github.com/team/service",
    storeRoot,
    now: fixedNow
  });

  assert.equal(result.rawEventsRead, 2);
  assert.equal(result.recordsWritten, 1);
  assert.equal(readJsonl(join(storeRoot, "normalized", "pitfalls.jsonl")).length, 1);
});

test("normalizeStore near-dedupes modal wording variants", (context) => {
  const { directory, cleanup } = tempDirectory();
  context.after(cleanup);
  const storeRoot = join(directory, ".teamctx");
  writeRaw(storeRoot, observation());
  writeRaw(
    storeRoot,
    observation({
      event_id: "event-2",
      text: "Auth middleware should execute before tenant resolution."
    })
  );

  const result = normalizeStore({
    repo: "github.com/team/service",
    storeRoot,
    now: fixedNow
  });

  assert.equal(result.rawEventsRead, 2);
  assert.equal(result.recordsWritten, 1);
  assert.equal(readJsonl(join(storeRoot, "normalized", "pitfalls.jsonl")).length, 1);
});

test("normalizeStore preserves archived states across subsequent runs", (context) => {
  const { directory, cleanup } = tempDirectory();
  context.after(cleanup);
  const storeRoot = join(directory, ".teamctx");
  writeRaw(storeRoot, observation());

  normalizeStore({
    repo: "github.com/team/service",
    storeRoot,
    now: fixedNow
  });

  const [activeRecord] = readJsonl(join(storeRoot, "normalized", "pitfalls.jsonl"));

  if (!activeRecord) {
    throw new Error("expected normalized record");
  }

  writeNormalizedRecord(storeRoot, {
    ...(activeRecord as unknown as NormalizedRecord),
    state: "archived"
  });

  const result = normalizeStore({
    repo: "github.com/team/service",
    storeRoot,
    now: fixedNow
  });

  assert.equal(result.auditEntriesWritten, 0);
  assert.equal(readJsonl(join(storeRoot, "normalized", "pitfalls.jsonl"))[0]?.state, "archived");
  assert.equal(readJsonl(join(storeRoot, "audit", "changes.jsonl")).length, 1);
});

test("normalizeStore marks active records stale when all file evidence is missing", (context) => {
  const { directory, cleanup } = tempDirectory();
  context.after(cleanup);
  const storeRoot = join(directory, ".teamctx");
  writeRaw(storeRoot, observation());

  const result = normalizeStore({
    repo: "github.com/team/service",
    repoRoot: directory,
    storeRoot,
    now: fixedNow
  });

  assert.equal(result.recordsWritten, 1);
  assert.equal(result.auditEntriesWritten, 2);
  const staleRecord = readJsonl(join(storeRoot, "normalized", "pitfalls.jsonl"))[0];
  assert.equal(staleRecord?.state, "stale");
  assert.equal(staleRecord?.valid_until, "2026-04-22T11:00:00.000Z");
  assert.equal(staleRecord?.invalidated_by, "all file-backed evidence paths are missing");

  const audit = readJsonl(join(storeRoot, "audit", "changes.jsonl"));
  assert.equal(audit[1]?.action, "state_changed");
  assert.equal(audit[1]?.before_state, "active");
  assert.equal(audit[1]?.after_state, "stale");
});

test("normalizeStore marks conflicting same-scope assertions contested", (context) => {
  const { directory, cleanup } = tempDirectory();
  context.after(cleanup);
  const storeRoot = join(directory, ".teamctx");
  writeRaw(storeRoot, observation());
  writeRaw(
    storeRoot,
    observation({
      event_id: "event-2",
      text: "Auth middleware must not run before tenant resolution."
    })
  );

  const result = normalizeStore({
    repo: "github.com/team/service",
    storeRoot,
    now: fixedNow
  });
  const records = readJsonl(join(storeRoot, "normalized", "pitfalls.jsonl"));

  assert.equal(result.recordsWritten, 2);
  assert.equal(
    records.every((record) => record.state === "contested"),
    true
  );
  assert.equal(
    records.every((record) => record.valid_until === "2026-04-22T11:00:00.000Z"),
    true
  );
  assert.equal(
    records.every(
      (record) => record.invalidated_by === "conflicting same-scope assertion detected"
    ),
    true
  );
  assert.equal(
    records.every(
      (record) => Array.isArray(record.conflicts_with) && record.conflicts_with.length === 1
    ),
    true
  );

  const audit = readJsonl(join(storeRoot, "audit", "changes.jsonl"));
  assert.equal(audit.filter((entry) => entry.action === "contested").length, 2);
});

test("normalizeStore marks reversed ordering assertions contested", (context) => {
  const { directory, cleanup } = tempDirectory();
  context.after(cleanup);
  const storeRoot = join(directory, ".teamctx");
  writeRaw(storeRoot, observation());
  writeRaw(
    storeRoot,
    observation({
      event_id: "event-2",
      text: "Tenant resolution should execute before auth middleware."
    })
  );

  const result = normalizeStore({
    repo: "github.com/team/service",
    storeRoot,
    now: fixedNow
  });
  const records = readJsonl(join(storeRoot, "normalized", "pitfalls.jsonl"));

  assert.equal(result.recordsWritten, 2);
  assert.equal(
    records.every((record) => record.state === "contested"),
    true
  );
  assert.equal(
    records.every(
      (record) => Array.isArray(record.conflicts_with) && record.conflicts_with.length === 1
    ),
    true
  );
});

test("normalizeStore marks explicitly superseded records", (context) => {
  const { directory, cleanup } = tempDirectory();
  context.after(cleanup);
  const storeRoot = join(directory, ".teamctx");
  writeRaw(storeRoot, observation());
  normalizeStore({
    repo: "github.com/team/service",
    storeRoot,
    now: fixedNow
  });

  const oldRecord = readJsonl(join(storeRoot, "normalized", "pitfalls.jsonl"))[0];

  if (!oldRecord || typeof oldRecord.id !== "string") {
    throw new Error("expected old record id");
  }

  writeRaw(
    storeRoot,
    observation({
      event_id: "event-2",
      text: "Tenant resolution must run before auth middleware.",
      supersedes: [oldRecord.id]
    })
  );

  const result = normalizeStore({
    repo: "github.com/team/service",
    storeRoot,
    now: fixedNow
  });
  const records = readJsonl(join(storeRoot, "normalized", "pitfalls.jsonl"));

  assert.equal(result.recordsWritten, 2);
  assert.equal(records.find((record) => record.id === oldRecord.id)?.state, "superseded");
  assert.equal(
    records.find((record) => record.id === oldRecord.id)?.invalidated_by,
    "superseded by a newer normalized record"
  );
  assert.equal(records.find((record) => record.id !== oldRecord.id)?.state, "active");
});

test("normalizeBoundStore resolves the same-repository binding", (context) => {
  const { directory, cleanup } = tempDirectory();
  context.after(cleanup);
  const storeRoot = join(directory, ".teamctx");
  writeRaw(storeRoot, observation());

  const services = servicesFor(directory);

  assert.equal(
    normalizeBoundStore({
      services,
      now: fixedNow
    }).recordsWritten,
    1
  );
  assert.equal(
    (normalizeTool({}, services) as { rawEventsRead: number; recordsWritten: number })
      .rawEventsRead,
    1
  );
});

test("normalizeBoundStoreAsync resolves and writes a remote context store adapter", async (context) => {
  const { directory, cleanup } = tempDirectory();
  context.after(cleanup);
  const remoteRoot = join(directory, "remote-store");
  mkdirSync(join(directory, "src", "auth"), { recursive: true });
  writeFileSync(join(directory, "src", "auth", "middleware.ts"), "export {}\n", "utf8");
  writeRaw(remoteRoot, observation());

  const services = servicesFor(directory, "github.com/team/context", remoteRoot);
  const result = await normalizeBoundStoreAsync({
    services,
    now: fixedNow
  });

  assert.deepEqual(result, {
    normalizedAt: "2026-04-22T11:00:00.000Z",
    rawEventsRead: 1,
    recordsWritten: 1,
    droppedEvents: 0,
    auditEntriesWritten: 1
  });
  assert.equal(readJsonl(join(remoteRoot, "normalized", "pitfalls.jsonl"))[0]?.state, "active");
  assert.equal(readJsonl(join(remoteRoot, "audit", "changes.jsonl"))[0]?.action, "created");
  assert.deepEqual(
    JSON.parse(readFileSync(join(remoteRoot, "indexes", "last-normalize.json"), "utf8")),
    result
  );
  assert.deepEqual(
    Object.keys(
      (
        JSON.parse(readFileSync(join(remoteRoot, "indexes", "path-index.json"), "utf8")) as {
          paths: Record<string, string[]>;
        }
      ).paths
    ),
    ["src/auth/**"]
  );
  assert.deepEqual(
    Object.keys(
      (
        JSON.parse(readFileSync(join(remoteRoot, "indexes", "symbol-index.json"), "utf8")) as {
          symbols: Record<string, string[]>;
        }
      ).symbols
    ),
    ["AuthMiddleware"]
  );
  assert.deepEqual(
    Object.keys(
      (
        JSON.parse(readFileSync(join(remoteRoot, "indexes", "text-index.json"), "utf8")) as {
          tokens: Record<string, string[]>;
        }
      ).tokens
    ).includes("auth"),
    true
  );
  assert.equal(
    (
      JSON.parse(readFileSync(join(remoteRoot, "indexes", "episode-index.json"), "utf8")) as {
        episodes: Array<{ source_event_ids: string[] }>;
      }
    ).episodes[0]?.source_event_ids[0],
    "event-1"
  );
});

function servicesFor(
  root: string,
  contextStoreRepo = "github.com/team/service",
  remoteStoreRoot?: string
): NormalizeServices {
  const binding: Binding = {
    repo: "github.com/team/service",
    root,
    contextStore: {
      provider: "github",
      repo: contextStoreRepo,
      path: ".teamctx"
    },
    createdAt: "2026-04-22T10:00:00.000Z"
  };

  return {
    getRepoRoot: () => root,
    getOriginRemote: () => "git@github.com:team/service.git",
    findBinding: () => binding,
    ...(remoteStoreRoot !== undefined
      ? { createContextStore: () => new LocalContextStore(remoteStoreRoot) }
      : {})
  };
}

function writeNormalizedRecord(storeRoot: string, normalizedRecord: NormalizedRecord): void {
  const directory = join(storeRoot, "normalized");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "pitfalls.jsonl"), `${JSON.stringify(normalizedRecord)}\n`, "utf8");
}

function readJsonl(path: string): Array<Record<string, unknown>> {
  const content = readFileSync(path, "utf8").trim();

  if (content.length === 0) {
    return [];
  }

  return content.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}
