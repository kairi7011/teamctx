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
import type { ContextStoreAdapter, ContextStoreFile } from "../../adapters/store/context-store.js";
import { getOriginRemote, getRepoRoot, git } from "../../adapters/git/local-git.js";
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
import {
  buildRecordIndexes,
  serializePathIndex,
  serializeSymbolIndex,
  serializeTextIndex,
  matchesPath,
  type PathIndex,
  type SymbolIndex,
  type TextIndex
} from "../indexes/record-index.js";
import {
  buildEpisodeIndex,
  serializeEpisodeIndex,
  type EpisodeIndex
} from "../indexes/episode-index.js";
import { scanRawObservation } from "../policy/redaction-policy.js";
import {
  createContextStoreForBinding,
  type ContextStoreFactoryServices
} from "../store/bound-store.js";
import { resolveStoreRoot } from "../store/layout.js";
import { calculateConfidence } from "./confidence.js";

export type NormalizeStoreResult = {
  runId: string;
  normalizedAt: string;
  rawEventsRead: number;
  recordsWritten: number;
  droppedEvents: number;
  auditEntriesWritten: number;
};

export type NormalizeServices = ContextStoreFactoryServices & {
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

export async function normalizeBoundStoreAsync(
  options: NormalizeOptions = {}
): Promise<NormalizeStoreResult> {
  const services = options.services ?? defaultServices;
  const root = services.getRepoRoot(options.cwd);
  const repo = normalizeGitHubRepo(services.getOriginRemote(root));
  const binding = services.findBinding(repo);

  if (!binding) {
    throw new Error("No teamctx binding found. Run: teamctx bind <store> --path <path>");
  }

  if (binding.contextStore.repo === repo) {
    return normalizeStore({
      repo,
      storeRoot: resolveStoreRoot(root, binding.contextStore.path),
      repoRoot: root,
      ...(options.now !== undefined ? { now: options.now } : {})
    });
  }

  return normalizeContextStore({
    repo,
    repoRoot: root,
    store:
      services.createContextStore?.({ repo, repoRoot: root, binding }) ??
      createContextStoreForBinding({ repo, repoRoot: root, binding }),
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
  const run = normalizeRun({
    repo: options.repo,
    ...(options.repoRoot !== undefined ? { repoRoot: options.repoRoot } : {}),
    now: runNow,
    rawEvents,
    existingRecords
  });
  const indexes = buildRecordIndexes(run.records, run.result.normalizedAt);
  const episodeIndex = buildEpisodeIndex(
    safeEpisodeObservations(rawEvents, options.repo),
    run.result.normalizedAt
  );

  writeNormalizedRecords(options.storeRoot, run.records);
  writeRecordIndexes(options.storeRoot, indexes);
  writeEpisodeIndex(options.storeRoot, episodeIndex);
  appendAuditEntries(options.storeRoot, run.auditEntries);
  writeLastNormalizeResult(options.storeRoot, run.result);

  return run.result;
}

export async function normalizeContextStore(options: {
  repo: string;
  store: ContextStoreAdapter;
  repoRoot?: string;
  now?: () => Date;
}): Promise<NormalizeStoreResult> {
  const now = options.now ?? (() => new Date());
  const runAt = now();
  const runNow = () => runAt;
  const rawEvents = await readRawEventsFromContextStore(options.store);
  const existing = await readNormalizedRecordFilesFromContextStore(options.store);
  const run = normalizeRun({
    repo: options.repo,
    ...(options.repoRoot !== undefined ? { repoRoot: options.repoRoot } : {}),
    now: runNow,
    rawEvents,
    existingRecords: existing.records
  });
  const indexes = buildRecordIndexes(run.records, run.result.normalizedAt);
  const episodeIndex = buildEpisodeIndex(
    safeEpisodeObservations(rawEvents, options.repo),
    run.result.normalizedAt
  );

  await writeNormalizedRecordsToContextStore(options.store, run.records, existing.filesByName);
  await writeRecordIndexesToContextStore(options.store, indexes, run.result.normalizedAt);
  await writeEpisodeIndexToContextStore(options.store, episodeIndex, run.result.normalizedAt);

  if (run.auditEntries.length > 0) {
    await options.store.appendJsonl("audit/changes.jsonl", run.auditEntries, {
      message: `Append teamctx normalize audit ${run.result.normalizedAt}`
    });
  }

  const lastNormalize = await options.store.readText("indexes/last-normalize.json");
  await options.store.writeText(
    "indexes/last-normalize.json",
    `${JSON.stringify(run.result, null, 2)}\n`,
    {
      message: `Record teamctx normalize result ${run.result.normalizedAt}`,
      expectedRevision: lastNormalize?.revision ?? null
    }
  );

  return run.result;
}

function normalizeRun(options: {
  repo: string;
  repoRoot?: string;
  now: () => Date;
  rawEvents: RawEventFile[];
  existingRecords: NormalizedRecord[];
}): { result: NormalizeStoreResult; records: NormalizedRecord[]; auditEntries: AuditLogEntry[] } {
  const runAt = options.now();
  const runNow = () => runAt;
  const rawEvents = options.rawEvents;
  const runId = makeRunId(options.repo, runAt, rawEvents);
  const existingRecords = options.existingRecords;
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
      const key = findDuplicateRecordKey(recordsByKey, record) ?? dedupeKey(record);
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
              now: runNow,
              runId
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
          now: runNow,
          runId
        })
      );
    }
  }

  const records = applyStateTransitions({
    records: [...recordsByKey.values()],
    existingRecordsById,
    ...(options.repoRoot !== undefined ? { repoRoot: options.repoRoot } : {}),
    auditEntries,
    now: runNow,
    runId
  }).sort((left, right) => left.id.localeCompare(right.id));
  const result = {
    runId,
    normalizedAt: runAt.toISOString(),
    rawEventsRead: rawEvents.length,
    recordsWritten: records.length,
    droppedEvents,
    auditEntriesWritten: auditEntries.length
  };

  return { result, records, auditEntries };
}

function makeRunId(repo: string, runAt: Date, rawEvents: RawEventFile[]): string {
  const eventIds = rawEvents
    .map((event) => event.observation?.event_id ?? "")
    .filter((id) => id.length > 0)
    .sort();
  const idSource = [repo, runAt.toISOString(), eventIds.join(",")].join("|");

  return `run-${hash(idSource).slice(0, 16)}`;
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
    ...(existingRecord.valid_from !== undefined ? { valid_from: existingRecord.valid_from } : {}),
    ...(existingRecord.valid_until !== undefined
      ? { valid_until: existingRecord.valid_until }
      : {}),
    ...(existingRecord.invalidated_by !== undefined
      ? { invalidated_by: existingRecord.invalidated_by }
      : {}),
    conflicts_with: existingRecord.conflicts_with
  };
}

function applyStateTransitions(options: {
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

function transitionRecord(options: {
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
  if (left.kind !== right.kind || !scopesOverlap(left.scope, right.scope)) {
    return false;
  }

  const leftText = canonicalText(left.text);
  const rightText = canonicalText(right.text);

  if (hasOrderingConflict(leftText, rightText)) {
    return true;
  }

  return (
    stripNegation(leftText) === stripNegation(rightText) &&
    hasNegation(leftText) !== hasNegation(rightText)
  );
}

function scopesOverlap(left: Scope, right: Scope): boolean {
  if (isGlobalScope(left) || isGlobalScope(right)) {
    return true;
  }

  return (
    pathScopesOverlap(left.paths, right.paths) ||
    normalizedOverlap(left.domains, right.domains, normalizeTextKey) ||
    normalizedOverlap(left.symbols, right.symbols, normalizeSymbolKey) ||
    normalizedOverlap(left.tags, right.tags, normalizeTextKey)
  );
}

function isGlobalScope(scope: Scope): boolean {
  return (
    scope.paths.length === 0 &&
    scope.domains.length === 0 &&
    scope.symbols.length === 0 &&
    scope.tags.length === 0
  );
}

function pathScopesOverlap(left: string[], right: string[]): boolean {
  return left.some((leftPath) =>
    right.some((rightPath) => matchesPath(leftPath, rightPath) || matchesPath(rightPath, leftPath))
  );
}

function normalizedOverlap(
  left: string[],
  right: string[],
  normalize: (value: string) => string
): boolean {
  if (left.length === 0 || right.length === 0) {
    return false;
  }

  const rightKeys = new Set(right.map(normalize));

  return left.some((value) => rightKeys.has(normalize(value)));
}

function normalizeTextKey(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeSymbolKey(value: string): string {
  return value.trim();
}

function staleReason(record: NormalizedRecord, repoRoot: string): string | undefined {
  const fileEvidence = record.evidence.flatMap((evidence) =>
    evidence.file === undefined ? [] : [evidence.file]
  );

  if (fileEvidence.length === 0) {
    return undefined;
  }

  const missingEvidence = fileEvidence.filter((file) => !existsSync(join(repoRoot, file)));

  if (missingEvidence.length === fileEvidence.length) {
    const renamed = renamedEvidencePaths(repoRoot, missingEvidence);

    return renamed.length > 0
      ? `file-backed evidence paths were renamed: ${renamed.join(", ")}`
      : "all file-backed evidence paths are missing";
  }

  if (symbolsAreMissingFromEvidence(record, repoRoot, fileEvidence)) {
    return "scoped symbols are no longer referenced in file-backed evidence";
  }

  return undefined;
}

function renamedEvidencePaths(repoRoot: string, missingEvidence: string[]): string[] {
  const renames = gitRenames(repoRoot);

  return missingEvidence.flatMap((file) => {
    const renamedTo = renames.get(normalizeRepoPath(file));

    return renamedTo === undefined ? [] : [`${file} -> ${renamedTo}`];
  });
}

function symbolsAreMissingFromEvidence(
  record: NormalizedRecord,
  repoRoot: string,
  fileEvidence: string[]
): boolean {
  const symbols = uniqueSorted(record.scope.symbols.map((symbol) => symbol.trim())).filter(
    (symbol) => symbol.length > 0
  );
  const existingFiles = uniqueSorted(fileEvidence).filter((file) =>
    existsSync(join(repoRoot, file))
  );

  if (symbols.length === 0 || existingFiles.length === 0) {
    return false;
  }

  const contents = existingFiles.map((file) => readFileSync(join(repoRoot, file), "utf8"));

  return !symbols.some((symbol) => contents.some((content) => content.includes(symbol)));
}

function gitRenames(repoRoot: string): Map<string, string> {
  try {
    const output = git(["status", "--porcelain=v1", "--renames"], repoRoot);
    const renames = new Map<string, string>();

    for (const line of output.split("\n")) {
      const detail = line.slice(3);
      const separator = " -> ";
      const separatorIndex = detail.indexOf(separator);

      if (separatorIndex === -1) {
        continue;
      }

      renames.set(
        normalizeRepoPath(detail.slice(0, separatorIndex)),
        normalizeRepoPath(detail.slice(separatorIndex + separator.length))
      );
    }

    return renames;
  } catch {
    return new Map();
  }
}

function normalizeRepoPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
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
    valid_from: rawEvent.observation.observed_at,
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

async function readRawEventsFromContextStore(store: ContextStoreAdapter): Promise<RawEventFile[]> {
  const files = (await store.listFiles("raw/events")).filter((path) => path.endsWith(".json"));

  return Promise.all(
    files.map(async (path) => {
      try {
        const file = await store.readText(path);

        if (!file) {
          return { path, error: "raw event file is missing" };
        }

        return {
          path,
          observation: validateRawObservation(JSON.parse(file.content) as unknown)
        };
      } catch (error) {
        return {
          path,
          error: error instanceof Error ? error.message : String(error)
        };
      }
    })
  );
}

function readNormalizedRecords(storeRoot: string): NormalizedRecord[] {
  return Object.values(NORMALIZED_FILE_BY_KIND).flatMap((file) =>
    readJsonl(join(storeRoot, "normalized", file), validateNormalizedRecord)
  );
}

async function readNormalizedRecordFilesFromContextStore(store: ContextStoreAdapter): Promise<{
  records: NormalizedRecord[];
  filesByName: Map<string, ContextStoreFile | undefined>;
}> {
  const records: NormalizedRecord[] = [];
  const filesByName = new Map<string, ContextStoreFile | undefined>();

  for (const file of Object.values(NORMALIZED_FILE_BY_KIND)) {
    const storePath = `normalized/${file}`;
    const storeFile = await store.readText(storePath);
    filesByName.set(file, storeFile);

    for (const line of jsonlLines(storeFile?.content ?? "")) {
      records.push(validateNormalizedRecord(JSON.parse(line) as unknown));
    }
  }

  return { records, filesByName };
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

function writeRecordIndexes(
  storeRoot: string,
  indexes: { pathIndex: PathIndex; symbolIndex: SymbolIndex; textIndex: TextIndex }
): void {
  const root = join(storeRoot, "indexes");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "path-index.json"), serializePathIndex(indexes.pathIndex), "utf8");
  writeFileSync(join(root, "symbol-index.json"), serializeSymbolIndex(indexes.symbolIndex), "utf8");
  writeFileSync(join(root, "text-index.json"), serializeTextIndex(indexes.textIndex), "utf8");
}

function writeEpisodeIndex(storeRoot: string, index: EpisodeIndex): void {
  const root = join(storeRoot, "indexes");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "episode-index.json"), serializeEpisodeIndex(index), "utf8");
}

async function writeNormalizedRecordsToContextStore(
  store: ContextStoreAdapter,
  records: NormalizedRecord[],
  existingFilesByName: Map<string, ContextStoreFile | undefined>
): Promise<void> {
  for (const kind of Object.keys(NORMALIZED_FILE_BY_KIND) as KnowledgeKind[]) {
    const file = NORMALIZED_FILE_BY_KIND[kind];
    const existingFile = existingFilesByName.get(file);
    const kindRecords = records.filter((record) => record.kind === kind);

    await store.writeText(`normalized/${file}`, serializeRows(kindRecords), {
      message: `Write teamctx normalized ${file}`,
      expectedRevision: existingFile?.revision ?? null
    });
  }
}

async function writeRecordIndexesToContextStore(
  store: ContextStoreAdapter,
  indexes: { pathIndex: PathIndex; symbolIndex: SymbolIndex; textIndex: TextIndex },
  normalizedAt: string
): Promise<void> {
  const pathIndexFile = await store.readText("indexes/path-index.json");
  await store.writeText("indexes/path-index.json", serializePathIndex(indexes.pathIndex), {
    message: `Write teamctx path index ${normalizedAt}`,
    expectedRevision: pathIndexFile?.revision ?? null
  });

  const symbolIndexFile = await store.readText("indexes/symbol-index.json");
  await store.writeText("indexes/symbol-index.json", serializeSymbolIndex(indexes.symbolIndex), {
    message: `Write teamctx symbol index ${normalizedAt}`,
    expectedRevision: symbolIndexFile?.revision ?? null
  });

  const textIndexFile = await store.readText("indexes/text-index.json");
  await store.writeText("indexes/text-index.json", serializeTextIndex(indexes.textIndex), {
    message: `Write teamctx text index ${normalizedAt}`,
    expectedRevision: textIndexFile?.revision ?? null
  });
}

async function writeEpisodeIndexToContextStore(
  store: ContextStoreAdapter,
  index: EpisodeIndex,
  normalizedAt: string
): Promise<void> {
  const episodeIndexFile = await store.readText("indexes/episode-index.json");
  await store.writeText("indexes/episode-index.json", serializeEpisodeIndex(index), {
    message: `Write teamctx episode index ${normalizedAt}`,
    expectedRevision: episodeIndexFile?.revision ?? null
  });
}

function safeEpisodeObservations(rawEvents: RawEventFile[], repo: string): RawObservation[] {
  return rawEvents.flatMap((rawEvent) => {
    if (!rawEvent.observation) {
      return [];
    }

    if (scanRawObservation(rawEvent.observation).status === "blocked") {
      return [];
    }

    if (
      !rawEvent.observation.evidence.every((evidence) => !evidence.repo || evidence.repo === repo)
    ) {
      return [];
    }

    return [rawEvent.observation];
  });
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

function jsonlLines(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function serializeRows(rows: unknown[]): string {
  return rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length > 0 ? "\n" : "");
}

function createAuditEntry(options: {
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

  if (options.runId !== undefined) {
    entry.run_id = options.runId;
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

function findDuplicateRecordKey(
  recordsByKey: Map<string, NormalizedRecord>,
  record: NormalizedRecord
): string | undefined {
  const exactKey = dedupeKey(record);

  if (recordsByKey.has(exactKey)) {
    return exactKey;
  }

  for (const [key, existing] of recordsByKey) {
    if (areDuplicateRecords(existing, record)) {
      return key;
    }
  }

  return undefined;
}

function areDuplicateRecords(left: NormalizedRecord, right: NormalizedRecord): boolean {
  if (left.kind !== right.kind || scopeKey(left.scope) !== scopeKey(right.scope)) {
    return false;
  }

  const leftText = canonicalText(left.text);
  const rightText = canonicalText(right.text);

  if (leftText === rightText) {
    return true;
  }

  if (
    hasNegation(leftText) !== hasNegation(rightText) ||
    hasOrderingConflict(leftText, rightText)
  ) {
    return false;
  }

  return tokenSimilarity(significantTokens(leftText), significantTokens(rightText)) >= 0.9;
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

type OrderingAssertion = {
  before: string[];
  after: string[];
};

function hasOrderingConflict(leftText: string, rightText: string): boolean {
  const leftAssertions = extractOrderingAssertions(leftText);
  const rightAssertions = extractOrderingAssertions(rightText);

  return leftAssertions.some((left) =>
    rightAssertions.some(
      (right) =>
        sideSimilarity(left.before, right.after) >= 0.8 &&
        sideSimilarity(left.after, right.before) >= 0.8
    )
  );
}

function extractOrderingAssertions(value: string): OrderingAssertion[] {
  const tokens = value.split(" ").filter((token) => token.length > 0);
  const assertions: OrderingAssertion[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token === "before") {
      addOrderingAssertion(assertions, tokens.slice(0, index), tokens.slice(index + 1));
    } else if (token === "after") {
      addOrderingAssertion(assertions, tokens.slice(index + 1), tokens.slice(0, index));
    }
  }

  return assertions;
}

function addOrderingAssertion(
  assertions: OrderingAssertion[],
  beforeTokens: string[],
  afterTokens: string[]
): void {
  const before = orderingSideTokens(beforeTokens);
  const after = orderingSideTokens(afterTokens);

  if (before.length > 0 && after.length > 0) {
    assertions.push({ before, after });
  }
}

function orderingSideTokens(tokens: string[]): string[] {
  return tokens
    .filter((token) => !ORDERING_FILLER_TOKENS.has(token))
    .filter((token) => !NEGATION_TOKENS.has(token));
}

function significantTokens(value: string): string[] {
  return value
    .split(" ")
    .filter((token) => token.length > 0)
    .filter((token) => !DEDUPE_FILLER_TOKENS.has(token));
}

function sideSimilarity(left: string[], right: string[]): number {
  return tokenSimilarity(left, right);
}

function tokenSimilarity(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }

  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const intersection = [...leftSet].filter((token) => rightSet.has(token)).length;
  const union = new Set([...leftSet, ...rightSet]).size;

  return union === 0 ? 0 : intersection / union;
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
const ORDERING_FILLER_TOKENS = new Set([
  "must",
  "should",
  "shall",
  "need",
  "needs",
  "to",
  "run",
  "runs",
  "execute",
  "executes",
  "happen",
  "happens",
  "be",
  "is",
  "are",
  "the",
  "a",
  "an"
]);
const DEDUPE_FILLER_TOKENS = new Set([...ORDERING_FILLER_TOKENS, "can", "could", "may", "might"]);

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
