import assert from "node:assert/strict";
import test from "node:test";
import {
  scanRawObservation,
  scanTextForSensitiveContent
} from "../../src/core/policy/redaction-policy.js";
import type { RawObservation } from "../../src/schemas/observation.js";

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

test("scanTextForSensitiveContent blocks API key shaped content", () => {
  assert.deepEqual(scanTextForSensitiveContent("api_key = sk-1234567890abcdef", "text"), [
    {
      severity: "block",
      kind: "api_key",
      field: "text",
      excerpt: "[redacted:api_key]"
    }
  ]);
});

test("scanTextForSensitiveContent warns on internal URLs and emails", () => {
  assert.deepEqual(
    scanTextForSensitiveContent("See http://service.internal/runbook by dev@example.com"),
    [
      {
        severity: "warn",
        kind: "email",
        field: "text",
        excerpt: "[redacted:email]"
      },
      {
        severity: "warn",
        kind: "internal_url",
        field: "text",
        excerpt: "[redacted:internal_url]"
      }
    ]
  );
});

test("scanRawObservation ignores warning-only PII patterns in metadata ids", () => {
  const report = scanRawObservation(
    observation({
      event_id: "observe-context-1776936705768",
      session_id: "session-1776936705768",
      recorded_by: "codex"
    })
  );

  assert.equal(report.status, "allowed");
  assert.deepEqual(report.findings, []);
});

test("scanRawObservation still blocks secret-shaped metadata ids", () => {
  const report = scanRawObservation(
    observation({
      event_id: "token = abcdefghijklmnop"
    })
  );

  assert.equal(report.status, "blocked");
  assert.deepEqual(report.findings, [
    {
      severity: "block",
      kind: "api_key",
      field: "event_id",
      excerpt: "[redacted:api_key]"
    }
  ]);
});

test("scanRawObservation blocks .env evidence files", () => {
  const report = scanRawObservation(
    observation({
      evidence: [
        {
          kind: "code",
          repo: "github.com/team/service",
          commit: "abc123",
          file: ".env"
        }
      ]
    })
  );

  assert.equal(report.status, "blocked");
  assert.deepEqual(report.findings, [
    {
      severity: "block",
      kind: "env_file",
      field: "evidence[0].file",
      excerpt: "[redacted:env_file]"
    }
  ]);
});

test("scanTextForSensitiveContent ignores plain commit SHAs", () => {
  assert.deepEqual(
    scanTextForSensitiveContent("commit abcdef1234567890abcdef1234567890abcdef12"),
    []
  );
});
