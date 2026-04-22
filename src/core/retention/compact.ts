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
import { validateAuditLogEntry } from "../../schemas/audit.js";
import {
  validateNormalizedRecord,
  type NormalizedRecord
} from "../../schemas/normalized-record.js";
import { parseProjectConfig, type ProjectConfig } from "../../schemas/project.js";
import type { Binding } from "../../schemas/types.js";
import { findBinding } from "../binding/local-bindings.js";
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

export type CompactServices = {
  getRepoRoot: (cwd?: string) => string;
  getOriginRemote: (cwd?: string) => string;
  findBinding: (repo: string) => Binding | undefined;
};

export type CompactOptions = {
  cwd?: string;
  now?: () => Date;
  services?: CompactServices;
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
    ...(options.now !== undefined ? { now: options.now } : {})
  });
}

export function compactStore(options: { storeRoot: string; now?: () => Date }): CompactStoreResult {
  const now = options.now ?? (() => new Date());
  const compactedAt = now().toISOString();
  const projectConfig = readProjectConfig(options.storeRoot);
  const archiveRoot = resolveArchiveRoot(options.storeRoot, projectConfig);
  const rawResult = compactRawCandidateEvents({
    storeRoot: options.storeRoot,
    archiveRoot,
    cutoff: daysBefore(compactedAt, projectConfig.retention.raw_candidate_days)
  });
  const auditResult = compactAuditLogs({
    storeRoot: options.storeRoot,
    archiveRoot,
    compactedAt,
    cutoff: daysBefore(compactedAt, projectConfig.retention.audit_days)
  });
  const normalizedResult = compactArchivedRecords({
    storeRoot: options.storeRoot,
    archiveRoot,
    cutoff: daysBefore(compactedAt, projectConfig.retention.audit_days)
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
      moveFile(path, join(options.archiveRoot, "raw", "events", relative(rawRoot, path)));
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
}): { archived: number; retained: number } {
  let archived = 0;
  let retained = 0;

  for (const file of AUDIT_LOG_FILES) {
    const path = join(options.storeRoot, "audit", file);
    const entries = readJsonl(path, validateAuditLogEntry);
    const oldEntries = entries.filter((entry) => isBefore(entry.at, options.cutoff));
    const retainedEntries = entries.filter((entry) => !isBefore(entry.at, options.cutoff));

    if (oldEntries.length > 0) {
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

function compactArchivedRecords(options: {
  storeRoot: string;
  archiveRoot: string;
  cutoff: Date;
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

    if (oldArchivedRecords.length > 0) {
      appendJsonl(join(options.archiveRoot, "normalized", file), oldArchivedRecords);
      writeJsonl(path, retainedRecords);
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

function archivedFileName(file: string, compactedAt: string): string {
  const extensionIndex = file.lastIndexOf(".");
  const name = extensionIndex === -1 ? file : file.slice(0, extensionIndex);
  const extension = extensionIndex === -1 ? "" : file.slice(extensionIndex);

  return `${name}-${stamp(compactedAt)}${extension}`;
}

function stamp(value: string): string {
  return basename(value.replaceAll(":", "").replaceAll("-", ""));
}
