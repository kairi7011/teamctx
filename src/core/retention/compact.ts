import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { getOriginRemote, getRepoRoot } from "../../adapters/git/local-git.js";
import { normalizeGitHubRepo } from "../../adapters/git/repo-url.js";
import { serializeJsonl, type ContextStoreAdapter } from "../../adapters/store/context-store.js";
import { normalizeStorePath } from "../../adapters/store/store-path.js";
import { jsonlLines } from "../store/jsonl.js";
import { validateAuditLogEntry } from "../../schemas/audit.js";
import {
  validateNormalizedRecord,
  type NormalizedRecord
} from "../../schemas/normalized-record.js";
import { parseProjectConfig, type ProjectConfig } from "../../schemas/project.js";
import type { Binding } from "../../schemas/types.js";
import { findBinding } from "../binding/local-bindings.js";
import {
  createContextStoreForBinding,
  type ContextStoreFactoryServices
} from "../store/bound-store.js";
import { AUDIT_LOG_FILES, NORMALIZED_RECORD_FILES, resolveStoreRoot } from "../store/layout.js";
import { validateRawObservation, type RawObservation } from "../../schemas/observation.js";

export type CompactStoreResult = {
  compactedAt: string;
  storeRoot: string;
  archiveRoot: string;
  rawCandidateEventsArchived: number;
  rawEventsRetained: number;
  auditEntriesArchived: number;
  auditEntriesRetained: number;
  archivedRecordsArchived: number;
  normalizedRecordsRetained: number;
};

export type CompactServices = ContextStoreFactoryServices & {
  getRepoRoot: (cwd?: string) => string;
  getOriginRemote: (cwd?: string) => string;
  findBinding: (repo: string) => Binding | undefined;
};

export type CompactOptions = {
  cwd?: string;
  now?: () => Date;
  services?: CompactServices;
  dryRun?: boolean;
};

const defaultServices: CompactServices = {
  getRepoRoot,
  getOriginRemote,
  findBinding
};

export function compactBoundStore(options: CompactOptions = {}): CompactStoreResult {
  const services = options.services ?? defaultServices;
  const root = services.getRepoRoot(options.cwd);
  const repo = normalizeGitHubRepo(services.getOriginRemote(root));
  const binding = services.findBinding(repo);

  if (!binding) {
    throw new Error("No teamctx binding found. Run: teamctx bind <store> --path <path>");
  }

  if (binding.contextStore.repo !== repo) {
    throw new Error("compact currently supports context stores inside the current repository.");
  }

  return compactStore({
    storeRoot: resolveStoreRoot(root, binding.contextStore.path),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {})
  });
}

export async function compactBoundStoreAsync(
  options: CompactOptions = {}
): Promise<CompactStoreResult> {
  const services = options.services ?? defaultServices;
  const root = services.getRepoRoot(options.cwd);
  const repo = normalizeGitHubRepo(services.getOriginRemote(root));
  const binding = services.findBinding(repo);

  if (!binding) {
    throw new Error("No teamctx binding found. Run: teamctx bind <store> --path <path>");
  }

  if (binding.contextStore.repo === repo) {
    return compactStore({
      storeRoot: resolveStoreRoot(root, binding.contextStore.path),
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {})
    });
  }

  return compactContextStore({
    store:
      services.createContextStore?.({ repo, repoRoot: root, binding }) ??
      createContextStoreForBinding({ repo, repoRoot: root, binding }),
    storeRoot: `${binding.contextStore.repo}/${binding.contextStore.path}`,
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {})
  });
}

export function compactStore(options: {
  storeRoot: string;
  now?: () => Date;
  dryRun?: boolean;
}): CompactStoreResult {
  const now = options.now ?? (() => new Date());
  const compactedAt = now().toISOString();
  const projectConfig = readProjectConfig(options.storeRoot);
  const archiveRoot = resolveArchiveRoot(options.storeRoot, projectConfig);
  const dryRun = options.dryRun === true;
  const rawResult = compactRawCandidateEvents({
    storeRoot: options.storeRoot,
    archiveRoot,
    cutoff: daysBefore(compactedAt, projectConfig.retention.raw_candidate_days),
    dryRun
  });
  const auditResult = compactAuditLogs({
    storeRoot: options.storeRoot,
    archiveRoot,
    compactedAt,
    cutoff: daysBefore(compactedAt, projectConfig.retention.audit_days),
    dryRun
  });
  const normalizedResult = compactArchivedRecords({
    storeRoot: options.storeRoot,
    archiveRoot,
    cutoff: daysBefore(compactedAt, projectConfig.retention.audit_days),
    dryRun
  });

  return {
    compactedAt,
    storeRoot: options.storeRoot,
    archiveRoot,
    rawCandidateEventsArchived: rawResult.archived,
    rawEventsRetained: rawResult.retained,
    auditEntriesArchived: auditResult.archived,
    auditEntriesRetained: auditResult.retained,
    archivedRecordsArchived: normalizedResult.archived,
    normalizedRecordsRetained: normalizedResult.retained
  };
}

export async function compactContextStore(options: {
  store: ContextStoreAdapter;
  storeRoot: string;
  now?: () => Date;
  dryRun?: boolean;
}): Promise<CompactStoreResult> {
  const now = options.now ?? (() => new Date());
  const compactedAt = now().toISOString();
  const projectConfig = await readProjectConfigFromContextStore(options.store);
  const archiveRoot = normalizeStorePath(projectConfig.retention.archive_path, {
    errorMessage: "Retention archive_path must stay inside the context store."
  });
  const dryRun = options.dryRun === true;
  const rawResult = await compactRawCandidateEventsInContextStore({
    store: options.store,
    archiveRoot,
    cutoff: daysBefore(compactedAt, projectConfig.retention.raw_candidate_days),
    dryRun
  });
  const auditResult = await compactAuditLogsInContextStore({
    store: options.store,
    archiveRoot,
    compactedAt,
    cutoff: daysBefore(compactedAt, projectConfig.retention.audit_days),
    dryRun
  });
  const normalizedResult = await compactArchivedRecordsInContextStore({
    store: options.store,
    archiveRoot,
    cutoff: daysBefore(compactedAt, projectConfig.retention.audit_days),
    dryRun
  });

  return {
    compactedAt,
    storeRoot: options.storeRoot,
    archiveRoot,
    rawCandidateEventsArchived: rawResult.archived,
    rawEventsRetained: rawResult.retained,
    auditEntriesArchived: auditResult.archived,
    auditEntriesRetained: auditResult.retained,
    archivedRecordsArchived: normalizedResult.archived,
    normalizedRecordsRetained: normalizedResult.retained
  };
}

function readProjectConfig(storeRoot: string): ProjectConfig {
  const path = join(storeRoot, "project.yaml");

  if (!existsSync(path)) {
    throw new Error("Context store project.yaml is missing. Run: teamctx init-store");
  }

  return parseProjectConfig(readFileSync(path, "utf8"));
}

async function readProjectConfigFromContextStore(
  store: ContextStoreAdapter
): Promise<ProjectConfig> {
  const file = await store.readText("project.yaml");

  if (!file) {
    throw new Error("Context store project.yaml is missing. Run: teamctx init-store");
  }

  return parseProjectConfig(file.content);
}

function resolveArchiveRoot(storeRoot: string, projectConfig: ProjectConfig): string {
  const root = resolve(storeRoot);
  const archiveRoot = resolve(root, projectConfig.retention.archive_path);
  const relativeArchiveRoot = relative(root, archiveRoot);

  if (
    relativeArchiveRoot === "" ||
    relativeArchiveRoot.startsWith("..") ||
    isAbsolute(relativeArchiveRoot)
  ) {
    throw new Error("Retention archive_path must stay inside the context store.");
  }

  return archiveRoot;
}

function compactRawCandidateEvents(options: {
  storeRoot: string;
  archiveRoot: string;
  cutoff: Date;
  dryRun?: boolean;
}): { archived: number; retained: number } {
  const rawRoot = join(options.storeRoot, "raw", "events");
  let archived = 0;
  let retained = 0;

  for (const path of listFiles(rawRoot, ".json")) {
    const rawEvent = readRawObservation(path);

    if (
      rawEvent &&
      rawEvent.trust === "candidate" &&
      isBefore(rawEvent.observed_at, options.cutoff)
    ) {
      if (options.dryRun !== true) {
        moveFile(path, join(options.archiveRoot, "raw", "events", relative(rawRoot, path)));
      }
      archived += 1;
    } else {
      retained += 1;
    }
  }

  return { archived, retained };
}

async function compactRawCandidateEventsInContextStore(options: {
  store: ContextStoreAdapter;
  archiveRoot: string;
  cutoff: Date;
  dryRun?: boolean;
}): Promise<{ archived: number; retained: number }> {
  let archived = 0;
  let retained = 0;

  for (const path of await options.store.listFiles("raw/events")) {
    if (!path.endsWith(".json")) {
      continue;
    }

    const file = await options.store.readText(path);
    const rawEvent = file ? parseRawObservation(file.content) : undefined;

    if (
      file &&
      rawEvent &&
      rawEvent.trust === "candidate" &&
      isBefore(rawEvent.observed_at, options.cutoff)
    ) {
      if (options.dryRun !== true) {
        await options.store.writeText(
          joinStorePath(options.archiveRoot, "raw/events", path.slice("raw/events/".length)),
          file.content,
          {
            message: `Archive teamctx raw event ${path}`,
            expectedRevision: null
          }
        );
        await options.store.deleteText(path, {
          message: `Delete compacted teamctx raw event ${path}`,
          expectedRevision: file.revision
        });
      }
      archived += 1;
    } else {
      retained += 1;
    }
  }

  return { archived, retained };
}

function compactAuditLogs(options: {
  storeRoot: string;
  archiveRoot: string;
  compactedAt: string;
  cutoff: Date;
  dryRun?: boolean;
}): { archived: number; retained: number } {
  let archived = 0;
  let retained = 0;

  for (const file of AUDIT_LOG_FILES) {
    const path = join(options.storeRoot, "audit", file);
    const entries = readJsonl(path, validateAuditLogEntry);
    const oldEntries = entries.filter((entry) => isBefore(entry.at, options.cutoff));
    const retainedEntries = entries.filter((entry) => !isBefore(entry.at, options.cutoff));

    if (oldEntries.length > 0 && options.dryRun !== true) {
      appendJsonl(
        join(options.archiveRoot, "audit", archivedFileName(file, options.compactedAt)),
        oldEntries
      );
      writeJsonl(path, retainedEntries);
    }

    archived += oldEntries.length;
    retained += retainedEntries.length;
  }

  return { archived, retained };
}

async function compactAuditLogsInContextStore(options: {
  store: ContextStoreAdapter;
  archiveRoot: string;
  compactedAt: string;
  cutoff: Date;
  dryRun?: boolean;
}): Promise<{ archived: number; retained: number }> {
  let archived = 0;
  let retained = 0;

  for (const file of AUDIT_LOG_FILES) {
    const path = `audit/${file}`;
    const storeFile = await options.store.readText(path);
    const entries = jsonlLines(storeFile?.content ?? "").map((line) =>
      validateAuditLogEntry(JSON.parse(line) as unknown)
    );
    const oldEntries = entries.filter((entry) => isBefore(entry.at, options.cutoff));
    const retainedEntries = entries.filter((entry) => !isBefore(entry.at, options.cutoff));

    if (oldEntries.length > 0 && options.dryRun !== true) {
      await options.store.appendJsonl(
        joinStorePath(options.archiveRoot, "audit", archivedFileName(file, options.compactedAt)),
        oldEntries,
        { message: `Archive teamctx audit ${file}` }
      );
      await options.store.writeText(path, serializeJsonl(retainedEntries), {
        message: `Retain compacted teamctx audit ${file}`,
        expectedRevision: storeFile?.revision ?? null
      });
    }

    archived += oldEntries.length;
    retained += retainedEntries.length;
  }

  return { archived, retained };
}

function compactArchivedRecords(options: {
  storeRoot: string;
  archiveRoot: string;
  cutoff: Date;
  dryRun?: boolean;
}): { archived: number; retained: number } {
  let archived = 0;
  let retained = 0;

  for (const file of NORMALIZED_RECORD_FILES) {
    const path = join(options.storeRoot, "normalized", file);
    const records = readJsonl(path, validateNormalizedRecord);
    const oldArchivedRecords = records.filter(
      (record) => record.state === "archived" && isBefore(recordTimestamp(record), options.cutoff)
    );
    const retainedRecords = records.filter(
      (record) => record.state !== "archived" || !isBefore(recordTimestamp(record), options.cutoff)
    );

    if (oldArchivedRecords.length > 0 && options.dryRun !== true) {
      appendJsonl(join(options.archiveRoot, "normalized", file), oldArchivedRecords);
      writeJsonl(path, retainedRecords);
    }

    archived += oldArchivedRecords.length;
    retained += retainedRecords.length;
  }

  return { archived, retained };
}

async function compactArchivedRecordsInContextStore(options: {
  store: ContextStoreAdapter;
  archiveRoot: string;
  cutoff: Date;
  dryRun?: boolean;
}): Promise<{ archived: number; retained: number }> {
  let archived = 0;
  let retained = 0;

  for (const file of NORMALIZED_RECORD_FILES) {
    const path = `normalized/${file}`;
    const storeFile = await options.store.readText(path);
    const records = jsonlLines(storeFile?.content ?? "").map((line) =>
      validateNormalizedRecord(JSON.parse(line) as unknown)
    );
    const oldArchivedRecords = records.filter(
      (record) => record.state === "archived" && isBefore(recordTimestamp(record), options.cutoff)
    );
    const retainedRecords = records.filter(
      (record) => record.state !== "archived" || !isBefore(recordTimestamp(record), options.cutoff)
    );

    if (oldArchivedRecords.length > 0 && options.dryRun !== true) {
      await options.store.appendJsonl(
        joinStorePath(options.archiveRoot, "normalized", file),
        oldArchivedRecords,
        { message: `Archive teamctx normalized ${file}` }
      );
      await options.store.writeText(path, serializeJsonl(retainedRecords), {
        message: `Retain compacted teamctx normalized ${file}`,
        expectedRevision: storeFile?.revision ?? null
      });
    }

    archived += oldArchivedRecords.length;
    retained += retainedRecords.length;
  }

  return { archived, retained };
}

function readRawObservation(path: string): RawObservation | undefined {
  try {
    return validateRawObservation(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch {
    return undefined;
  }
}

function parseRawObservation(content: string): RawObservation | undefined {
  try {
    return validateRawObservation(JSON.parse(content) as unknown);
  } catch {
    return undefined;
  }
}

function recordTimestamp(record: NormalizedRecord): string {
  return record.last_verified_at ?? record.provenance.observed_at;
}

function listFiles(root: string, suffix: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
      const path = join(root, entry.name);

      if (entry.isDirectory()) {
        return listFiles(path, suffix);
      }

      return entry.isFile() && entry.name.endsWith(suffix) ? [path] : [];
    });
  } catch {
    return [];
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

function writeJsonl(path: string, rows: unknown[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length > 0 ? "\n" : ""),
    "utf8"
  );
}

function appendJsonl(path: string, rows: unknown[]): void {
  if (rows.length === 0) {
    return;
  }

  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

function moveFile(source: string, destination: string): void {
  mkdirSync(dirname(destination), { recursive: true });
  renameSync(source, destination);
}

function daysBefore(compactedAt: string, days: number): Date {
  const cutoff = new Date(compactedAt);
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  return cutoff;
}

function isBefore(value: string, cutoff: Date): boolean {
  const time = Date.parse(value);

  return Number.isFinite(time) && time < cutoff.getTime();
}

function joinStorePath(...parts: string[]): string {
  return normalizeStorePath(parts.join("/"));
}

function archivedFileName(file: string, compactedAt: string): string {
  const extensionIndex = file.lastIndexOf(".");
  const name = extensionIndex === -1 ? file : file.slice(0, extensionIndex);
  const extension = extensionIndex === -1 ? "" : file.slice(extensionIndex);

  return `${name}-${stamp(compactedAt)}${extension}`;
}

function stamp(value: string): string {
  return basename(value.replaceAll(":", "").replaceAll("-", ""));
}
