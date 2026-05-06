import { validateEvidenceList, type Evidence } from "./evidence.js";
import {
  isKnowledgeKind,
  validateScope,
  validateVerificationHints,
  type KnowledgeKind,
  type Scope,
  type VerificationHints
} from "./normalized-record.js";
import { isNonEmptyString, isRecord, optionalStringArray } from "./validation.js";

export const OBSERVATION_SOURCE_TYPES = [
  "manual_assertion",
  "inferred_from_code",
  "inferred_from_diff",
  "inferred_from_docs",
  "inferred_from_issue",
  "inferred_from_pr"
] as const;

export type ObservationSourceType = (typeof OBSERVATION_SOURCE_TYPES)[number];

export type RawObservationTrust = "candidate" | "verified";

export type RawObservation = {
  schema_version: 1;
  event_id: string;
  session_id: string;
  observed_at: string;
  recorded_by: string;
  trust: RawObservationTrust;
  kind: KnowledgeKind;
  text: string;
  source_type: ObservationSourceType;
  evidence: Evidence[];
  verification?: VerificationHints;
  scope?: Scope;
  supersedes: string[];
};

export function validateRawObservation(value: unknown): RawObservation {
  if (!isRecord(value)) {
    throw new Error("raw observation must be an object");
  }

  if (value.schema_version !== 1) {
    throw new Error("raw observation schema_version must be 1");
  }

  if (value.trust !== "candidate" && value.trust !== "verified") {
    throw new Error("raw observation trust is invalid");
  }

  if (!isKnowledgeKind(value.kind)) {
    throw new Error("raw observation kind is invalid");
  }

  if (!isObservationSourceType(value.source_type)) {
    throw new Error("raw observation source_type is invalid");
  }

  const evidence = validateEvidenceList(value.evidence);

  if (value.trust === "verified" && !evidence.some((item) => item.kind !== "manual_assertion")) {
    throw new Error("verified raw observation requires non-manual evidence");
  }

  const observation: RawObservation = {
    schema_version: 1,
    event_id: requiredString(value.event_id, "event_id"),
    session_id: requiredString(value.session_id, "session_id"),
    observed_at: requiredString(value.observed_at, "observed_at"),
    recorded_by: requiredString(value.recorded_by, "recorded_by"),
    trust: value.trust,
    kind: value.kind,
    text: requiredString(value.text, "text"),
    source_type: value.source_type,
    evidence,
    supersedes: optionalStringArray(value.supersedes) ?? []
  };

  if (value.scope !== undefined) {
    observation.scope = validateScope(value.scope);
  }
  if (value.verification !== undefined) {
    observation.verification = validateVerificationHints(value.verification);
  }

  return observation;
}

function isObservationSourceType(value: unknown): value is ObservationSourceType {
  return (
    typeof value === "string" && OBSERVATION_SOURCE_TYPES.includes(value as ObservationSourceType)
  );
}

function requiredString(value: unknown, name: string): string {
  if (!isNonEmptyString(value)) {
    throw new Error(`raw observation ${name} must be a non-empty string`);
  }

  return value;
}
