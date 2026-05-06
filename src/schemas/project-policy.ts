import type { KnowledgeKind } from "./normalized-record.js";
import { isNonEmptyString, isPositiveInteger, isRecord, isStringArray } from "./validation.js";

export type GovernanceLevel = "open" | "suggested_review" | "strict_review";

export type BackgroundJobType = "normalize" | "compact" | "index_refresh" | "quality_report";

export type CandidateAutomationPolicy = {
  enabled: boolean;
  allowed_kinds: KnowledgeKind[];
  require_evidence: boolean;
  max_items_per_session: number;
};

export type HighImpactPolicy = {
  kinds: KnowledgeKind[];
  domains: string[];
  tags: string[];
  require_reviewer: boolean;
};

export type ReviewPolicy = {
  default_owner: string | null;
  reviewers_by_domain: Record<string, string[]>;
};

export type BackgroundJobsPolicy = {
  enabled: boolean;
  allowed_types: BackgroundJobType[];
  schedule: string | null;
};

export type ProjectPolicy = {
  schema_version: 1;
  governance_level: GovernanceLevel;
  candidate_automation: CandidateAutomationPolicy;
  high_impact: HighImpactPolicy;
  review: ReviewPolicy;
  background_jobs: BackgroundJobsPolicy;
};

export const PROJECT_POLICY_FILE = "policy/project-policy.json";

const GOVERNANCE_LEVELS = new Set<GovernanceLevel>(["open", "suggested_review", "strict_review"]);

const KNOWLEDGE_KINDS = new Set<KnowledgeKind>([
  "fact",
  "rule",
  "pitfall",
  "decision",
  "workflow",
  "glossary"
]);

const BACKGROUND_JOB_TYPES = new Set<BackgroundJobType>([
  "normalize",
  "compact",
  "index_refresh",
  "quality_report"
]);

export function createDefaultProjectPolicy(): ProjectPolicy {
  return {
    schema_version: 1,
    governance_level: "suggested_review",
    candidate_automation: {
      enabled: false,
      allowed_kinds: ["fact", "pitfall", "workflow"],
      require_evidence: true,
      max_items_per_session: 5
    },
    high_impact: {
      kinds: ["rule", "workflow", "decision"],
      domains: [],
      tags: ["security", "privacy", "release", "governance"],
      require_reviewer: true
    },
    review: {
      default_owner: null,
      reviewers_by_domain: {}
    },
    background_jobs: {
      enabled: false,
      allowed_types: ["normalize", "compact", "index_refresh"],
      schedule: null
    }
  };
}

export function serializeProjectPolicy(policy: ProjectPolicy): string {
  return `${JSON.stringify(validateProjectPolicy(policy), null, 2)}\n`;
}

export function parseProjectPolicy(content: string): ProjectPolicy {
  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    throw new Error(`project policy must be valid JSON: ${message}`);
  }

  return validateProjectPolicy(parsed);
}

export function validateProjectPolicy(value: unknown): ProjectPolicy {
  if (!isRecord(value)) {
    throw new Error("project policy must be an object");
  }

  if (value.schema_version !== 1) {
    throw new Error("project policy schema_version must be 1");
  }

  return {
    schema_version: 1,
    governance_level: validateGovernanceLevel(value.governance_level),
    candidate_automation: validateCandidateAutomation(value.candidate_automation),
    high_impact: validateHighImpact(value.high_impact),
    review: validateReview(value.review),
    background_jobs: validateBackgroundJobs(value.background_jobs)
  };
}

function validateGovernanceLevel(value: unknown): GovernanceLevel {
  if (typeof value !== "string" || !GOVERNANCE_LEVELS.has(value as GovernanceLevel)) {
    throw new Error("project policy governance_level is invalid");
  }

  return value as GovernanceLevel;
}

function validateCandidateAutomation(value: unknown): CandidateAutomationPolicy {
  if (!isRecord(value)) {
    throw new Error("project policy candidate_automation must be an object");
  }

  if (typeof value.enabled !== "boolean") {
    throw new Error("project policy candidate_automation.enabled must be a boolean");
  }

  if (typeof value.require_evidence !== "boolean") {
    throw new Error("project policy candidate_automation.require_evidence must be a boolean");
  }

  if (!isPositiveInteger(value.max_items_per_session)) {
    throw new Error(
      "project policy candidate_automation.max_items_per_session must be a positive integer"
    );
  }

  return {
    enabled: value.enabled,
    allowed_kinds: uniqueKnownValues(
      value.allowed_kinds,
      KNOWLEDGE_KINDS,
      "project policy candidate_automation.allowed_kinds"
    ),
    require_evidence: value.require_evidence,
    max_items_per_session: value.max_items_per_session
  };
}

function validateHighImpact(value: unknown): HighImpactPolicy {
  if (!isRecord(value)) {
    throw new Error("project policy high_impact must be an object");
  }

  if (typeof value.require_reviewer !== "boolean") {
    throw new Error("project policy high_impact.require_reviewer must be a boolean");
  }

  return {
    kinds: uniqueKnownValues(value.kinds, KNOWLEDGE_KINDS, "project policy high_impact.kinds"),
    domains: uniqueStrings(value.domains, "project policy high_impact.domains"),
    tags: uniqueStrings(value.tags, "project policy high_impact.tags"),
    require_reviewer: value.require_reviewer
  };
}

function validateReview(value: unknown): ReviewPolicy {
  if (!isRecord(value)) {
    throw new Error("project policy review must be an object");
  }

  if (value.default_owner !== null && value.default_owner !== undefined) {
    if (!isNonEmptyString(value.default_owner)) {
      throw new Error("project policy review.default_owner must be a non-empty string or null");
    }
  }

  if (!isRecord(value.reviewers_by_domain)) {
    throw new Error("project policy review.reviewers_by_domain must be an object");
  }

  const reviewersByDomain: Record<string, string[]> = {};

  for (const [domain, reviewers] of Object.entries(value.reviewers_by_domain)) {
    if (domain.trim().length === 0) {
      throw new Error("project policy review.reviewers_by_domain keys must be non-empty");
    }

    reviewersByDomain[domain.trim()] = uniqueStrings(
      reviewers,
      `project policy review.reviewers_by_domain.${domain}`
    );
  }

  return {
    default_owner: value.default_owner ?? null,
    reviewers_by_domain: reviewersByDomain
  };
}

function validateBackgroundJobs(value: unknown): BackgroundJobsPolicy {
  if (!isRecord(value)) {
    throw new Error("project policy background_jobs must be an object");
  }

  if (typeof value.enabled !== "boolean") {
    throw new Error("project policy background_jobs.enabled must be a boolean");
  }

  if (
    value.schedule !== null &&
    value.schedule !== undefined &&
    typeof value.schedule !== "string"
  ) {
    throw new Error("project policy background_jobs.schedule must be a string or null");
  }

  return {
    enabled: value.enabled,
    allowed_types: uniqueKnownValues(
      value.allowed_types,
      BACKGROUND_JOB_TYPES,
      "project policy background_jobs.allowed_types"
    ),
    schedule: value.schedule ?? null
  };
}

function uniqueStrings(value: unknown, name: string): string[] {
  if (!isStringArray(value)) {
    throw new Error(`${name} must be a string array`);
  }

  return [...new Set(value.map((item) => item.trim()).filter((item) => item.length > 0))];
}

function uniqueKnownValues<T extends string>(value: unknown, allowed: Set<T>, name: string): T[] {
  const values = uniqueStrings(value, name);

  if (values.length === 0) {
    throw new Error(`${name} must not be empty`);
  }

  for (const item of values) {
    if (!allowed.has(item as T)) {
      throw new Error(`${name} contains unsupported value ${JSON.stringify(item)}`);
    }
  }

  return values as T[];
}
