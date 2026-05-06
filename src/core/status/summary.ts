import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ContextStoreAdapter } from "../../adapters/store/context-store.js";
import { NORMALIZED_FILE_BY_KIND, type NormalizeStoreResult } from "../normalize/normalize.js";
import {
  NORMALIZE_LEASE_PATH,
  readNormalizeLeaseStatus,
  readNormalizeLeaseStatusFromContent,
  type NormalizeLeaseStatus
} from "../store/lease.js";
import { validateAuditLogEntry, type AuditLogEntry } from "../../schemas/audit.js";
import type { Evidence } from "../../schemas/evidence.js";
import {
  validateNormalizedRecord,
  type ConfidenceLevel,
  type KnowledgeKind,
  type NormalizedRecord,
  type RecordState,
  type Scope
} from "../../schemas/normalized-record.js";
import {
  parseProjectPolicy,
  PROJECT_POLICY_FILE,
  type BackgroundJobType,
  type GovernanceLevel,
  type ProjectPolicy
} from "../../schemas/project-policy.js";
import { isRecord } from "../../schemas/validation.js";

export type StatusSummaryOptions = {
  storeRoot: string;
  recentLimit?: number;
  now?: () => Date;
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
  valid_from?: string;
  valid_until?: string;
  invalidated_by?: string;
  evidence: Evidence[];
  conflicts_with: string[];
};

export type ContestedItemSummary = StatusItemSummary & {
  competing_items: StatusItemSummary[];
  contest_audit_entries: AuditLogEntry[];
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

export type ProjectPolicyStatus =
  | {
      state: "valid";
      path: string;
      governance_level: GovernanceLevel;
      candidate_automation_enabled: boolean;
      candidate_automation_allowed_kinds: KnowledgeKind[];
      candidate_automation_max_items_per_session: number;
      high_impact_kinds: KnowledgeKind[];
      high_impact_require_reviewer: boolean;
      background_jobs_enabled: boolean;
      background_job_types: BackgroundJobType[];
      warnings: string[];
    }
  | {
      state: "missing";
      path: string;
      warnings: string[];
    }
  | {
      state: "invalid";
      path: string;
      error: string;
      warnings: string[];
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
    promoted_records: number;
    dropped_events: number;
  };
  recent_promoted_items: PromotedItemSummary[];
  contested_items: ContestedItemSummary[];
  dropped_items: DroppedItemSummary[];
  stale_items: StatusItemSummary[];
  normalize_lease: NormalizeLeaseStatus;
  policy: ProjectPolicyStatus;
  index_warnings: string[];
  recovery_suggestions: string[];
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
    indexWarnings: readIndexWarnings(options.storeRoot),
    normalizeLease: readLocalNormalizeLeaseStatus(options.storeRoot, options.now),
    policy: readLocalProjectPolicyStatus(options.storeRoot),
    recentLimit
  });
}

export async function summarizeContextStoreAdapter(options: {
  store: ContextStoreAdapter;
  recentLimit?: number;
  now?: () => Date;
}): Promise<StatusSummary> {
  const recentLimit = options.recentLimit ?? DEFAULT_RECENT_LIMIT;
  const records = await readNormalizedRecordsFromAdapter(options.store);
  const auditEntries = await readAuditEntriesFromAdapter(options.store);

  return buildStatusSummary({
    records,
    auditEntries,
    lastNormalizeResult: await readLastNormalizeResultFromAdapter(options.store),
    indexWarnings: await readIndexWarningsFromAdapter(options.store),
    normalizeLease: await readNormalizeLeaseStatus({
      store: options.store,
      ...(options.now !== undefined ? { now: options.now } : {})
    }),
    policy: await readProjectPolicyStatusFromAdapter(options.store),
    recentLimit
  });
}

function readLocalNormalizeLeaseStatus(
  storeRoot: string,
  now: (() => Date) | undefined
): NormalizeLeaseStatus {
  const path = join(storeRoot, NORMALIZE_LEASE_PATH);

  if (!existsSync(path)) {
    return { state: "none" };
  }

  return readNormalizeLeaseStatusFromContent(readFileSync(path, "utf8"), now ?? (() => new Date()));
}

function readLocalProjectPolicyStatus(storeRoot: string): ProjectPolicyStatus {
  const path = join(storeRoot, PROJECT_POLICY_FILE);

  if (!existsSync(path)) {
    return missingProjectPolicyStatus();
  }

  return projectPolicyStatusFromContent(readFileSync(path, "utf8"), PROJECT_POLICY_FILE);
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

function readIndexWarnings(storeRoot: string): string[] {
  const lastNormalize = readLastNormalizeResult(storeRoot);

  if (lastNormalize === null) {
    return [];
  }

  return INDEX_FILES.flatMap((file) =>
    indexWarning(file.label, lastNormalize.normalizedAt, readIndexGeneratedAt(storeRoot, file.path))
  );
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

async function readIndexWarningsFromAdapter(store: ContextStoreAdapter): Promise<string[]> {
  const lastNormalize = await readLastNormalizeResultFromAdapter(store);

  if (lastNormalize === null) {
    return [];
  }

  const warnings: string[] = [];

  for (const file of INDEX_FILES) {
    warnings.push(
      ...indexWarning(
        file.label,
        lastNormalize.normalizedAt,
        await readIndexGeneratedAtFromAdapter(store, file.path)
      )
    );
  }

  return warnings;
}

async function readProjectPolicyStatusFromAdapter(
  store: ContextStoreAdapter
): Promise<ProjectPolicyStatus> {
  const file = await store.readText(PROJECT_POLICY_FILE);

  if (!file) {
    return missingProjectPolicyStatus();
  }

  return projectPolicyStatusFromContent(file.content, PROJECT_POLICY_FILE);
}

function projectPolicyStatusFromContent(content: string, path: string): ProjectPolicyStatus {
  try {
    const policy = parseProjectPolicy(content);

    return {
      state: "valid",
      path,
      governance_level: policy.governance_level,
      candidate_automation_enabled: policy.candidate_automation.enabled,
      candidate_automation_allowed_kinds: policy.candidate_automation.allowed_kinds,
      candidate_automation_max_items_per_session: policy.candidate_automation.max_items_per_session,
      high_impact_kinds: policy.high_impact.kinds,
      high_impact_require_reviewer: policy.high_impact.require_reviewer,
      background_jobs_enabled: policy.background_jobs.enabled,
      background_job_types: policy.background_jobs.allowed_types,
      warnings: projectPolicyWarnings(policy)
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return {
      state: "invalid",
      path,
      error: message,
      warnings: [
        `Invalid ${PROJECT_POLICY_FILE}; governed capture and background jobs remain disabled.`
      ]
    };
  }
}

function missingProjectPolicyStatus(): ProjectPolicyStatus {
  return {
    state: "missing",
    path: PROJECT_POLICY_FILE,
    warnings: [
      `Missing ${PROJECT_POLICY_FILE}; governed capture and background jobs remain disabled.`
    ]
  };
}

function projectPolicyWarnings(policy: ProjectPolicy): string[] {
  const warnings: string[] = [];

  if (policy.background_jobs.enabled) {
    warnings.push("Background jobs are configured but no teamctx job runner is implemented yet.");
  }

  if (policy.candidate_automation.enabled && policy.governance_level === "strict_review") {
    warnings.push(
      "Candidate automation is enabled under strict review; writes should remain proposals."
    );
  }

  return warnings;
}

function readIndexGeneratedAt(
  storeRoot: string,
  path: string
): { generatedAt?: string; error?: string; missing?: true } {
  const filePath = join(storeRoot, path);

  if (!existsSync(filePath)) {
    return { missing: true };
  }

  try {
    return generatedAtResult(JSON.parse(readFileSync(filePath, "utf8")) as unknown);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function readIndexGeneratedAtFromAdapter(
  store: ContextStoreAdapter,
  path: string
): Promise<{ generatedAt?: string; error?: string; missing?: true }> {
  const file = await store.readText(path);

  if (!file) {
    return { missing: true };
  }

  try {
    return generatedAtResult(JSON.parse(file.content) as unknown);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
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
  indexWarnings: string[];
  normalizeLease: NormalizeLeaseStatus;
  policy: ProjectPolicyStatus;
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
      promoted_records: createdEntries.length,
      dropped_events: droppedEntries.length
    },
    recent_promoted_items: sortAuditEntriesNewestFirst(createdEntries)
      .slice(0, options.recentLimit)
      .map((entry) => promotedSummary(entry, recordsById)),
    contested_items: options.records
      .filter((record) => record.state === "contested")
      .map((record) => contestedItemSummary(record, recordsById, options.auditEntries))
      .slice(0, options.recentLimit),
    dropped_items: sortAuditEntriesNewestFirst(droppedEntries)
      .slice(0, options.recentLimit)
      .map(droppedSummary),
    stale_items: options.records
      .filter((record) => record.state === "stale")
      .map(itemSummary)
      .slice(0, options.recentLimit),
    normalize_lease: options.normalizeLease,
    policy: options.policy,
    index_warnings: options.indexWarnings,
    recovery_suggestions: recoverySuggestions(
      options.indexWarnings,
      options.normalizeLease,
      options.policy
    )
  };
}

function recoverySuggestions(
  indexWarnings: string[],
  normalizeLease: NormalizeLeaseStatus,
  policy: ProjectPolicyStatus
): string[] {
  const suggestions =
    indexWarnings.length > 0
      ? ["Run `teamctx normalize` to refresh normalized records and indexes."]
      : [];

  if (normalizeLease.state === "expired") {
    suggestions.push(
      "A normalize lease is expired; rerun `teamctx normalize --lease` to take it over, or remove `locks/normalize.json` after confirming no writer is running."
    );
  }

  if (policy.state === "missing") {
    suggestions.push("Run `teamctx init-store` to add the default project policy file.");
  } else if (policy.state === "invalid") {
    suggestions.push(`Fix ${policy.path} before enabling governed capture or background jobs.`);
  }

  return suggestions;
}

const INDEX_FILES = [
  { label: "path index", path: "indexes/path-index.json" },
  { label: "symbol index", path: "indexes/symbol-index.json" },
  { label: "text index", path: "indexes/text-index.json" },
  { label: "episode index", path: "indexes/episode-index.json" }
];

function generatedAtResult(value: unknown): { generatedAt?: string; error?: string } {
  if (!isRecord(value)) {
    return { error: "index file must be an object" };
  }

  return typeof value.generated_at === "string" && value.generated_at.length > 0
    ? { generatedAt: value.generated_at }
    : { error: "index generated_at is missing" };
}

function indexWarning(
  label: string,
  lastNormalizeAt: string,
  result: { generatedAt?: string; error?: string; missing?: true }
): string[] {
  if (result.missing === true) {
    return [`${label} is missing after last normalize ${lastNormalizeAt}`];
  }

  if (result.error !== undefined) {
    return [`${label} is invalid after last normalize ${lastNormalizeAt}: ${result.error}`];
  }

  if (result.generatedAt !== lastNormalizeAt) {
    return [
      `${label} generated_at ${result.generatedAt ?? "(unknown)"} differs from last normalize ${lastNormalizeAt}`
    ];
  }

  return [];
}

function validateLastNormalizeResult(value: unknown): NormalizeStoreResult {
  if (!isRecord(value)) {
    throw new Error("last normalize result must be an object");
  }

  return {
    runId: typeof value.runId === "string" && value.runId.length > 0 ? value.runId : "legacy",
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
    evidence: record.evidence,
    confidence_level: record.confidence_level,
    conflicts_with: record.conflicts_with
  };

  if (record.confidence_score !== undefined) {
    summary.confidence_score = record.confidence_score;
  }

  if (record.last_verified_at !== undefined) {
    summary.last_verified_at = record.last_verified_at;
  }
  if (record.valid_from !== undefined) {
    summary.valid_from = record.valid_from;
  }
  if (record.valid_until !== undefined) {
    summary.valid_until = record.valid_until;
  }
  if (record.invalidated_by !== undefined) {
    summary.invalidated_by = record.invalidated_by;
  }

  return summary;
}

function contestedItemSummary(
  record: NormalizedRecord,
  recordsById: Map<string, NormalizedRecord>,
  auditEntries: AuditLogEntry[]
): ContestedItemSummary {
  return {
    ...itemSummary(record),
    competing_items: record.conflicts_with
      .flatMap((itemId) => {
        const competingRecord = recordsById.get(itemId);

        return competingRecord ? [itemSummary(competingRecord)] : [];
      })
      .sort((left, right) => left.item_id.localeCompare(right.item_id)),
    contest_audit_entries: sortAuditEntriesNewestFirst(
      auditEntries.filter((entry) => entry.action === "contested" && entry.item_id === record.id)
    )
  };
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
