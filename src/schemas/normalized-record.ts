import { validateEvidenceList, type Evidence } from "./evidence.js";
import {
  isNonEmptyString,
  isNumberInRange,
  isRecord,
  isStringArray,
  optionalStringArray
} from "./validation.js";

export const KNOWLEDGE_KINDS = [
  "fact",
  "rule",
  "pitfall",
  "decision",
  "workflow",
  "glossary"
] as const;

export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];

export const RECORD_STATES = ["active", "contested", "stale", "superseded", "archived"] as const;

export type RecordState = (typeof RECORD_STATES)[number];

export const CONFIDENCE_LEVELS = ["low", "medium", "high"] as const;

export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

export type Scope = {
  paths: string[];
  domains: string[];
  symbols: string[];
  tags: string[];
};

export type Provenance = {
  recorded_by: string;
  session_id: string;
  observed_at: string;
};

export type NormalizedRecord = {
  id: string;
  schema_version: 1;
  normalizer_version: string;
  kind: KnowledgeKind;
  state: RecordState;
  text: string;
  scope: Scope;
  evidence: Evidence[];
  provenance: Provenance;
  confidence_level: ConfidenceLevel;
  confidence_score?: number;
  last_verified_at?: string;
  valid_from?: string;
  valid_until?: string;
  invalidated_by?: string;
  supersedes: string[];
  conflicts_with: string[];
};

export function validateNormalizedRecord(value: unknown): NormalizedRecord {
  if (!isRecord(value)) {
    throw new Error("normalized record must be an object");
  }

  if (value.schema_version !== 1) {
    throw new Error("normalized record schema_version must be 1");
  }

  if (!isKnowledgeKind(value.kind)) {
    throw new Error("normalized record kind is invalid");
  }

  if (!isRecordState(value.state)) {
    throw new Error("normalized record state is invalid");
  }

  if (!isConfidenceLevel(value.confidence_level)) {
    throw new Error("normalized record confidence_level is invalid");
  }

  const record: NormalizedRecord = {
    id: requiredString(value.id, "id"),
    schema_version: 1,
    normalizer_version: requiredString(value.normalizer_version, "normalizer_version"),
    kind: value.kind,
    state: value.state,
    text: requiredString(value.text, "text"),
    scope: validateScope(value.scope),
    evidence: validateEvidenceList(value.evidence),
    provenance: validateProvenance(value.provenance),
    confidence_level: value.confidence_level,
    supersedes: optionalStringArray(value.supersedes) ?? [],
    conflicts_with: optionalStringArray(value.conflicts_with) ?? []
  };

  if (value.confidence_score !== undefined) {
    if (!isNumberInRange(value.confidence_score, 0, 1)) {
      throw new Error("normalized record confidence_score must be between 0 and 1");
    }
    record.confidence_score = value.confidence_score;
  }

  if (value.last_verified_at !== undefined) {
    record.last_verified_at = requiredString(value.last_verified_at, "last_verified_at");
  }
  if (value.valid_from !== undefined) {
    record.valid_from = requiredString(value.valid_from, "valid_from");
  }
  if (value.valid_until !== undefined) {
    record.valid_until = requiredString(value.valid_until, "valid_until");
  }
  if (value.invalidated_by !== undefined) {
    record.invalidated_by = requiredString(value.invalidated_by, "invalidated_by");
  }

  return record;
}

export function validateScope(value: unknown): Scope {
  if (!isRecord(value)) {
    throw new Error("scope must be an object");
  }

  if (
    !isStringArray(value.paths) ||
    !isStringArray(value.domains) ||
    !isStringArray(value.symbols) ||
    !isStringArray(value.tags)
  ) {
    throw new Error("scope paths, domains, symbols, and tags must be string arrays");
  }

  return {
    paths: value.paths,
    domains: value.domains,
    symbols: value.symbols,
    tags: value.tags
  };
}

export function isKnowledgeKind(value: unknown): value is KnowledgeKind {
  return typeof value === "string" && KNOWLEDGE_KINDS.includes(value as KnowledgeKind);
}

export function isRecordState(value: unknown): value is RecordState {
  return typeof value === "string" && RECORD_STATES.includes(value as RecordState);
}

function isConfidenceLevel(value: unknown): value is ConfidenceLevel {
  return typeof value === "string" && CONFIDENCE_LEVELS.includes(value as ConfidenceLevel);
}

function validateProvenance(value: unknown): Provenance {
  if (!isRecord(value)) {
    throw new Error("provenance must be an object");
  }

  return {
    recorded_by: requiredString(value.recorded_by, "recorded_by"),
    session_id: requiredString(value.session_id, "session_id"),
    observed_at: requiredString(value.observed_at, "observed_at")
  };
}

function requiredString(value: unknown, name: string): string {
  if (!isNonEmptyString(value)) {
    throw new Error(`normalized record ${name} must be a non-empty string`);
  }

  return value;
}
