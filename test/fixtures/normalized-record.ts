import type { NormalizedRecord } from "../../src/schemas/normalized-record.js";

export function fixtureNormalizedRecord(
  overrides: Partial<NormalizedRecord> = {}
): NormalizedRecord {
  return {
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
      tags: ["request-lifecycle"]
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
    conflicts_with: [],
    ...overrides
  };
}
