import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ContextStoreAdapter } from "../../adapters/store/context-store.js";
import { NORMALIZED_FILE_BY_KIND, type NormalizeStoreResult } from "../normalize/normalize.js";
import { validateAuditLogEntry, type AuditLogEntry } from "../../schemas/audit.js";
import {
  validateNormalizedRecord,
  type ConfidenceLevel,
  type KnowledgeKind,
  type NormalizedRecord,
  type RecordState,
  type Scope
} from "../../schemas/normalized-record.js";
import { isRecord } from "../../schemas/validation.js";

export type StatusSummaryOptions = {
  storeRoot: string;
  recentLimit?: number;
};

export type StatusItemSummary = {
  item_id: string;
  kind: KnowledgeKind;
  state: RecordState;
  text: string;
  scope: Scope;
  confidence_level: ConfidenceLevel;
  confidence_score?: number;
  last_verified_at?: string;
  conflicts_with: string[];
};

export type PromotedItemSummary = {
  promoted_at: string;
  item_id: string;
  source_event_ids: string[];
  reason?: string;
  record?: StatusItemSummary;
};

export type DroppedItemSummary = {
  dropped_at: string;
  source_event_ids: string[];
  reason?: string;
};

export type StatusSummary = {
  last_normalize_result: NormalizeStoreResult | null;
  counts: {
    total_records: number;
    active_records: number;
    contested_records: number;
    stale_records: number;
    superseded_records: number;
    archived_records: number;
    audit_entries: number;
    dropped_events: number;
  };
  recent_promoted_items: PromotedItemSummary[];
  contested_items: StatusItemSummary[];
  dropped_items: DroppedItemSummary[];
  stale_items: StatusItemSummary[];
};

const DEFAULT_RECENT_LIMIT = 5;

export function summarizeContextStore(options: StatusSummaryOptions): StatusSummary {
  const recentLimit = options.recentLimit ?? DEFAULT_RECENT_LIMIT;
  const records = readNormalizedRecords(options.storeRoot);
  const auditEntries = readAuditEntries(options.storeRoot);

  return buildStatusSummary({
    records,
    auditEntries,
    lastNormalizeResult: readLastNormalizeResult(options.storeRoot),
    recentLimit
  });
}

export async function summarizeContextStoreAdapter(options: {
  store: ContextStoreAdapter;
  recentLimit?: number;
}): Promise<StatusSummary> {
  const recentLimit = options.recentLimit ?? DEFAULT_RECENT_LIMIT;
  const records = await readNormalizedRecordsFromAdapter(options.store);
  const auditEntries = await readAuditEntriesFromAdapter(options.store);

  return buildStatusSummary({
    records,
    auditEntries,
    lastNormalizeResult: await readLastNormalizeResultFromAdapter(options.store),
    recentLimit
  });
}

function readNormalizedRecords(storeRoot: string): NormalizedRecord[] {
  return Object.values(NORMALIZED_FILE_BY_KIND).flatMap((file) =>
    readJsonl(join(storeRoot, "normalized", file), validateNormalizedRecord)
  );
}

function readAuditEntries(storeRoot: string): AuditLogEntry[] {
  return readJsonl(join(storeRoot, "audit", "changes.jsonl"), validateAuditLogEntry);
}

async function readNormalizedRecordsFromAdapter(
  store: ContextStoreAdapter
): Promise<NormalizedRecord[]> {
  const groups = await Promise.all(
    Object.values(NORMALIZED_FILE_BY_KIND).map((file) =>
      readJsonlFromAdapter(store, `normalized/${file}`, validateNormalizedRecord)
    )
  );

  return groups.flat();
}

async function readAuditEntriesFromAdapter(store: ContextStoreAdapter): Promise<AuditLogEntry[]> {
  return readJsonlFromAdapter(store, "audit/changes.jsonl", validateAuditLogEntry);
}

function readLastNormalizeResult(storeRoot: string): NormalizeStoreResult | null {
  const path = join(storeRoot, "indexes", "last-normalize.json");

  if (!existsSync(path)) {
    return null;
  }

  return validateLastNormalizeResult(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

async function readLastNormalizeResultFromAdapter(
  store: ContextStoreAdapter
): Promise<NormalizeStoreResult | null> {
  const file = await store.readText("indexes/last-normalize.json");

  if (!file) {
    return null;
  }

  return validateLastNormalizeResult(JSON.parse(file.content) as unknown);
}

function readJsonl<T>(path: string, validate: (value: unknown) => T): T[] {
  if (!existsSync(path)) {
    return [];
  }

  const content = readFileSync(path, "utf8").trim();

  if (content.length === 0) {
    return [];
  }

  return content.split("\n").map((line) => validate(JSON.parse(line) as unknown));
}

async function readJsonlFromAdapter<T>(
  store: ContextStoreAdapter,
  path: string,
  validate: (value: unknown) => T
): Promise<T[]> {
  const file = await store.readText(path);

  if (!file) {
    return [];
  }

  const content = file.content.trim();

  if (content.length === 0) {
    return [];
  }

  return content.split("\n").map((line) => validate(JSON.parse(line) as unknown));
}

function buildStatusSummary(options: {
  records: NormalizedRecord[];
  auditEntries: AuditLogEntry[];
  lastNormalizeResult: NormalizeStoreResult | null;
  recentLimit: number;
}): StatusSummary {
  const recordsById = new Map(options.records.map((record) => [record.id, record]));
  const droppedEntries = options.auditEntries.filter((entry) => entry.action === "dropped");
  const createdEntries = options.auditEntries.filter(
    (entry) => entry.action === "created" && entry.item_id !== undefined
  );

  return {
    last_normalize_result: options.lastNormalizeResult,
    counts: {
      total_records: options.records.length,
      active_records: options.records.filter((record) => record.state === "active").length,
      contested_records: options.records.filter((record) => record.state === "contested").length,
      stale_records: options.records.filter((record) => record.state === "stale").length,
      superseded_records: options.records.filter((record) => record.state === "superseded").length,
      archived_records: options.records.filter((record) => record.state === "archived").length,
      audit_entries: options.auditEntries.length,
      dropped_events: droppedEntries.length
    },
    recent_promoted_items: sortAuditEntriesNewestFirst(createdEntries)
      .slice(0, options.recentLimit)
      .map((entry) => promotedSummary(entry, recordsById)),
    contested_items: options.records
      .filter((record) => record.state === "contested")
      .map(itemSummary)
      .slice(0, options.recentLimit),
    dropped_items: sortAuditEntriesNewestFirst(droppedEntries)
      .slice(0, options.recentLimit)
      .map(droppedSummary),
    stale_items: options.records
      .filter((record) => record.state === "stale")
      .map(itemSummary)
      .slice(0, options.recentLimit)
  };
}

function validateLastNormalizeResult(value: unknown): NormalizeStoreResult {
  if (!isRecord(value)) {
    throw new Error("last normalize result must be an object");
  }

  return {
    normalizedAt: requiredString(value.normalizedAt, "normalizedAt"),
    rawEventsRead: requiredInteger(value.rawEventsRead, "rawEventsRead"),
    recordsWritten: requiredInteger(value.recordsWritten, "recordsWritten"),
    droppedEvents: requiredInteger(value.droppedEvents, "droppedEvents"),
    auditEntriesWritten: requiredInteger(value.auditEntriesWritten, "auditEntriesWritten")
  };
}

function promotedSummary(
  entry: AuditLogEntry,
  recordsById: Map<string, NormalizedRecord>
): PromotedItemSummary {
  const itemId = entry.item_id ?? "";
  const record = recordsById.get(itemId);
  const summary: PromotedItemSummary = {
    promoted_at: entry.at,
    item_id: itemId,
    source_event_ids: entry.source_event_ids
  };

  if (entry.reason !== undefined) {
    summary.reason = entry.reason;
  }

  if (record !== undefined) {
    summary.record = itemSummary(record);
  }

  return summary;
}

function droppedSummary(entry: AuditLogEntry): DroppedItemSummary {
  const summary: DroppedItemSummary = {
    dropped_at: entry.at,
    source_event_ids: entry.source_event_ids
  };

  if (entry.reason !== undefined) {
    summary.reason = entry.reason;
  }

  return summary;
}

function itemSummary(record: NormalizedRecord): StatusItemSummary {
  const summary: StatusItemSummary = {
    item_id: record.id,
    kind: record.kind,
    state: record.state,
    text: record.text,
    scope: record.scope,
    confidence_level: record.confidence_level,
    conflicts_with: record.conflicts_with
  };

  if (record.confidence_score !== undefined) {
    summary.confidence_score = record.confidence_score;
  }

  if (record.last_verified_at !== undefined) {
    summary.last_verified_at = record.last_verified_at;
  }

  return summary;
}

function sortAuditEntriesNewestFirst(entries: AuditLogEntry[]): AuditLogEntry[] {
  return [...entries].sort((left, right) => right.at.localeCompare(left.at));
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`last normalize result ${name} must be a non-empty string`);
  }

  return value;
}

function requiredInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`last normalize result ${name} must be a non-negative integer`);
  }

  return value;
}
