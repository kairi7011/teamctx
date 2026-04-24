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
import { NORMALIZED_FILE_BY_KIND } from "../normalize/normalize.js";
import {
  createContextStoreForBinding,
  type ContextStoreFactoryServices
} from "../store/bound-store.js";
import { resolveStoreRoot } from "../store/layout.js";
import { matchesPath } from "../indexes/record-index.js";
import {
  isKnowledgeKind,
  isRecordState,
  validateNormalizedRecord,
  type KnowledgeKind,
  type NormalizedRecord,
  type RecordState
} from "../../schemas/normalized-record.js";
import type { Binding } from "../../schemas/types.js";

export type ListRecordsInput = {
  cwd?: string;
  kinds?: KnowledgeKind[];
  states?: RecordState[];
  paths?: string[];
  domains?: string[];
  symbols?: string[];
  tags?: string[];
  query?: string;
  limit?: number;
};

export type ListRecordItem = {
  id: string;
  kind: KnowledgeKind;
  state: RecordState;
  text: string;
  scope: NormalizedRecord["scope"];
  confidence_level: NormalizedRecord["confidence_level"];
  confidence_score?: number;
  last_verified_at?: string;
  valid_from?: string;
  valid_until?: string;
  invalidated_by?: string;
  supersedes: string[];
  conflicts_with: string[];
};

export type EnabledListRecordsResult = {
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
  records: ListRecordItem[];
};

export type DisabledListRecordsResult = {
  enabled: false;
  reason: string;
};

export type ListRecordsResult = EnabledListRecordsResult | DisabledListRecordsResult;

export type BoundListRecordsServices = ContextStoreFactoryServices & {
  getRepoRoot: (cwd?: string) => string;
  getOriginRemote: (cwd?: string) => string;
  getCurrentBranch: (cwd?: string) => string;
  getHeadCommit: (cwd?: string) => string;
  findBinding: (repo: string) => Binding | undefined;
};

const DEFAULT_LIMIT = 50;

const defaultServices: BoundListRecordsServices = {
  getRepoRoot,
  getOriginRemote,
  getCurrentBranch,
  getHeadCommit,
  findBinding
};

export async function listBoundRecords(
  input: ListRecordsInput = {},
  services: BoundListRecordsServices = defaultServices
): Promise<ListRecordsResult> {
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
    return listResult({
      input,
      records: readLocalRecords(resolveStoreRoot(root, binding.contextStore.path)),
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

  return listResult({
    input,
    records: await readAdapterRecords(store),
    repo,
    root,
    branch,
    headCommit,
    binding,
    storeHead: await store.getRevision(),
    localStore: false
  });
}

function listResult(options: {
  input: ListRecordsInput;
  records: NormalizedRecord[];
  repo: string;
  root: string;
  branch: string;
  headCommit: string;
  binding: Binding;
  storeHead: string | null;
  localStore: boolean;
}): EnabledListRecordsResult {
  const matches = sortRecords(
    options.records.filter((record) => matchesInput(record, options.input))
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
    records: selected.map(listItem)
  };
}

function matchesInput(record: NormalizedRecord, input: ListRecordsInput): boolean {
  return (
    matchesKind(record, input.kinds) &&
    matchesState(record, input.states) &&
    matchesPathFilters(record, input.paths) &&
    matchesOverlap(record.scope.domains, input.domains, normalizeText) &&
    matchesOverlap(record.scope.symbols, input.symbols, normalizeSymbol) &&
    matchesOverlap(record.scope.tags, input.tags, normalizeText) &&
    matchesQuery(record, input.query)
  );
}

function matchesKind(record: NormalizedRecord, kinds: KnowledgeKind[] | undefined): boolean {
  return kinds === undefined || kinds.length === 0 || kinds.includes(record.kind);
}

function matchesState(record: NormalizedRecord, states: RecordState[] | undefined): boolean {
  return states === undefined || states.length === 0 || states.includes(record.state);
}

function matchesPathFilters(record: NormalizedRecord, paths: string[] | undefined): boolean {
  if (paths === undefined || paths.length === 0) {
    return true;
  }

  return record.scope.paths.some((pattern) => paths.some((path) => matchesPath(pattern, path)));
}

function matchesOverlap(
  recordValues: string[],
  inputValues: string[] | undefined,
  normalize: (value: string) => string
): boolean {
  if (inputValues === undefined || inputValues.length === 0) {
    return true;
  }

  const inputKeys = new Set(inputValues.map(normalize));

  return recordValues.some((value) => inputKeys.has(normalize(value)));
}

function matchesQuery(record: NormalizedRecord, query: string | undefined): boolean {
  const tokens = queryTokens(query);

  if (tokens.length === 0) {
    return true;
  }

  const haystack = queryTokens(
    [
      record.id,
      record.kind,
      record.state,
      record.text,
      ...record.scope.paths,
      ...record.scope.domains,
      ...record.scope.symbols,
      ...record.scope.tags
    ].join(" ")
  );
  const haystackSet = new Set(haystack);

  return tokens.every((token) => haystackSet.has(token));
}

function listItem(record: NormalizedRecord): ListRecordItem {
  const item: ListRecordItem = {
    id: record.id,
    kind: record.kind,
    state: record.state,
    text: record.text,
    scope: record.scope,
    confidence_level: record.confidence_level,
    supersedes: record.supersedes,
    conflicts_with: record.conflicts_with
  };

  if (record.confidence_score !== undefined) {
    item.confidence_score = record.confidence_score;
  }
  if (record.last_verified_at !== undefined) {
    item.last_verified_at = record.last_verified_at;
  }
  if (record.valid_from !== undefined) {
    item.valid_from = record.valid_from;
  }
  if (record.valid_until !== undefined) {
    item.valid_until = record.valid_until;
  }
  if (record.invalidated_by !== undefined) {
    item.invalidated_by = record.invalidated_by;
  }

  return item;
}

function readLocalRecords(storeRoot: string): NormalizedRecord[] {
  return Object.values(NORMALIZED_FILE_BY_KIND).flatMap((file) =>
    readJsonl(join(storeRoot, "normalized", file))
  );
}

async function readAdapterRecords(store: ContextStoreAdapter): Promise<NormalizedRecord[]> {
  const groups = await Promise.all(
    Object.values(NORMALIZED_FILE_BY_KIND).map(async (file) => {
      const storeFile = await store.readText(`normalized/${file}`);

      return parseJsonl(storeFile?.content ?? "");
    })
  );

  return groups.flat();
}

function readJsonl(path: string): NormalizedRecord[] {
  if (!existsSync(path)) {
    return [];
  }

  return parseJsonl(readFileSync(path, "utf8"));
}

function parseJsonl(content: string): NormalizedRecord[] {
  const trimmed = content.trim();

  if (trimmed.length === 0) {
    return [];
  }

  return trimmed.split("\n").map((line) => validateNormalizedRecord(JSON.parse(line) as unknown));
}

function sortRecords(records: NormalizedRecord[]): NormalizedRecord[] {
  return [...records].sort(
    (left, right) =>
      comparableTime(right).localeCompare(comparableTime(left)) ||
      left.kind.localeCompare(right.kind) ||
      left.id.localeCompare(right.id)
  );
}

function comparableTime(record: NormalizedRecord): string {
  return record.last_verified_at ?? record.valid_from ?? record.provenance.observed_at;
}

function limitValue(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_LIMIT;
  }

  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("list limit must be a positive integer");
  }

  return limit;
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeSymbol(value: string): string {
  return value.trim();
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

export function parseListKinds(values: string[] | undefined): KnowledgeKind[] | undefined {
  if (values === undefined) {
    return undefined;
  }

  return values.map((value) => {
    if (!isKnowledgeKind(value)) {
      throw new Error(`list kind is invalid: ${value}`);
    }

    return value;
  });
}

export function parseListStates(values: string[] | undefined): RecordState[] | undefined {
  if (values === undefined) {
    return undefined;
  }

  return values.map((value) => {
    if (!isRecordState(value)) {
      throw new Error(`list state is invalid: ${value}`);
    }

    return value;
  });
}
