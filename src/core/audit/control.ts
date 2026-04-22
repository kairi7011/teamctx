import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { getOriginRemote, getRepoRoot } from "../../adapters/git/local-git.js";
import { normalizeGitHubRepo } from "../../adapters/git/repo-url.js";
import {
  serializeJsonl,
  type ContextStoreAdapter,
  type ContextStoreFile
} from "../../adapters/store/context-store.js";
import { validateAuditLogEntry, type AuditLogEntry, type AuditState } from "../../schemas/audit.js";
import {
  validateNormalizedRecord,
  type NormalizedRecord
} from "../../schemas/normalized-record.js";
import type { Binding } from "../../schemas/types.js";
import { findBinding } from "../binding/local-bindings.js";
import { NORMALIZED_FILE_BY_KIND } from "../normalize/normalize.js";
import {
  createContextStoreForBinding,
  type ContextStoreFactoryServices
} from "../store/bound-store.js";
import { resolveStoreRoot } from "../store/layout.js";

export type ControlServices = ContextStoreFactoryServices & {
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

export async function explainBoundItemAsync(
  options: BoundControlOptions
): Promise<ExplainItemResult> {
  const boundStore = resolveBoundStore(options);

  if (boundStore.localStoreRoot !== undefined) {
    return explainItem({
      storeRoot: boundStore.localStoreRoot,
      itemId: options.itemId
    });
  }

  return explainItemFromContextStore({
    store: boundStore.store,
    itemId: options.itemId
  });
}

export async function invalidateBoundItemAsync(
  options: BoundControlOptions
): Promise<InvalidateItemResult> {
  const boundStore = resolveBoundStore(options);

  if (boundStore.localStoreRoot !== undefined) {
    return invalidateItem({
      storeRoot: boundStore.localStoreRoot,
      itemId: options.itemId,
      ...(options.reason !== undefined ? { reason: options.reason } : {}),
      ...(options.now !== undefined ? { now: options.now } : {})
    });
  }

  return invalidateItemInContextStore({
    store: boundStore.store,
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
  const invalidationReason = options.reason ?? "manual invalidation";
  const archivedRecord = validateNormalizedRecord({
    ...match.record,
    state: "archived",
    valid_until: now().toISOString(),
    invalidated_by: invalidationReason
  });
  const records = match.records.map((record) =>
    record.id === options.itemId ? archivedRecord : record
  );
  writeJsonl(match.path, records);

  const auditEntry = createAuditEntry({
    itemId: options.itemId,
    beforeState,
    reason: invalidationReason,
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

export async function explainItemFromContextStore(options: {
  store: ContextStoreAdapter;
  itemId: string;
}): Promise<ExplainItemResult> {
  const match = await findRecordInContextStore(options.store, options.itemId);

  if (!match) {
    return {
      found: false,
      item_id: options.itemId
    };
  }

  return {
    found: true,
    record: match.record,
    audit_entries: (await readAuditEntriesFromContextStore(options.store)).filter(
      (entry) => entry.item_id === options.itemId
    )
  };
}

export async function invalidateItemInContextStore(options: {
  store: ContextStoreAdapter;
  itemId: string;
  reason?: string;
  now?: () => Date;
}): Promise<InvalidateItemResult> {
  const match = await findRecordInContextStore(options.store, options.itemId);

  if (!match) {
    throw new Error(`No normalized context item found: ${options.itemId}`);
  }

  const now = options.now ?? (() => new Date());
  const beforeState = match.record.state;
  const invalidationReason = options.reason ?? "manual invalidation";
  const archivedRecord = validateNormalizedRecord({
    ...match.record,
    state: "archived",
    valid_until: now().toISOString(),
    invalidated_by: invalidationReason
  });
  const records = match.records.map((record) =>
    record.id === options.itemId ? archivedRecord : record
  );

  await options.store.writeText(match.path, serializeJsonl(records), {
    message: `Archive teamctx context item ${options.itemId}`,
    expectedRevision: match.file?.revision ?? null
  });

  const auditEntry = createAuditEntry({
    itemId: options.itemId,
    beforeState,
    reason: invalidationReason,
    now
  });
  await options.store.appendJsonl("audit/changes.jsonl", [auditEntry], {
    message: `Append teamctx invalidation audit ${options.itemId}`
  });

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

function resolveBoundStore(
  options: BoundControlOptions
):
  | { localStoreRoot: string; store?: never }
  | { localStoreRoot?: never; store: ContextStoreAdapter } {
  const services = options.services ?? defaultServices;
  const root = services.getRepoRoot(options.cwd);
  const repo = normalizeGitHubRepo(services.getOriginRemote(root));
  const binding = services.findBinding(repo);

  if (!binding) {
    throw new Error("No teamctx binding found. Run: teamctx bind <store> --path <path>");
  }

  if (binding.contextStore.repo === repo) {
    return {
      localStoreRoot: resolveStoreRoot(root, binding.contextStore.path)
    };
  }

  return {
    store:
      services.createContextStore?.({ repo, repoRoot: root, binding }) ??
      createContextStoreForBinding({ repo, repoRoot: root, binding })
  };
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

async function findRecordInContextStore(
  store: ContextStoreAdapter,
  itemId: string
): Promise<
  | {
      path: string;
      file: ContextStoreFile | undefined;
      record: NormalizedRecord;
      records: NormalizedRecord[];
    }
  | undefined
> {
  for (const file of Object.values(NORMALIZED_FILE_BY_KIND)) {
    const path = `normalized/${file}`;
    const storeFile = await store.readText(path);
    const records = jsonlLines(storeFile?.content ?? "").map((line) =>
      validateNormalizedRecord(JSON.parse(line) as unknown)
    );
    const record = records.find((item) => item.id === itemId);

    if (record) {
      return { path, file: storeFile, record, records };
    }
  }

  return undefined;
}

async function readAuditEntriesFromContextStore(
  store: ContextStoreAdapter
): Promise<AuditLogEntry[]> {
  const file = await store.readText("audit/changes.jsonl");

  return jsonlLines(file?.content ?? "").map((line) =>
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

function jsonlLines(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
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
