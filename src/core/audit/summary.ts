import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ContextStoreAdapter } from "../../adapters/store/context-store.js";
import { normalizeGitHubRepo } from "../../adapters/git/repo-url.js";
import {
  getCurrentBranch,
  getHeadCommit,
  getOriginRemote,
  getRepoRoot
} from "../../adapters/git/local-git.js";
import { findBinding } from "../binding/local-bindings.js";
import {
  createContextStoreForBinding,
  type ContextStoreFactoryServices
} from "../store/bound-store.js";
import { resolveStoreRoot } from "../store/layout.js";
import {
  AUDIT_ACTIONS,
  validateAuditLogEntry,
  type AuditAction,
  type AuditLogEntry
} from "../../schemas/audit.js";
import type { Binding } from "../../schemas/types.js";

export type AuditSummaryInput = {
  cwd?: string;
  actions?: AuditAction[];
  item_ids?: string[];
  source_event_ids?: string[];
  query?: string;
  limit?: number;
};

export type EnabledAuditSummary = {
  enabled: true;
  repo: string;
  root: string;
  branch: string;
  head_commit: string;
  context_store: string;
  store_head: string | null;
  local_store: boolean;
  total_matches: number;
  returned: number;
  entries: AuditLogEntry[];
};

export type DisabledAuditSummary = {
  enabled: false;
  reason: string;
};

export type AuditSummary = EnabledAuditSummary | DisabledAuditSummary;

export type BoundAuditServices = ContextStoreFactoryServices & {
  getRepoRoot: (cwd?: string) => string;
  getOriginRemote: (cwd?: string) => string;
  getCurrentBranch: (cwd?: string) => string;
  getHeadCommit: (cwd?: string) => string;
  findBinding: (repo: string) => Binding | undefined;
};

const DEFAULT_LIMIT = 50;

const defaultServices: BoundAuditServices = {
  getRepoRoot,
  getOriginRemote,
  getCurrentBranch,
  getHeadCommit,
  findBinding
};

export async function getBoundAuditSummary(
  input: AuditSummaryInput = {},
  services: BoundAuditServices = defaultServices
): Promise<AuditSummary> {
  let root: string;
  let repo: string;
  let branch: string;
  let headCommit: string;

  try {
    root = services.getRepoRoot(input.cwd);
    repo = normalizeGitHubRepo(services.getOriginRemote(root));
    branch = services.getCurrentBranch(root);
    headCommit = services.getHeadCommit(root);
  } catch {
    return {
      enabled: false,
      reason: "No git repository with an origin remote found for this workspace."
    };
  }

  const binding = services.findBinding(repo);

  if (!binding) {
    return { enabled: false, reason: "No teamctx binding found for this git root." };
  }

  if (binding.contextStore.repo === repo) {
    return auditResult({
      input,
      entries: readLocalAudit(resolveStoreRoot(root, binding.contextStore.path)),
      repo,
      root,
      branch,
      headCommit,
      binding,
      storeHead: null,
      localStore: true
    });
  }

  const store = createContextStoreForBinding({
    repo,
    repoRoot: root,
    binding,
    ...(services.createContextStore !== undefined
      ? { createContextStore: services.createContextStore }
      : {})
  });

  return auditResult({
    input,
    entries: await readAdapterAudit(store),
    repo,
    root,
    branch,
    headCommit,
    binding,
    storeHead: await store.getRevision(),
    localStore: false
  });
}

function auditResult(options: {
  input: AuditSummaryInput;
  entries: AuditLogEntry[];
  repo: string;
  root: string;
  branch: string;
  headCommit: string;
  binding: Binding;
  storeHead: string | null;
  localStore: boolean;
}): EnabledAuditSummary {
  const matches = sortAuditEntries(
    options.entries.filter((entry) => matchesAuditInput(entry, options.input))
  );
  const limit = limitValue(options.input.limit);
  const selected = matches.slice(0, limit);

  return {
    enabled: true,
    repo: options.repo,
    root: options.root,
    branch: options.branch,
    head_commit: options.headCommit,
    context_store: `${options.binding.contextStore.repo}/${options.binding.contextStore.path}`,
    store_head: options.storeHead,
    local_store: options.localStore,
    total_matches: matches.length,
    returned: selected.length,
    entries: selected
  };
}

function matchesAuditInput(entry: AuditLogEntry, input: AuditSummaryInput): boolean {
  return (
    matchesAction(entry, input.actions) &&
    matchesItem(entry, input.item_ids) &&
    matchesSourceEvent(entry, input.source_event_ids) &&
    matchesQuery(entry, input.query)
  );
}

function matchesAction(entry: AuditLogEntry, actions: AuditAction[] | undefined): boolean {
  return actions === undefined || actions.length === 0 || actions.includes(entry.action);
}

function matchesItem(entry: AuditLogEntry, itemIds: string[] | undefined): boolean {
  return itemIds === undefined || itemIds.length === 0 || itemIds.includes(entry.item_id ?? "");
}

function matchesSourceEvent(entry: AuditLogEntry, sourceEventIds: string[] | undefined): boolean {
  if (sourceEventIds === undefined || sourceEventIds.length === 0) {
    return true;
  }

  return entry.source_event_ids.some((eventId) => sourceEventIds.includes(eventId));
}

function matchesQuery(entry: AuditLogEntry, query: string | undefined): boolean {
  const tokens = queryTokens(query);

  if (tokens.length === 0) {
    return true;
  }

  const haystack = queryTokens(
    [
      entry.id,
      entry.at,
      entry.action,
      entry.item_id ?? "",
      entry.before_state ?? "",
      entry.after_state ?? "",
      entry.reason ?? "",
      ...entry.source_event_ids
    ].join(" ")
  );
  const haystackSet = new Set(haystack);

  return tokens.every((token) => haystackSet.has(token));
}

function readLocalAudit(storeRoot: string): AuditLogEntry[] {
  const path = join(storeRoot, "audit", "changes.jsonl");

  if (!existsSync(path)) {
    return [];
  }

  return parseAuditJsonl(readFileSync(path, "utf8"));
}

async function readAdapterAudit(store: ContextStoreAdapter): Promise<AuditLogEntry[]> {
  const file = await store.readText("audit/changes.jsonl");

  return parseAuditJsonl(file?.content ?? "");
}

function parseAuditJsonl(content: string): AuditLogEntry[] {
  const trimmed = content.trim();

  if (trimmed.length === 0) {
    return [];
  }

  return trimmed.split("\n").map((line) => validateAuditLogEntry(JSON.parse(line) as unknown));
}

function sortAuditEntries(entries: AuditLogEntry[]): AuditLogEntry[] {
  return [...entries].sort(
    (left, right) => right.at.localeCompare(left.at) || left.id.localeCompare(right.id)
  );
}

function limitValue(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_LIMIT;
  }

  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("audit limit must be a positive integer");
  }

  return limit;
}

function queryTokens(query: string | undefined): string[] {
  if (query === undefined) {
    return [];
  }

  return query
    .toLowerCase()
    .split(/[^a-z0-9_]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

export function parseAuditActions(values: string[] | undefined): AuditAction[] | undefined {
  if (values === undefined) {
    return undefined;
  }

  return values.map((value) => {
    if (!isAuditAction(value)) {
      throw new Error(`audit action is invalid: ${value}`);
    }

    return value;
  });
}

function isAuditAction(value: string): value is AuditAction {
  return AUDIT_ACTIONS.includes(value as AuditAction);
}
