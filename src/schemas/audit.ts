import { RECORD_STATES, type RecordState } from "./normalized-record.js";
import { isNonEmptyString, isRecord, optionalStringArray } from "./validation.js";

export const AUDIT_ACTIONS = [
  "created",
  "updated",
  "state_changed",
  "dropped",
  "contested",
  "invalidated",
  "archived"
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export type AuditState = RecordState | "candidate";

export type AuditLogEntry = {
  schema_version: 1;
  id: string;
  at: string;
  action: AuditAction;
  item_id?: string;
  before_state?: AuditState;
  after_state?: AuditState;
  reason?: string;
  source_event_ids: string[];
  run_id?: string;
};

export function validateAuditLogEntry(value: unknown): AuditLogEntry {
  if (!isRecord(value)) {
    throw new Error("audit entry must be an object");
  }

  if (value.schema_version !== 1) {
    throw new Error("audit entry schema_version must be 1");
  }

  if (!isAuditAction(value.action)) {
    throw new Error("audit entry action is invalid");
  }

  const entry: AuditLogEntry = {
    schema_version: 1,
    id: requiredString(value.id, "id"),
    at: requiredString(value.at, "at"),
    action: value.action,
    source_event_ids: optionalStringArray(value.source_event_ids) ?? []
  };

  if (value.item_id !== undefined) {
    entry.item_id = requiredString(value.item_id, "item_id");
  }

  if (value.before_state !== undefined) {
    if (!isAuditState(value.before_state)) {
      throw new Error("audit entry before_state is invalid");
    }
    entry.before_state = value.before_state;
  }

  if (value.after_state !== undefined) {
    if (!isAuditState(value.after_state)) {
      throw new Error("audit entry after_state is invalid");
    }
    entry.after_state = value.after_state;
  }

  if (value.reason !== undefined) {
    entry.reason = requiredString(value.reason, "reason");
  }

  if (value.run_id !== undefined) {
    entry.run_id = requiredString(value.run_id, "run_id");
  }

  return entry;
}

function isAuditAction(value: unknown): value is AuditAction {
  return typeof value === "string" && AUDIT_ACTIONS.includes(value as AuditAction);
}

function isAuditState(value: unknown): value is AuditState {
  return (
    value === "candidate" ||
    (typeof value === "string" && RECORD_STATES.includes(value as RecordState))
  );
}

function requiredString(value: unknown, name: string): string {
  if (!isNonEmptyString(value)) {
    throw new Error(`audit entry ${name} must be a non-empty string`);
  }

  return value;
}
