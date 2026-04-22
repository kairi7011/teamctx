import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  recordRawObservationAsync,
  recordRawObservation,
  SensitiveContentError,
  writeRawObservationToBinding,
  type RecordObservationServices
} from "../../src/core/observation/record.js";
import { LocalContextStore } from "../../src/adapters/store/local-store.js";
import {
  recordObservationCandidateTool,
  recordObservationCandidateToolAsync
} from "../../src/mcp/tools/record-observation.js";
import type { RawObservation } from "../../src/schemas/observation.js";
import type { Binding } from "../../src/schemas/types.js";

function tempDirectory(): { directory: string; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "teamctx-record-"));

  return {
    directory,
    cleanup: () => rmSync(directory, { recursive: true, force: true })
  };
}

function binding(root: string, repo = "github.com/team/service"): Binding {
  return {
    repo: "github.com/team/service",
    root,
    contextStore: {
      provider: "github",
      repo,
      path: ".teamctx"
    },
    createdAt: "2026-04-22T10:00:00.000Z"
  };
}

function observation(overrides: Partial<RawObservation> = {}): RawObservation {
  return {
    schema_version: 1,
    event_id: "event-1",
    session_id: "session-1",
    observed_at: "2026-04-22T10:00:00.000Z",
    recorded_by: "codex",
    trust: "candidate",
    kind: "pitfall",
    text: "Auth middleware ordering is easy to break.",
    source_type: "manual_assertion",
    evidence: [],
    supersedes: [],
    ...overrides
  };
}

test("writeRawObservationToBinding writes a unique raw event under the context store", (context) => {
  const { directory, cleanup } = tempDirectory();
  context.after(cleanup);

  const result = writeRawObservationToBinding({
    repo: "github.com/team/service",
    repoRoot: directory,
    binding: binding(directory),
    observation: observation()
  });

  assert.equal(result.relativePath, "raw/events/2026-04-22/session-1-event-1.json");
  assert.ok(result.path.startsWith(join(directory, ".teamctx")));
  assert.ok(existsSync(result.path));
  assert.deepEqual(JSON.parse(readFileSync(result.path, "utf8")), observation());
});

test("writeRawObservationToBinding rejects external context stores for now", (context) => {
  const { directory, cleanup } = tempDirectory();
  context.after(cleanup);

  assert.throws(
    () =>
      writeRawObservationToBinding({
        repo: "github.com/team/service",
        repoRoot: directory,
        binding: binding(directory, "github.com/team/context"),
        observation: observation()
      }),
    /inside the current repository/
  );
});

test("recordRawObservationAsync writes remote context store raw events through an adapter", async (context) => {
  const { directory, cleanup } = tempDirectory();
  context.after(cleanup);
  const remoteRoot = join(directory, "remote-store");

  const services: RecordObservationServices = {
    getRepoRoot: () => directory,
    getOriginRemote: () => "git@github.com:team/service.git",
    findBinding: () => binding(directory, "github.com/team/context"),
    createContextStore: () => new LocalContextStore(remoteRoot)
  };

  const result = await recordRawObservationAsync({
    observation: observation(),
    services
  });

  assert.equal(
    result.path,
    "github.com/team/context/.teamctx/raw/events/2026-04-22/session-1-event-1.json"
  );
  assert.equal(result.relativePath, "raw/events/2026-04-22/session-1-event-1.json");
  assert.deepEqual(
    JSON.parse(readFileSync(join(remoteRoot, result.relativePath), "utf8")),
    observation()
  );
});

test("writeRawObservationToBinding blocks sensitive raw observations", (context) => {
  const { directory, cleanup } = tempDirectory();
  context.after(cleanup);

  assert.throws(
    () =>
      writeRawObservationToBinding({
        repo: "github.com/team/service",
        repoRoot: directory,
        binding: binding(directory),
        observation: observation({ text: "token = abcdefghijklmnop" })
      }),
    SensitiveContentError
  );
});

test("recordObservationCandidateTool builds and records a candidate event", (context) => {
  const { directory, cleanup } = tempDirectory();
  context.after(cleanup);

  const services: RecordObservationServices = {
    getRepoRoot: () => directory,
    getOriginRemote: () => "git@github.com:team/service.git",
    findBinding: () => binding(directory)
  };

  const result = recordObservationCandidateTool(
    {
      event_id: "event-1",
      session_id: "session-1",
      observed_at: "2026-04-22T10:00:00.000Z",
      recorded_by: "codex",
      kind: "pitfall",
      text: "Auth middleware ordering is easy to break.",
      source_type: "manual_assertion"
    },
    services
  );

  assert.equal(result.recorded, true);
  assert.equal(result.relative_path, "raw/events/2026-04-22/session-1-event-1.json");
  assert.ok(existsSync(result.path));
});

test("recordObservationCandidateToolAsync supports remote context store adapters", async (context) => {
  const { directory, cleanup } = tempDirectory();
  context.after(cleanup);
  const remoteRoot = join(directory, "remote-store");

  const services: RecordObservationServices = {
    getRepoRoot: () => directory,
    getOriginRemote: () => "git@github.com:team/service.git",
    findBinding: () => binding(directory, "github.com/team/context"),
    createContextStore: () => new LocalContextStore(remoteRoot)
  };

  const result = await recordObservationCandidateToolAsync(
    {
      event_id: "event-1",
      session_id: "session-1",
      observed_at: "2026-04-22T10:00:00.000Z",
      recorded_by: "codex",
      kind: "pitfall",
      text: "Auth middleware ordering is easy to break.",
      source_type: "manual_assertion"
    },
    services
  );

  assert.equal(result.recorded, true);
  assert.equal(result.relative_path, "raw/events/2026-04-22/session-1-event-1.json");
  assert.ok(existsSync(join(remoteRoot, result.relative_path)));
});

test("recordRawObservation rejects unbound repos", (context) => {
  const { directory, cleanup } = tempDirectory();
  context.after(cleanup);

  assert.throws(
    () =>
      recordRawObservation({
        observation: observation(),
        services: {
          getRepoRoot: () => directory,
          getOriginRemote: () => "git@github.com:team/service.git",
          findBinding: () => undefined
        }
      }),
    /No teamctx binding found/
  );
});
