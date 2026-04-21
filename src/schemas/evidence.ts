import { isNonEmptyString, isPositiveInteger, isRecord } from "./validation.js";

export const EVIDENCE_KINDS = [
  "code",
  "test",
  "config",
  "docs",
  "diff",
  "issue",
  "pr",
  "manual_assertion"
] as const;

export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const DOC_ROLES = [
  "adr",
  "runbook",
  "readme",
  "commented_doc",
  "external_doc",
  "other"
] as const;

export type DocRole = (typeof DOC_ROLES)[number];

export type LineRange = [number, number];

export type Evidence = {
  kind: EvidenceKind;
  repo?: string;
  commit?: string;
  file?: string;
  lines?: LineRange;
  doc_role?: DocRole;
  issue?: number;
  pr?: number;
  url?: string;
};

export function validateEvidence(value: unknown): Evidence {
  if (!isRecord(value)) {
    throw new Error("evidence must be an object");
  }

  if (!isEvidenceKind(value.kind)) {
    throw new Error("evidence kind is invalid");
  }

  const evidence: Evidence = { kind: value.kind };

  assignOptionalString(evidence, "repo", value.repo);
  assignOptionalString(evidence, "commit", value.commit);
  assignOptionalString(evidence, "file", value.file);
  assignOptionalString(evidence, "url", value.url);

  if (value.lines !== undefined) {
    evidence.lines = validateLineRange(value.lines);
  }

  if (value.issue !== undefined) {
    if (!isPositiveInteger(value.issue)) {
      throw new Error("issue evidence issue must be a positive integer");
    }
    evidence.issue = value.issue;
  }

  if (value.pr !== undefined) {
    if (!isPositiveInteger(value.pr)) {
      throw new Error("pr evidence pr must be a positive integer");
    }
    evidence.pr = value.pr;
  }

  if (value.doc_role !== undefined) {
    if (!isDocRole(value.doc_role)) {
      throw new Error("docs evidence doc_role is invalid");
    }
    evidence.doc_role = value.doc_role;
  }

  validateEvidenceRequirements(evidence);

  return evidence;
}

export function validateEvidenceList(value: unknown): Evidence[] {
  if (!Array.isArray(value)) {
    throw new Error("evidence must be an array");
  }

  return value.map(validateEvidence);
}

export function isEvidenceKind(value: unknown): value is EvidenceKind {
  return typeof value === "string" && EVIDENCE_KINDS.includes(value as EvidenceKind);
}

function isDocRole(value: unknown): value is DocRole {
  return typeof value === "string" && DOC_ROLES.includes(value as DocRole);
}

function validateLineRange(value: unknown): LineRange {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error("evidence lines must be a two-item range");
  }

  const [start, end] = value;

  if (!isPositiveInteger(start) || !isPositiveInteger(end) || start > end) {
    throw new Error("evidence lines must be positive ascending integers");
  }

  return [start, end];
}

function validateEvidenceRequirements(evidence: Evidence): void {
  if (["code", "test", "config", "docs", "diff"].includes(evidence.kind)) {
    if (
      !isNonEmptyString(evidence.repo) ||
      !isNonEmptyString(evidence.commit) ||
      !isNonEmptyString(evidence.file)
    ) {
      throw new Error(`${evidence.kind} evidence requires repo, commit, and file`);
    }
  }

  if (evidence.kind === "docs" && !evidence.doc_role) {
    throw new Error("docs evidence requires doc_role");
  }

  if (evidence.kind === "issue" && evidence.issue === undefined && !evidence.url) {
    throw new Error("issue evidence requires issue or url");
  }

  if (evidence.kind === "pr" && evidence.pr === undefined && !evidence.url) {
    throw new Error("pr evidence requires pr or url");
  }
}

function assignOptionalString<T extends keyof Evidence>(
  evidence: Evidence,
  key: T,
  value: unknown
): void {
  if (value === undefined) {
    return;
  }

  if (!isNonEmptyString(value)) {
    throw new Error(`evidence ${String(key)} must be a non-empty string`);
  }

  Object.assign(evidence, { [key]: value });
}
