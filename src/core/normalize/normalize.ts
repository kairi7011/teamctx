import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  serializeJsonl,
  type ContextStoreAdapter,
  type ContextStoreFile
} from "../../adapters/store/context-store.js";
import { getOriginRemote, getRepoRoot } from "../../adapters/git/local-git.js";
import { normalizeGitHubRepo } from "../../adapters/git/repo-url.js";
import { validateAuditLogEntry, type AuditLogEntry } from "../../schemas/audit.js";
import {
  validateNormalizedRecord,
  type KnowledgeKind,
  type NormalizedRecord
} from "../../schemas/normalized-record.js";
import { validateRawObservation, type RawObservation } from "../../schemas/observation.js";
import type { Binding } from "../../schemas/types.js";
import { findBinding } from "../binding/local-bindings.js";
import { bindingMissingError, unsupportedRemoteOperationError } from "../errors.js";
import {
  buildRecordIndexes,
  serializePathIndex,
  serializeSymbolIndex,
  serializeTextIndex,
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
import { sha256Hex } from "../store/hash.js";
import { jsonlLines } from "../store/jsonl.js";
import { resolveStoreRoot } from "../store/layout.js";
import { acquireNormalizeLease } from "../store/lease.js";
import { calculateConfidence } from "./confidence.js";
import { dedupeKey, emptyScope, findDuplicateRecordKey } from "./dedupe.js";
import { applyStateTransitions, createAuditEntry } from "./state-transition.js";

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
  dryRun?: boolean;
  useLease?: boolean;
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
    throw bindingMissingError();
  }

  if (binding.contextStore.repo !== repo) {
    throw unsupportedRemoteOperationError("normalize");
  }

  return normalizeStore({
    repo,
    allowedEvidenceRepos: [repo, binding.contextStore.repo],
    storeRoot: resolveStoreRoot(root, binding.contextStore.path),
    repoRoot: root,
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {})
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
    throw bindingMissingError();
  }

  if (binding.contextStore.repo === repo) {
    return normalizeStore({
      repo,
      allowedEvidenceRepos: [repo, binding.contextStore.repo],
      storeRoot: resolveStoreRoot(root, binding.contextStore.path),
      repoRoot: root,
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {})
    });
  }

  return normalizeContextStore({
    repo,
    allowedEvidenceRepos: [repo, binding.contextStore.repo],
    repoRoot: root,
    store:
      services.createContextStore?.({ repo, repoRoot: root, binding }) ??
      createContextStoreForBinding({ repo, repoRoot: root, binding }),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {}),
    ...(options.useLease !== undefined ? { useLease: options.useLease } : {})
  });
}

export function normalizeStore(options: {
  repo: string;
  allowedEvidenceRepos?: string[];
  storeRoot: string;
  repoRoot?: string;
  now?: () => Date;
  dryRun?: boolean;
}): NormalizeStoreResult {
  const now = options.now ?? (() => new Date());
  const runAt = now();
  const runNow = () => runAt;
  const rawEvents = readRawEvents(options.storeRoot);
  const existingRecords = readNormalizedRecords(options.storeRoot);
  const run = normalizeRun({
    repo: options.repo,
    allowedEvidenceRepos: options.allowedEvidenceRepos ?? [options.repo],
    ...(options.repoRoot !== undefined ? { repoRoot: options.repoRoot } : {}),
    now: runNow,
    rawEvents,
    existingRecords
  });

  if (options.dryRun === true) {
    return run.result;
  }

  const indexes = buildRecordIndexes(run.records, run.result.normalizedAt);
  const episodeIndex = buildEpisodeIndex(run.episodeObservations, run.result.normalizedAt);

  writeNormalizedRecords(options.storeRoot, run.records);
  writeRecordIndexes(options.storeRoot, indexes);
  writeEpisodeIndex(options.storeRoot, episodeIndex);
  appendAuditEntries(options.storeRoot, run.auditEntries);
  writeLastNormalizeResult(options.storeRoot, run.result);

  return run.result;
}

export async function normalizeContextStore(options: {
  repo: string;
  allowedEvidenceRepos?: string[];
  store: ContextStoreAdapter;
  repoRoot?: string;
  now?: () => Date;
  dryRun?: boolean;
  useLease?: boolean;
}): Promise<NormalizeStoreResult> {
  const now = options.now ?? (() => new Date());
  const lease =
    options.useLease === true && options.dryRun !== true
      ? await acquireNormalizeLease({ store: options.store, now })
      : undefined;

  try {
    return await normalizeContextStoreWithLease({
      repo: options.repo,
      allowedEvidenceRepos: options.allowedEvidenceRepos ?? [options.repo],
      store: options.store,
      ...(options.repoRoot !== undefined ? { repoRoot: options.repoRoot } : {}),
      now,
      ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {})
    });
  } finally {
    await lease?.release();
  }
}

async function normalizeContextStoreWithLease(options: {
  repo: string;
  allowedEvidenceRepos: string[];
  store: ContextStoreAdapter;
  repoRoot?: string;
  now: () => Date;
  dryRun?: boolean;
}): Promise<NormalizeStoreResult> {
  const runAt = options.now();
  const runNow = () => runAt;
  const rawEvents = await readRawEventsFromContextStore(options.store);
  const existing = await readNormalizedRecordFilesFromContextStore(options.store);
  const run = normalizeRun({
    repo: options.repo,
    allowedEvidenceRepos: options.allowedEvidenceRepos,
    ...(options.repoRoot !== undefined ? { repoRoot: options.repoRoot } : {}),
    now: runNow,
    rawEvents,
    existingRecords: existing.records
  });

  if (options.dryRun === true) {
    return run.result;
  }

  const indexes = buildRecordIndexes(run.records, run.result.normalizedAt);
  const episodeIndex = buildEpisodeIndex(run.episodeObservations, run.result.normalizedAt);

  if (await remoteDerivedStateUnchanged(options.store, run)) {
    return run.result;
  }

  await writeNormalizedRecordsToContextStore(options.store, run.records, existing.filesByName);
  await writeRecordIndexesToContextStore(options.store, indexes, run.result.normalizedAt);
  await writeEpisodeIndexToContextStore(options.store, episodeIndex, run.result.normalizedAt);

  if (run.auditEntries.length > 0) {
    await options.store.appendJsonl("audit/changes.jsonl", run.auditEntries, {
      message: `Append teamctx normalize audit ${run.result.normalizedAt}`
    });
  }

  const lastNormalize = await options.store.readText("indexes/last-normalize.json");
  await writeIfChanged(
    options.store,
    "indexes/last-normalize.json",
    `${JSON.stringify(run.result, null, 2)}\n`,
    lastNormalize,
    { message: `Record teamctx normalize result ${run.result.normalizedAt}` }
  );

  return run.result;
}

function normalizeRun(options: {
  repo: string;
  allowedEvidenceRepos: string[];
  repoRoot?: string;
  now: () => Date;
  rawEvents: RawEventFile[];
  existingRecords: NormalizedRecord[];
}): {
  result: NormalizeStoreResult;
  records: NormalizedRecord[];
  auditEntries: AuditLogEntry[];
  episodeObservations: RawObservation[];
} {
  const runAt = options.now();
  const runNow = () => runAt;
  const rawEvents = options.rawEvents;
  const runId = makeRunId(options.repo, runAt, rawEvents);
  const existingRecords = options.existingRecords;
  const existingRecordsById = new Map(existingRecords.map((record) => [record.id, record]));
  const recordsByKey = new Map<string, NormalizedRecord>();
  const recordKeysByEventId = new Map<string, string>();
  const auditEntries: AuditLogEntry[] = [];
  let droppedEvents = 0;

  for (const rawEvent of rawEvents) {
    const normalized = normalizeRawEvent(rawEvent, options.allowedEvidenceRepos, runNow);

    if (normalized.record) {
      const existingRecord = existingRecordsById.get(normalized.record.id);
      const record = existingRecord
        ? preserveExistingState(normalized.record, existingRecord)
        : normalized.record;
      const key = findDuplicateRecordKey(recordsByKey, record) ?? dedupeKey(record);
      const sourceEventIds = rawEvent.observation ? [rawEvent.observation.event_id] : [];

      if (rawEvent.observation) {
        recordKeysByEventId.set(rawEvent.observation.event_id, key);
      }

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
    repo: options.repo,
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
  const episodeObservations = safeActiveEpisodeObservations(
    rawEvents,
    options.allowedEvidenceRepos,
    records,
    recordKeysByEventId
  );

  return { result, records, auditEntries, episodeObservations };
}

function makeRunId(repo: string, runAt: Date, rawEvents: RawEventFile[]): string {
  const eventIds = rawEvents
    .map((event) => event.observation?.event_id ?? "")
    .filter((id) => id.length > 0)
    .sort();
  const idSource = [repo, runAt.toISOString(), eventIds.join(",")].join("|");

  return `run-${sha256Hex(idSource).slice(0, 16)}`;
}

function preserveExistingState(
  record: NormalizedRecord,
  existingRecord: NormalizedRecord
): NormalizedRecord {
  if (existingRecord.state === "active") {
    if (sameActiveRecordPayload(record, existingRecord)) {
      return existingRecord;
    }

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

function sameActiveRecordPayload(
  record: NormalizedRecord,
  existingRecord: NormalizedRecord
): boolean {
  return (
    JSON.stringify(recordWithoutLastVerifiedAt(record)) ===
    JSON.stringify(recordWithoutLastVerifiedAt(existingRecord))
  );
}

function recordWithoutLastVerifiedAt(
  record: NormalizedRecord
): Omit<NormalizedRecord, "last_verified_at"> {
  const { last_verified_at: _lastVerifiedAt, ...stableRecord } = record;

  return stableRecord;
}

function normalizeRawEvent(
  rawEvent: RawEventFile,
  allowedEvidenceRepos: string[],
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
    ...(rawEvent.observation.verification !== undefined
      ? { verification: rawEvent.observation.verification }
      : {}),
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

  if (
    !record.evidence.every((evidence) => evidenceRepoIsAllowed(evidence.repo, allowedEvidenceRepos))
  ) {
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
    const nextContent = serializeJsonl(kindRecords);

    await writeIfChanged(store, `normalized/${file}`, nextContent, existingFile, {
      message: `Write teamctx normalized ${file}`
    });
  }
}

async function remoteDerivedStateUnchanged(
  store: ContextStoreAdapter,
  run: {
    records: NormalizedRecord[];
    auditEntries: AuditLogEntry[];
    episodeObservations: RawObservation[];
  }
): Promise<boolean> {
  if (run.auditEntries.length > 0) {
    return false;
  }

  for (const kind of Object.keys(NORMALIZED_FILE_BY_KIND) as KnowledgeKind[]) {
    const file = NORMALIZED_FILE_BY_KIND[kind];
    const existingContent = (await store.readText(`normalized/${file}`))?.content ?? "";
    const nextContent = serializeJsonl(run.records.filter((record) => record.kind === kind));

    if (existingContent !== nextContent) {
      return false;
    }
  }

  const pathIndexFile = await store.readText("indexes/path-index.json");
  const symbolIndexFile = await store.readText("indexes/symbol-index.json");
  const textIndexFile = await store.readText("indexes/text-index.json");
  const episodeIndexFile = await store.readText("indexes/episode-index.json");

  if (!pathIndexFile || !symbolIndexFile || !textIndexFile || !episodeIndexFile) {
    return false;
  }

  const pathGeneratedAt = indexGeneratedAt(pathIndexFile.content);
  const symbolGeneratedAt = indexGeneratedAt(symbolIndexFile.content);
  const textGeneratedAt = indexGeneratedAt(textIndexFile.content);
  const episodeGeneratedAt = indexGeneratedAt(episodeIndexFile.content);

  if (
    pathGeneratedAt === undefined ||
    pathGeneratedAt === null ||
    symbolGeneratedAt === undefined ||
    symbolGeneratedAt === null ||
    textGeneratedAt === undefined ||
    textGeneratedAt === null ||
    episodeGeneratedAt === undefined ||
    episodeGeneratedAt === null
  ) {
    return false;
  }

  return (
    pathIndexFile.content ===
      serializePathIndex(buildRecordIndexes(run.records, pathGeneratedAt).pathIndex) &&
    symbolIndexFile.content ===
      serializeSymbolIndex(buildRecordIndexes(run.records, symbolGeneratedAt).symbolIndex) &&
    textIndexFile.content ===
      serializeTextIndex(buildRecordIndexes(run.records, textGeneratedAt).textIndex) &&
    episodeIndexFile.content ===
      serializeEpisodeIndex(buildEpisodeIndex(run.episodeObservations, episodeGeneratedAt))
  );
}

function indexGeneratedAt(content: string): string | null | undefined {
  try {
    const parsed = JSON.parse(content) as { generated_at?: unknown };

    return typeof parsed.generated_at === "string" || parsed.generated_at === null
      ? parsed.generated_at
      : undefined;
  } catch {
    return undefined;
  }
}

async function writeRecordIndexesToContextStore(
  store: ContextStoreAdapter,
  indexes: { pathIndex: PathIndex; symbolIndex: SymbolIndex; textIndex: TextIndex },
  normalizedAt: string
): Promise<void> {
  const pathIndexFile = await store.readText("indexes/path-index.json");
  await writeIfChanged(
    store,
    "indexes/path-index.json",
    serializePathIndex(indexes.pathIndex),
    pathIndexFile,
    { message: `Write teamctx path index ${normalizedAt}` }
  );

  const symbolIndexFile = await store.readText("indexes/symbol-index.json");
  await writeIfChanged(
    store,
    "indexes/symbol-index.json",
    serializeSymbolIndex(indexes.symbolIndex),
    symbolIndexFile,
    { message: `Write teamctx symbol index ${normalizedAt}` }
  );

  const textIndexFile = await store.readText("indexes/text-index.json");
  await writeIfChanged(
    store,
    "indexes/text-index.json",
    serializeTextIndex(indexes.textIndex),
    textIndexFile,
    { message: `Write teamctx text index ${normalizedAt}` }
  );
}

async function writeEpisodeIndexToContextStore(
  store: ContextStoreAdapter,
  index: EpisodeIndex,
  normalizedAt: string
): Promise<void> {
  const episodeIndexFile = await store.readText("indexes/episode-index.json");
  await writeIfChanged(
    store,
    "indexes/episode-index.json",
    serializeEpisodeIndex(index),
    episodeIndexFile,
    { message: `Write teamctx episode index ${normalizedAt}` }
  );
}

async function writeIfChanged(
  store: ContextStoreAdapter,
  path: string,
  nextContent: string,
  existingFile: ContextStoreFile | undefined,
  options: { message: string }
): Promise<void> {
  let currentFile = existingFile;

  if (currentFile && currentFile.content === nextContent) {
    return;
  }

  try {
    await store.writeText(path, nextContent, {
      message: options.message,
      expectedRevision: currentFile?.revision ?? null
    });
  } catch (error) {
    if (!isOptimisticWriteConflict(error)) {
      throw error;
    }

    currentFile = await store.readText(path);

    if (currentFile?.content === nextContent) {
      return;
    }

    throw new Error(
      `Context store changed while writing ${path}; rerun normalize to avoid overwriting newer context.`
    );
  }
}

function isOptimisticWriteConflict(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { status?: unknown }).status;

    if (status === 409 || status === 422) {
      return true;
    }
  }

  return error instanceof Error && error.message.toLowerCase().includes("conflict");
}

function evidenceRepoIsAllowed(repo: string | undefined, allowedEvidenceRepos: string[]): boolean {
  return repo === undefined || allowedEvidenceRepos.includes(repo);
}

function safeEpisodeObservations(
  rawEvents: RawEventFile[],
  allowedEvidenceRepos: string[]
): RawObservation[] {
  return rawEvents.flatMap((rawEvent) => {
    if (!rawEvent.observation) {
      return [];
    }

    if (scanRawObservation(rawEvent.observation).status === "blocked") {
      return [];
    }

    if (
      !rawEvent.observation.evidence.every((evidence) =>
        evidenceRepoIsAllowed(evidence.repo, allowedEvidenceRepos)
      )
    ) {
      return [];
    }

    return [rawEvent.observation];
  });
}

function safeActiveEpisodeObservations(
  rawEvents: RawEventFile[],
  allowedEvidenceRepos: string[],
  records: NormalizedRecord[],
  recordKeysByEventId: Map<string, string>
): RawObservation[] {
  const activeRecordKeys = new Set(
    records.filter((record) => record.state === "active").map((record) => dedupeKey(record))
  );

  return safeEpisodeObservations(rawEvents, allowedEvidenceRepos).filter((observation) => {
    const recordKey = recordKeysByEventId.get(observation.event_id);

    return recordKey !== undefined && activeRecordKeys.has(recordKey);
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

function recordId(observation: RawObservation): string {
  return `${observation.kind}-${sha256Hex(
    JSON.stringify({
      kind: observation.kind,
      text: observation.text,
      scope: observation.scope ?? emptyScope()
    })
  ).slice(0, 16)}`;
}
