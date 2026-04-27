import { sha256Hex } from "../store/hash.js";
import { validateAuditLogEntry, type AuditLogEntry } from "../../schemas/audit.js";
import type { NormalizedRecord } from "../../schemas/normalized-record.js";
import { areConflictingRecords } from "./dedupe.js";
import { staleReason } from "./stale.js";

export function applyStateTransitions(options: {
  records: NormalizedRecord[];
  existingRecordsById: Map<string, NormalizedRecord>;
  repoRoot?: string;
  auditEntries: AuditLogEntry[];
  now: () => Date;
  runId: string;
}): NormalizedRecord[] {
  const recordsById = new Map(options.records.map((record) => [record.id, record]));
  const supersededIds = new Set<string>();

  for (const record of options.records) {
    for (const supersededId of record.supersedes) {
      supersededIds.add(supersededId);
    }
  }

  for (const supersededId of supersededIds) {
    const record = recordsById.get(supersededId);

    if (record?.state === "active") {
      recordsById.set(
        supersededId,
        transitionRecord({
          record,
          afterState: "superseded",
          reason: "superseded by a newer normalized record",
          existingRecordsById: options.existingRecordsById,
          auditEntries: options.auditEntries,
          now: options.now,
          runId: options.runId
        })
      );
    }
  }

  applyConflictTransitions({
    recordsById,
    existingRecordsById: options.existingRecordsById,
    auditEntries: options.auditEntries,
    now: options.now,
    runId: options.runId
  });

  if (options.repoRoot !== undefined) {
    for (const record of recordsById.values()) {
      const reason = record.state === "active" ? staleReason(record, options.repoRoot) : undefined;

      if (reason !== undefined) {
        recordsById.set(
          record.id,
          transitionRecord({
            record,
            afterState: "stale",
            reason,
            existingRecordsById: options.existingRecordsById,
            auditEntries: options.auditEntries,
            now: options.now,
            runId: options.runId
          })
        );
      }
    }
  }

  return [...recordsById.values()];
}

function applyConflictTransitions(options: {
  recordsById: Map<string, NormalizedRecord>;
  existingRecordsById: Map<string, NormalizedRecord>;
  auditEntries: AuditLogEntry[];
  now: () => Date;
  runId: string;
}): void {
  const activeRecords = [...options.recordsById.values()].filter(
    (record) => record.state === "active"
  );
  const conflictsById = new Map<string, Set<string>>();

  for (let leftIndex = 0; leftIndex < activeRecords.length; leftIndex += 1) {
    const left = activeRecords[leftIndex];

    if (!left) {
      continue;
    }

    for (let rightIndex = leftIndex + 1; rightIndex < activeRecords.length; rightIndex += 1) {
      const right = activeRecords[rightIndex];

      if (right && areConflictingRecords(left, right)) {
        addConflict(conflictsById, left.id, right.id);
        addConflict(conflictsById, right.id, left.id);
      }
    }
  }

  for (const [itemId, conflicts] of conflictsById) {
    const record = options.recordsById.get(itemId);

    if (record?.state === "active") {
      options.recordsById.set(
        itemId,
        transitionRecord({
          record: {
            ...record,
            conflicts_with: [...new Set([...record.conflicts_with, ...conflicts])].sort()
          },
          action: "contested",
          afterState: "contested",
          reason: "conflicting same-scope assertion detected",
          existingRecordsById: options.existingRecordsById,
          auditEntries: options.auditEntries,
          now: options.now,
          runId: options.runId
        })
      );
    }
  }
}

export function transitionRecord(options: {
  record: NormalizedRecord;
  action?: AuditLogEntry["action"];
  afterState: NormalizedRecord["state"];
  reason: string;
  existingRecordsById: Map<string, NormalizedRecord>;
  auditEntries: AuditLogEntry[];
  now: () => Date;
  runId: string;
}): NormalizedRecord {
  const existingRecord = options.existingRecordsById.get(options.record.id);
  const beforeState = existingRecord?.state ?? options.record.state;

  if (beforeState === options.afterState) {
    return options.record;
  }

  options.auditEntries.push(
    createAuditEntry({
      action: options.action ?? "state_changed",
      itemId: options.record.id,
      beforeState,
      afterState: options.afterState,
      sourceEventIds: options.record.evidence.flatMap((evidence) =>
        evidence.file ? [`file:${evidence.file}`] : []
      ),
      reason: options.reason,
      now: options.now,
      runId: options.runId
    })
  );

  return {
    ...options.record,
    state: options.afterState,
    ...(options.record.valid_from !== undefined ? { valid_from: options.record.valid_from } : {}),
    ...(options.afterState === "active"
      ? {}
      : {
          valid_until: options.now().toISOString(),
          invalidated_by: options.reason
        })
  };
}

export function createAuditEntry(options: {
  action: AuditLogEntry["action"];
  itemId?: string;
  beforeState?: AuditLogEntry["before_state"];
  afterState?: AuditLogEntry["after_state"];
  sourceEventIds: string[];
  reason: string;
  now: () => Date;
  runId?: string;
}): AuditLogEntry {
  const idSource = [
    options.action,
    options.itemId ?? "",
    options.sourceEventIds.join(","),
    options.reason,
    options.now().toISOString()
  ].join("|");
  const entry: AuditLogEntry = {
    schema_version: 1,
    id: `audit-${sha256Hex(idSource).slice(0, 16)}`,
    at: options.now().toISOString(),
    action: options.action,
    reason: options.reason,
    source_event_ids: options.sourceEventIds
  };

  if (options.itemId !== undefined) {
    entry.item_id = options.itemId;
  }

  if (options.beforeState !== undefined) {
    entry.before_state = options.beforeState;
  }

  if (options.afterState !== undefined) {
    entry.after_state = options.afterState;
  }

  if (options.runId !== undefined) {
    entry.run_id = options.runId;
  }

  return validateAuditLogEntry(entry);
}

function addConflict(
  conflictsById: Map<string, Set<string>>,
  itemId: string,
  conflictId: string
): void {
  const conflicts = conflictsById.get(itemId) ?? new Set<string>();
  conflicts.add(conflictId);
  conflictsById.set(itemId, conflicts);
}
