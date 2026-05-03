import { randomUUID } from "node:crypto";
import {
  recordRawObservation,
  recordRawObservationAsync,
  type RecordObservationServices
} from "../../core/observation/record.js";
import {
  validateRawObservation,
  type RawObservation,
  type RawObservationTrust
} from "../../schemas/observation.js";
import { isNonEmptyString, isRecord } from "../../schemas/validation.js";

export type RecordObservationToolResult = {
  recorded: true;
  path: string;
  relative_path: string;
  findings: Array<{ severity: string; kind: string; field: string; excerpt: string }>;
};

export type NormalizedRecordObservationToolInput = {
  observation: RawObservation;
  cwd?: string;
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

export async function recordObservationCandidateToolAsync(
  rawInput: unknown,
  services?: RecordObservationServices
): Promise<RecordObservationToolResult> {
  return recordObservationToolAsync(rawInput, "candidate", services);
}

export async function recordObservationVerifiedToolAsync(
  rawInput: unknown,
  services?: RecordObservationServices
): Promise<RecordObservationToolResult> {
  return recordObservationToolAsync(rawInput, "verified", services);
}

function recordObservationTool(
  rawInput: unknown,
  trust: RawObservationTrust,
  services?: RecordObservationServices
): RecordObservationToolResult {
  const input = normalizeRecordObservationToolInput(rawInput, trust);
  const result = recordRawObservation({
    observation: input.observation,
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(services !== undefined ? { services } : {})
  });

  return {
    recorded: true,
    path: result.path,
    relative_path: result.relativePath,
    findings: result.findings
  };
}

async function recordObservationToolAsync(
  rawInput: unknown,
  trust: RawObservationTrust,
  services?: RecordObservationServices
): Promise<RecordObservationToolResult> {
  const input = normalizeRecordObservationToolInput(rawInput, trust);
  const result = await recordRawObservationAsync({
    observation: input.observation,
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(services !== undefined ? { services } : {})
  });

  return {
    recorded: true,
    path: result.path,
    relative_path: result.relativePath,
    findings: result.findings
  };
}

export function normalizeRecordObservationToolInput(
  rawInput: unknown,
  trust: RawObservationTrust
): NormalizedRecordObservationToolInput {
  if (!isRecord(rawInput)) {
    throw new Error("record_observation input must be an object");
  }

  const cwd = getOptionalString(rawInput, "cwd");

  return {
    observation: validateRawObservation({
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
    }),
    ...(cwd !== undefined ? { cwd } : {})
  };
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
