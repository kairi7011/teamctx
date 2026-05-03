import type {
  CanonicalDocRef,
  DisabledContextPayload,
  EnabledContextPayload,
  GetContextInput
} from "../../src/schemas/context-payload.js";
import type { EpisodeReference } from "../../src/schemas/episode.js";

export function fixtureGetContextInput(overrides: Partial<GetContextInput> = {}): GetContextInput {
  return {
    target_files: ["src/auth/middleware.ts"],
    domains: ["auth"],
    symbols: ["AuthMiddleware"],
    tags: ["request-lifecycle"],
    ...overrides
  };
}

export function fixtureCanonicalDocRef(overrides: Partial<CanonicalDocRef> = {}): CanonicalDocRef {
  return {
    repo: "github.com/team/context",
    path: "docs/auth.md",
    commit: "abc123",
    item_id: "rule-auth-order",
    reason: "scoped docs evidence",
    fetch_url: "https://raw.githubusercontent.com/team/context/abc123/docs/auth.md",
    doc_role: "runbook",
    lines: [10, 20],
    url: "https://github.com/team/context/blob/abc123/docs/auth.md#L10-L20",
    ...overrides
  };
}

export function fixtureEpisodeReference(
  overrides: Partial<EpisodeReference> = {}
): EpisodeReference {
  return {
    schema_version: 1,
    episode_id: "episode-auth-rollout",
    source_event_ids: ["event-1", "event-2"],
    observed_from: "2026-04-22T10:00:00.000Z",
    observed_to: "2026-04-22T11:00:00.000Z",
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
    summary: "Auth middleware ordering rollout.",
    trust: "verified",
    source_type: "inferred_from_code",
    reason: "target file match: src/auth/middleware.ts",
    selection_reasons: ["target file match: src/auth/middleware.ts"],
    ...overrides
  };
}

export function fixtureDisabledContextPayload(
  overrides: Partial<DisabledContextPayload> = {}
): DisabledContextPayload {
  return {
    enabled: false,
    reason: "No teamctx binding found for this git root.",
    ...overrides
  };
}

export function fixtureEnabledContextPayload(
  overrides: Partial<EnabledContextPayload> = {}
): EnabledContextPayload {
  return {
    enabled: true,
    identity: {
      repo: "github.com/team/service",
      branch: "main",
      head_commit: "abc123",
      context_store: "github.com/team/context/contexts/service",
      store_head: null,
      normalizer_version: "0.1.0",
      context_payload_hash:
        "sha256:0000000000000000000000000000000000000000000000000000000000000000"
    },
    normalized_context: {
      global: "",
      scoped: [
        {
          id: "rule-auth-order",
          kind: "rule",
          scope: {
            paths: ["src/auth/**"],
            domains: ["auth"],
            symbols: ["AuthMiddleware"],
            tags: ["request-lifecycle"]
          },
          content: "Auth middleware must run before tenant resolution.",
          reason: "target file match: src/auth/middleware.ts; rule context; medium confidence",
          rank_score: 123,
          rank_reasons: [
            "target file match: src/auth/middleware.ts",
            "rule context",
            "medium confidence"
          ],
          confidence_level: "medium",
          confidence_score: 0.65,
          last_verified_at: "2026-04-22T11:00:00.000Z"
        }
      ],
      must_follow_rules: ["Auth middleware must run before tenant resolution."],
      recent_decisions: ["Use deterministic normalize ordering for auth."],
      active_pitfalls: ["Tenant resolution before auth leaks scope across users."],
      applicable_workflows: ["Add a new auth-scoped middleware before tenant resolution."],
      glossary_terms: ["AuthMiddleware: request-scoped guard that runs before tenant lookup."]
    },
    relevant_episodes: [fixtureEpisodeReference()],
    canonical_doc_refs: [fixtureCanonicalDocRef()],
    diagnostics: {
      contested_items: ["rule-auth-order-legacy"],
      stale_items: ["pitfall-auth-old"],
      dropped_items: ["candidate-auth-vague"],
      excluded_items: [
        {
          id: "rule-auth-order-legacy",
          state: "contested",
          reason: "excluded because competing same-scope assertions need human review"
        }
      ],
      budget_rejected: [
        {
          id: "workflow-auth-large",
          kind: "workflow",
          rank_score: 12,
          rank_reasons: ["domain match: auth", "workflow context"],
          exclusion_reason: "budget_overflow:workflow"
        }
      ],
      index_warnings: []
    },
    write_policy: {
      record_observation_candidate: "allowed",
      record_observation_verified: "allowed_with_evidence",
      invalidate: "human_only",
      docs_evidence: "allowed_with_doc_role"
    },
    ...overrides
  };
}
