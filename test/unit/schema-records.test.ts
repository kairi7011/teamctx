import assert from "node:assert/strict";
import test from "node:test";
import { formatRawEventPath } from "../../src/core/store/raw-event-path.js";
import { validateAuditLogEntry } from "../../src/schemas/audit.js";
import { validateEvidence } from "../../src/schemas/evidence.js";
import { validateNormalizedRecord } from "../../src/schemas/normalized-record.js";
import { validateRawObservation } from "../../src/schemas/observation.js";

const codeEvidence = {
  kind: "code",
  repo: "github.com/team/service",
  commit: "abc123",
  file: "src/auth/middleware.ts",
  lines: [10, 34]
};

const scope = {
  paths: ["src/auth/**"],
  domains: ["auth", "tenant"],
  symbols: ["AuthMiddleware"],
  tags: ["request-lifecycle"]
};

const provenance = {
  recorded_by: "codex",
  session_id: "session-1",
  observed_at: "2026-04-21T10:00:00.000Z"
};

test("validateEvidence accepts code evidence with a line range", () => {
  assert.deepEqual(validateEvidence(codeEvidence), codeEvidence);
});

test("validateEvidence requires doc_role for docs evidence", () => {
  assert.throws(
    () =>
      validateEvidence({
        kind: "docs",
        repo: "github.com/team/service",
        commit: "abc123",
        file: "README.md"
      }),
    /requires doc_role/
  );
});

test("validateRawObservation permits candidate observations without evidence", () => {
  assert.deepEqual(
    validateRawObservation({
      schema_version: 1,
      event_id: "event-1",
      session_id: "session-1",
      observed_at: "2026-04-21T10:00:00.000Z",
      recorded_by: "codex",
      trust: "candidate",
      kind: "pitfall",
      text: "Auth middleware ordering is easy to break.",
      source_type: "manual_assertion",
      evidence: []
    }),
    {
      schema_version: 1,
      event_id: "event-1",
      session_id: "session-1",
      observed_at: "2026-04-21T10:00:00.000Z",
      recorded_by: "codex",
      trust: "candidate",
      kind: "pitfall",
      text: "Auth middleware ordering is easy to break.",
      source_type: "manual_assertion",
      evidence: [],
      supersedes: []
    }
  );
});

test("validateRawObservation accepts optional verification hints", () => {
  const observation = validateRawObservation({
    schema_version: 1,
    event_id: "event-1",
    session_id: "session-1",
    observed_at: "2026-04-21T10:00:00.000Z",
    recorded_by: "codex",
    trust: "verified",
    kind: "pitfall",
    text: "Auth middleware must run before tenant resolution.",
    source_type: "inferred_from_code",
    evidence: [codeEvidence],
    verification: {
      commands: [" npm test -- auth ", "npm test -- auth"],
      files: ["test/auth.test.ts"],
      notes: ["Check request ordering."]
    }
  });

  assert.deepEqual(observation.verification, {
    commands: ["npm test -- auth"],
    files: ["test/auth.test.ts"],
    notes: ["Check request ordering."]
  });
});

test("validateRawObservation requires non-manual evidence for verified observations", () => {
  assert.throws(
    () =>
      validateRawObservation({
        schema_version: 1,
        event_id: "event-1",
        session_id: "session-1",
        observed_at: "2026-04-21T10:00:00.000Z",
        recorded_by: "codex",
        trust: "verified",
        kind: "pitfall",
        text: "Auth middleware must run before tenant resolution.",
        source_type: "inferred_from_code",
        evidence: []
      }),
    /requires non-manual evidence/
  );
  assert.throws(
    () =>
      validateRawObservation({
        schema_version: 1,
        event_id: "event-1",
        session_id: "session-1",
        observed_at: "2026-04-21T10:00:00.000Z",
        recorded_by: "codex",
        trust: "verified",
        kind: "pitfall",
        text: "Auth middleware must run before tenant resolution.",
        source_type: "manual_assertion",
        evidence: [{ kind: "manual_assertion" }]
      }),
    /requires non-manual evidence/
  );
});

test("validateNormalizedRecord accepts an active record with evidence and provenance", () => {
  const record = {
    id: "pitfall-auth-order-001",
    schema_version: 1,
    normalizer_version: "0.1.0",
    kind: "pitfall",
    state: "active",
    text: "Auth middleware must run before tenant resolution.",
    scope,
    evidence: [codeEvidence],
    provenance,
    confidence_level: "medium",
    confidence_score: 0.65,
    last_verified_at: "2026-04-21T10:00:00.000Z",
    valid_from: "2026-04-21T10:00:00.000Z",
    verification: {
      commands: ["npm test -- auth"],
      files: ["test/auth.test.ts"],
      notes: ["Check request ordering."]
    },
    supersedes: [],
    conflicts_with: []
  };

  assert.deepEqual(validateNormalizedRecord(record), record);
});

test("validateNormalizedRecord rejects invalid states", () => {
  assert.throws(
    () =>
      validateNormalizedRecord({
        id: "pitfall-auth-order-001",
        schema_version: 1,
        normalizer_version: "0.1.0",
        kind: "pitfall",
        state: "unknown",
        text: "Auth middleware must run before tenant resolution.",
        scope,
        evidence: [codeEvidence],
        provenance,
        confidence_level: "medium",
        supersedes: [],
        conflicts_with: []
      }),
    /state is invalid/
  );
});

test("validateAuditLogEntry accepts state transition audit entries", () => {
  const entry = {
    schema_version: 1,
    id: "audit-1",
    at: "2026-04-21T10:00:00.000Z",
    action: "state_changed",
    item_id: "pitfall-auth-order-001",
    before_state: "candidate",
    after_state: "active",
    reason: "evidence minimum check passed",
    source_event_ids: ["event-1"]
  };

  assert.deepEqual(validateAuditLogEntry(entry), entry);

  assert.throws(
    () =>
      validateAuditLogEntry({
        ...entry,
        before_state: "unknown"
      }),
    /before_state is invalid/
  );
});

test("formatRawEventPath returns a safe POSIX store path", () => {
  assert.equal(
    formatRawEventPath({
      observedAt: "2026-04-21T10:00:00.000Z",
      sessionId: "session-1",
      eventId: "event-1"
    }),
    "raw/events/2026-04-21/session-1-event-1.json"
  );
  assert.throws(
    () =>
      formatRawEventPath({
        observedAt: "2026-04-21T10:00:00.000Z",
        sessionId: "../session",
        eventId: "event-1"
      }),
    /sessionId must contain only/
  );
});
