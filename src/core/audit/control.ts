import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { getOriginRemote, getRepoRoot } from "../../adapters/git/local-git.js";
import { normalizeGitHubRepo } from "../../adapters/git/repo-url.js";
import { validateAuditLogEntry, type AuditLogEntry, type AuditState } from "../../schemas/audit.js";
import {
  validateNormalizedRecord,
  type NormalizedRecord
} from "../../schemas/normalized-record.js";
import type { Binding } from "../../schemas/types.js";
import { findBinding } from "../binding/local-bindings.js";
import { NORMALIZED_FILE_BY_KIND } from "../normalize/normalize.js";
import { resolveStoreRoot } from "../store/layout.js";

export type ControlServices = {
  getRepoRoot: (cwd?: string) => string;
  getOriginRemote: (cwd?: string) => string;
  findBinding: (repo: string) => Binding | undefined;
};

export type ExplainItemResult =
  | {
      found: true;
      record: NormalizedRecord;
      audit_entries: AuditLogEntry[];
    }
  | {
      found: false;
      item_id: string;
    };

export type InvalidateItemResult = {
  invalidated: true;
  item_id: string;
  before_state: AuditState;
  after_state: "archived";
  audit_entry: AuditLogEntry;
};

export type BoundControlOptions = {
  cwd?: string;
  itemId: string;
  reason?: string;
  now?: () => Date;
  services?: ControlServices;
};

const defaultServices: ControlServices = {
  getRepoRoot,
  getOriginRemote,
  findBinding
};

export function explainBoundItem(options: BoundControlOptions): ExplainItemResult {
  const storeRoot = resolveBoundStoreRoot(options);

  return explainItem({
    storeRoot,
    itemId: options.itemId
  });
}

export function invalidateBoundItem(options: BoundControlOptions): InvalidateItemResult {
  const storeRoot = resolveBoundStoreRoot(options);

  return invalidateItem({
    storeRoot,
    itemId: options.itemId,
    ...(options.reason !== undefined ? { reason: options.reason } : {}),
    ...(options.now !== undefined ? { now: options.now } : {})
  });
}

export function explainItem(options: { storeRoot: string; itemId: string }): ExplainItemResult {
  const match = findRecord(options.storeRoot, options.itemId);

  if (!match) {
    return {
      found: false,
      item_id: options.itemId
    };
  }

  return {
    found: true,
    record: match.record,
    audit_entries: readAuditEntries(options.storeRoot).filter(
      (entry) => entry.item_id === options.itemId
    )
  };
}

export function invalidateItem(options: {
  storeRoot: string;
  itemId: string;
  reason?: string;
  now?: () => Date;
}): InvalidateItemResult {
  const match = findRecord(options.storeRoot, options.itemId);

  if (!match) {
    throw new Error(`No normalized context item found: ${options.itemId}`);
  }

  const now = options.now ?? (() => new Date());
  const beforeState = match.record.state;
  const archivedRecord = validateNormalizedRecord({
    ...match.record,
    state: "archived"
  });
  const records = match.records.map((record) =>
    record.id === options.itemId ? archivedRecord : record
  );
  writeJsonl(match.path, records);

  const auditEntry = createAuditEntry({
    itemId: options.itemId,
    beforeState,
    reason: options.reason ?? "manual invalidation",
    now
  });
  appendAuditEntry(options.storeRoot, auditEntry);

  return {
    invalidated: true,
    item_id: options.itemId,
    before_state: beforeState,
    after_state: "archived",
    audit_entry: auditEntry
  };
}

function resolveBoundStoreRoot(options: BoundControlOptions): string {
  const services = options.services ?? defaultServices;
  const root = services.getRepoRoot(options.cwd);
  const repo = normalizeGitHubRepo(services.getOriginRemote(root));
  const binding = services.findBinding(repo);

  if (!binding) {
    throw new Error("No teamctx binding found. Run: teamctx bind <store> --path <path>");
  }

  if (binding.contextStore.repo !== repo) {
    throw new Error(
      "audit control currently supports context stores inside the current repository."
    );
  }

  return resolveStoreRoot(root, binding.contextStore.path);
}

function findRecord(
  storeRoot: string,
  itemId: string
): { path: string; record: NormalizedRecord; records: NormalizedRecord[] } | undefined {
  for (const path of normalizedPaths(storeRoot)) {
    const records = readNormalizedRecords(path);
    const record = records.find((item) => item.id === itemId);

    if (record) {
      return { path, record, records };
    }
  }

  return undefined;
}

function normalizedPaths(storeRoot: string): string[] {
  return Object.values(NORMALIZED_FILE_BY_KIND).map((file) => join(storeRoot, "normalized", file));
}

function readNormalizedRecords(path: string): NormalizedRecord[] {
  return readJsonl(path).map((line) => validateNormalizedRecord(JSON.parse(line) as unknown));
}

function readAuditEntries(storeRoot: string): AuditLogEntry[] {
  return readJsonl(join(storeRoot, "audit", "changes.jsonl")).map((line) =>
    validateAuditLogEntry(JSON.parse(line) as unknown)
  );
}

function readJsonl(path: string): string[] {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

function writeJsonl(path: string, records: NormalizedRecord[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    records.map((record) => JSON.stringify(validateNormalizedRecord(record))).join("\n") +
      (records.length > 0 ? "\n" : ""),
    "utf8"
  );
}

function appendAuditEntry(storeRoot: string, entry: AuditLogEntry): void {
  const path = join(storeRoot, "audit", "changes.jsonl");
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(validateAuditLogEntry(entry))}\n`, "utf8");
}

function createAuditEntry(options: {
  itemId: string;
  beforeState: AuditState;
  reason: string;
  now: () => Date;
}): AuditLogEntry {
  const at = options.now().toISOString();

  return validateAuditLogEntry({
    schema_version: 1,
    id: `audit-${hash(`${options.itemId}|${options.beforeState}|archived|${options.reason}|${at}`).slice(0, 16)}`,
    at,
    action: "invalidated",
    item_id: options.itemId,
    before_state: options.beforeState,
    after_state: "archived",
    reason: options.reason,
    source_event_ids: []
  });
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
