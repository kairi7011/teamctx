import { randomUUID } from "node:crypto";
import {
  recordRawObservation,
  type RecordObservationServices
} from "../../core/observation/record.js";
import { validateRawObservation, type RawObservationTrust } from "../../schemas/observation.js";
import { isNonEmptyString, isRecord } from "../../schemas/validation.js";

export type RecordObservationToolResult = {
  recorded: true;
  path: string;
  relative_path: string;
  findings: Array<{ severity: string; kind: string; field: string; excerpt: string }>;
};

export function recordObservationCandidateTool(
  rawInput: unknown,
  services?: RecordObservationServices
): RecordObservationToolResult {
  return recordObservationTool(rawInput, "candidate", services);
}

export function recordObservationVerifiedTool(
  rawInput: unknown,
  services?: RecordObservationServices
): RecordObservationToolResult {
  return recordObservationTool(rawInput, "verified", services);
}

function recordObservationTool(
  rawInput: unknown,
  trust: RawObservationTrust,
  services?: RecordObservationServices
): RecordObservationToolResult {
  const input = normalizeRecordInput(rawInput, trust);
  const cwd = getOptionalString(rawInput, "cwd");
  const result = recordRawObservation({
    observation: input,
    ...(cwd !== undefined ? { cwd } : {}),
    ...(services !== undefined ? { services } : {})
  });

  return {
    recorded: true,
    path: result.path,
    relative_path: result.relativePath,
    findings: result.findings
  };
}

function normalizeRecordInput(rawInput: unknown, trust: RawObservationTrust) {
  if (!isRecord(rawInput)) {
    throw new Error("record_observation input must be an object");
  }

  return validateRawObservation({
    schema_version: 1,
    event_id: optionalString(rawInput.event_id) ?? randomUUID(),
    session_id: optionalString(rawInput.session_id) ?? `session-${randomUUID()}`,
    observed_at: optionalString(rawInput.observed_at) ?? new Date().toISOString(),
    recorded_by: optionalString(rawInput.recorded_by) ?? "unknown",
    trust,
    kind: rawInput.kind,
    text: rawInput.text,
    source_type: rawInput.source_type,
    evidence: rawInput.evidence ?? [],
    scope: rawInput.scope,
    supersedes: rawInput.supersedes
  });
}

function getOptionalString(rawInput: unknown, key: string): string | undefined {
  if (!isRecord(rawInput)) {
    return undefined;
  }

  return optionalString(rawInput[key]);
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isNonEmptyString(value)) {
    throw new Error("optional string fields must be non-empty strings");
  }

  return value;
}
