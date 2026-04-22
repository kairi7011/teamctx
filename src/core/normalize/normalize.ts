import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { getOriginRemote, getRepoRoot } from "../../adapters/git/local-git.js";
import { normalizeGitHubRepo } from "../../adapters/git/repo-url.js";
import { validateAuditLogEntry, type AuditLogEntry } from "../../schemas/audit.js";
import {
  validateNormalizedRecord,
  type KnowledgeKind,
  type NormalizedRecord,
  type Scope
} from "../../schemas/normalized-record.js";
import { validateRawObservation, type RawObservation } from "../../schemas/observation.js";
import type { Binding } from "../../schemas/types.js";
import { findBinding } from "../binding/local-bindings.js";
import { scanRawObservation } from "../policy/redaction-policy.js";
import { resolveStoreRoot } from "../store/layout.js";
import { calculateConfidence } from "./confidence.js";

export type NormalizeStoreResult = {
  normalizedAt: string;
  rawEventsRead: number;
  recordsWritten: number;
  droppedEvents: number;
  auditEntriesWritten: number;
};

export type NormalizeServices = {
  getRepoRoot: (cwd?: string) => string;
  getOriginRemote: (cwd?: string) => string;
  findBinding: (repo: string) => Binding | undefined;
};

export type NormalizeOptions = {
  cwd?: string;
  now?: () => Date;
  services?: NormalizeServices;
};

const NORMALIZER_VERSION = "0.1.0";

export const NORMALIZED_FILE_BY_KIND: Record<KnowledgeKind, string> = {
  fact: "facts.jsonl",
  rule: "rules.jsonl",
  pitfall: "pitfalls.jsonl",
  decision: "decisions.jsonl",
  workflow: "workflows.jsonl",
  glossary: "glossary.jsonl"
};

const defaultServices: NormalizeServices = {
  getRepoRoot,
  getOriginRemote,
  findBinding
};

export function normalizeBoundStore(options: NormalizeOptions = {}): NormalizeStoreResult {
  const services = options.services ?? defaultServices;
  const root = services.getRepoRoot(options.cwd);
  const repo = normalizeGitHubRepo(services.getOriginRemote(root));
  const binding = services.findBinding(repo);

  if (!binding) {
    throw new Error("No teamctx binding found. Run: teamctx bind <store> --path <path>");
  }

  if (binding.contextStore.repo !== repo) {
    throw new Error("normalize currently supports context stores inside the current repository.");
  }

  return normalizeStore({
    repo,
    storeRoot: resolveStoreRoot(root, binding.contextStore.path),
    repoRoot: root,
    ...(options.now !== undefined ? { now: options.now } : {})
  });
}

export function normalizeStore(options: {
  repo: string;
  storeRoot: string;
  repoRoot?: string;
  now?: () => Date;
}): NormalizeStoreResult {
  const now = options.now ?? (() => new Date());
  const runAt = now();
  const runNow = () => runAt;
  const rawEvents = readRawEvents(options.storeRoot);
  const existingRecords = readNormalizedRecords(options.storeRoot);
  const existingRecordsById = new Map(existingRecords.map((record) => [record.id, record]));
  const recordsByKey = new Map<string, NormalizedRecord>();
  const auditEntries: AuditLogEntry[] = [];
  let droppedEvents = 0;

  for (const rawEvent of rawEvents) {
    const normalized = normalizeRawEvent(rawEvent, options.repo, runNow);

    if (normalized.record) {
      const existingRecord = existingRecordsById.get(normalized.record.id);
      const record = existingRecord
        ? preserveExistingState(normalized.record, existingRecord)
        : normalized.record;
      const key = dedupeKey(record);
      const sourceEventIds = rawEvent.observation ? [rawEvent.observation.event_id] : [];

      if (!recordsByKey.has(key)) {
        recordsByKey.set(key, record);

        if (!existingRecord) {
          auditEntries.push(
            createAuditEntry({
              action: "created",
              itemId: record.id,
              afterState: "active",
              sourceEventIds,
              reason: "evidence minimum check passed",
              now: runNow
            })
          );
        }
      }
    } else {
      droppedEvents += 1;
      auditEntries.push(
        createAuditEntry({
          action: "dropped",
          sourceEventIds: rawEvent.observation ? [rawEvent.observation.event_id] : [],
          reason: normalized.reason,
          now: runNow
        })
      );
    }
  }

  const records = applyStateTransitions({
    records: [...recordsByKey.values()],
    existingRecordsById,
    ...(options.repoRoot !== undefined ? { repoRoot: options.repoRoot } : {}),
    auditEntries,
    now: runNow
  }).sort((left, right) => left.id.localeCompare(right.id));
  writeNormalizedRecords(options.storeRoot, records);
  appendAuditEntries(options.storeRoot, auditEntries);

  const result = {
    normalizedAt: runAt.toISOString(),
    rawEventsRead: rawEvents.length,
    recordsWritten: records.length,
    droppedEvents,
    auditEntriesWritten: auditEntries.length
  };
  writeLastNormalizeResult(options.storeRoot, result);

  return result;
}

function preserveExistingState(
  record: NormalizedRecord,
  existingRecord: NormalizedRecord
): NormalizedRecord {
  if (existingRecord.state === "active") {
    return record;
  }

  return {
    ...record,
    state: existingRecord.state,
    conflicts_with: existingRecord.conflicts_with
  };
}

function applyStateTransitions(options: {
  records: NormalizedRecord[];
  existingRecordsById: Map<string, NormalizedRecord>;
  repoRoot?: string;
  auditEntries: AuditLogEntry[];
  now: () => Date;
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
          now: options.now
        })
      );
    }
  }

  applyConflictTransitions({
    recordsById,
    existingRecordsById: options.existingRecordsById,
    auditEntries: options.auditEntries,
    now: options.now
  });

  if (options.repoRoot !== undefined) {
    for (const record of recordsById.values()) {
      if (record.state === "active" && hasOnlyMissingFileEvidence(record, options.repoRoot)) {
        recordsById.set(
          record.id,
          transitionRecord({
            record,
            afterState: "stale",
            reason: "all file-backed evidence paths are missing",
            existingRecordsById: options.existingRecordsById,
            auditEntries: options.auditEntries,
            now: options.now
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
          now: options.now
        })
      );
    }
  }
}

function transitionRecord(options: {
  record: NormalizedRecord;
  action?: AuditLogEntry["action"];
  afterState: NormalizedRecord["state"];
  reason: string;
  existingRecordsById: Map<string, NormalizedRecord>;
  auditEntries: AuditLogEntry[];
  now: () => Date;
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
      now: options.now
    })
  );

  return {
    ...options.record,
    state: options.afterState
  };
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

function areConflictingRecords(left: NormalizedRecord, right: NormalizedRecord): boolean {
  if (left.kind !== right.kind || scopeKey(left.scope) !== scopeKey(right.scope)) {
    return false;
  }

  const leftText = canonicalText(left.text);
  const rightText = canonicalText(right.text);

  return (
    stripNegation(leftText) === stripNegation(rightText) &&
    hasNegation(leftText) !== hasNegation(rightText)
  );
}

function hasOnlyMissingFileEvidence(record: NormalizedRecord, repoRoot: string): boolean {
  const fileEvidence = record.evidence.filter((evidence) => evidence.file !== undefined);

  return (
    fileEvidence.length > 0 &&
    fileEvidence.every(
      (evidence) => evidence.file !== undefined && !existsSync(join(repoRoot, evidence.file))
    )
  );
}

function normalizeRawEvent(
  rawEvent: RawEventFile,
  repo: string,
  now: () => Date
): { record?: NormalizedRecord; reason: string } {
  if (!rawEvent.observation) {
    return { reason: rawEvent.error ?? "raw event is invalid" };
  }

  const sensitiveReport = scanRawObservation(rawEvent.observation);

  if (sensitiveReport.status === "blocked") {
    return { reason: "blocked sensitive content" };
  }

  const promotableEvidence = rawEvent.observation.evidence.filter(
    (evidence) => evidence.kind !== "manual_assertion"
  );

  if (promotableEvidence.length === 0) {
    return { reason: "evidence minimum check failed" };
  }

  const confidence = calculateConfidence(rawEvent.observation.evidence);
  const record = validateNormalizedRecord({
    id: recordId(rawEvent.observation),
    schema_version: 1,
    normalizer_version: NORMALIZER_VERSION,
    kind: rawEvent.observation.kind,
    state: "active",
    text: rawEvent.observation.text,
    scope: rawEvent.observation.scope ?? emptyScope(),
    evidence: rawEvent.observation.evidence,
    provenance: {
      recorded_by: rawEvent.observation.recorded_by,
      session_id: rawEvent.observation.session_id,
      observed_at: rawEvent.observation.observed_at
    },
    confidence_level: confidence.level,
    confidence_score: confidence.score,
    last_verified_at: now().toISOString(),
    supersedes: rawEvent.observation.supersedes,
    conflicts_with: []
  });

  if (!record.evidence.every((evidence) => !evidence.repo || evidence.repo === repo)) {
    return { reason: "evidence repo does not match bound repo" };
  }

  return { record, reason: "promoted" };
}

type RawEventFile = {
  path: string;
  observation?: RawObservation;
  error?: string;
};

function readRawEvents(storeRoot: string): RawEventFile[] {
  const rawEventsRoot = join(storeRoot, "raw", "events");
  const files = listJsonFiles(rawEventsRoot);

  return files.map((path) => {
    try {
      return {
        path,
        observation: validateRawObservation(JSON.parse(readFileSync(path, "utf8")) as unknown)
      };
    } catch (error) {
      return {
        path,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  });
}

function readNormalizedRecords(storeRoot: string): NormalizedRecord[] {
  return Object.values(NORMALIZED_FILE_BY_KIND).flatMap((file) =>
    readJsonl(join(storeRoot, "normalized", file), validateNormalizedRecord)
  );
}

function listJsonFiles(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
      const path = join(root, entry.name);

      if (entry.isDirectory()) {
        return listJsonFiles(path);
      }

      return entry.isFile() && entry.name.endsWith(".json") ? [path] : [];
    });
  } catch {
    return [];
  }
}

function writeNormalizedRecords(storeRoot: string, records: NormalizedRecord[]): void {
  for (const file of Object.values(NORMALIZED_FILE_BY_KIND)) {
    writeJsonl(join(storeRoot, "normalized", file), []);
  }

  for (const kind of Object.keys(NORMALIZED_FILE_BY_KIND) as KnowledgeKind[]) {
    const kindRecords = records.filter((record) => record.kind === kind);
    writeJsonl(join(storeRoot, "normalized", NORMALIZED_FILE_BY_KIND[kind]), kindRecords);
  }
}

function appendAuditEntries(storeRoot: string, entries: AuditLogEntry[]): void {
  if (entries.length === 0) {
    return;
  }

  const path = join(storeRoot, "audit", "changes.jsonl");
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(
    path,
    `${entries.map((entry) => JSON.stringify(validateAuditLogEntry(entry))).join("\n")}\n`
  );
}

function writeLastNormalizeResult(storeRoot: string, result: NormalizeStoreResult): void {
  const path = join(storeRoot, "indexes", "last-normalize.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

function writeJsonl(path: string, rows: unknown[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length > 0 ? "\n" : ""),
    "utf8"
  );
}

function readJsonl<T>(path: string, validate: (value: unknown) => T): T[] {
  try {
    const content = readFileSync(path, "utf8").trim();

    if (content.length === 0) {
      return [];
    }

    return content.split("\n").map((line) => validate(JSON.parse(line) as unknown));
  } catch {
    return [];
  }
}

function createAuditEntry(options: {
  action: AuditLogEntry["action"];
  itemId?: string;
  beforeState?: AuditLogEntry["before_state"];
  afterState?: AuditLogEntry["after_state"];
  sourceEventIds: string[];
  reason: string;
  now: () => Date;
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
    id: `audit-${hash(idSource).slice(0, 16)}`,
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

  return validateAuditLogEntry(entry);
}

function recordId(observation: RawObservation): string {
  return `${observation.kind}-${hash(
    JSON.stringify({
      kind: observation.kind,
      text: observation.text,
      scope: observation.scope ?? emptyScope()
    })
  ).slice(0, 16)}`;
}

function dedupeKey(record: NormalizedRecord): string {
  return JSON.stringify({
    kind: record.kind,
    text: canonicalText(record.text),
    scope: scopeKey(record.scope)
  });
}

function canonicalText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function hasNegation(value: string): boolean {
  return value.split(" ").some((token) => NEGATION_TOKENS.has(token));
}

function stripNegation(value: string): string {
  return value
    .split(" ")
    .filter((token) => !NEGATION_TOKENS.has(token))
    .join(" ");
}

function scopeKey(scope: Scope): string {
  return JSON.stringify({
    paths: [...scope.paths].sort(),
    domains: [...scope.domains].sort(),
    symbols: [...scope.symbols].sort(),
    tags: [...scope.tags].sort()
  });
}

function emptyScope(): Scope {
  return {
    paths: [],
    domains: [],
    symbols: [],
    tags: []
  };
}

const NEGATION_TOKENS = new Set(["not", "never", "without", "disable", "disabled", "avoid"]);

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
