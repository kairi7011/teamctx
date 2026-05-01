import type { RawObservation } from "../../src/schemas/observation.js";

export type FixtureObservationOptions = Partial<RawObservation> & {
  evidenceLines?: boolean;
};

export function fixtureObservation(options: FixtureObservationOptions = {}): RawObservation {
  const { evidenceLines = true, ...overrides } = options;
  const baseEvidence = {
    kind: "code" as const,
    repo: "github.com/team/service",
    commit: "abc123",
    file: "src/auth/middleware.ts",
    ...(evidenceLines ? { lines: [10, 34] as [number, number] } : {})
  };

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
    evidence: [baseEvidence],
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
