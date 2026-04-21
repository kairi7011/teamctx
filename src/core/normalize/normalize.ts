import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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

const NORMALIZED_FILE_BY_KIND: Record<KnowledgeKind, string> = {
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
    ...(options.now !== undefined ? { now: options.now } : {})
  });
}

export function normalizeStore(options: {
  repo: string;
  storeRoot: string;
  now?: () => Date;
}): NormalizeStoreResult {
  const now = options.now ?? (() => new Date());
  const rawEvents = readRawEvents(options.storeRoot);
  const recordsByKey = new Map<string, NormalizedRecord>();
  const auditEntries: AuditLogEntry[] = [];
  let droppedEvents = 0;

  for (const rawEvent of rawEvents) {
    const normalized = normalizeRawEvent(rawEvent, options.repo, now);

    if (normalized.record) {
      const key = dedupeKey(normalized.record);
      const sourceEventIds = rawEvent.observation ? [rawEvent.observation.event_id] : [];

      if (!recordsByKey.has(key)) {
        recordsByKey.set(key, normalized.record);
        auditEntries.push(
          createAuditEntry({
            action: "created",
            itemId: normalized.record.id,
            afterState: "active",
            sourceEventIds,
            reason: "evidence minimum check passed",
            now
          })
        );
      }
    } else {
      droppedEvents += 1;
      auditEntries.push(
        createAuditEntry({
          action: "dropped",
          sourceEventIds: rawEvent.observation ? [rawEvent.observation.event_id] : [],
          reason: normalized.reason,
          now
        })
      );
    }
  }

  const records = [...recordsByKey.values()].sort((left, right) => left.id.localeCompare(right.id));
  writeNormalizedRecords(options.storeRoot, records);
  appendAuditEntries(options.storeRoot, auditEntries);

  return {
    rawEventsRead: rawEvents.length,
    recordsWritten: records.length,
    droppedEvents,
    auditEntriesWritten: auditEntries.length
  };
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

function writeJsonl(path: string, rows: unknown[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length > 0 ? "\n" : ""),
    "utf8"
  );
}

function createAuditEntry(options: {
  action: AuditLogEntry["action"];
  itemId?: string;
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
    text: record.text.trim().toLowerCase(),
    scope: record.scope
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

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
