import type { ContextStoreAdapter } from "../../adapters/store/context-store.js";
import type { GetContextInput } from "../../schemas/context-payload.js";
import type { KnowledgeKind } from "../../schemas/normalized-record.js";
import { NORMALIZED_FILE_BY_KIND } from "../normalize/normalize.js";
import { NORMALIZED_RECORD_FILES } from "../store/layout.js";
import {
  hasLookupSelectors,
  selectIndexedRecordIds,
  type RecordIndexSet
} from "../indexes/record-index.js";
import {
  readLastNormalizeAt,
  readLastNormalizeAtFromContextStore,
  readRecordIndexes,
  readRecordIndexesFromContextStore
} from "./index-loader.js";

export type ContextQueryExplain = {
  input: GetContextInput;
  selectors: {
    target_files: string[];
    changed_files: string[];
    domains: string[];
    symbols: string[];
    tags: string[];
    query?: string;
    since?: string;
    until?: string;
    source_types: string[];
    evidence_files: string[];
  };
  indexes: {
    path_index: IndexUse;
    symbol_index: IndexUse;
    text_index: IndexUse;
    warnings: string[];
  };
  read_plan: {
    mode: "indexed_normalized_shards" | "full_normalized_scan";
    reason: string;
    normalized_files: readonly string[];
    selected_record_ids: string[];
  };
};

export type IndexUse = {
  present: boolean;
  generated_at?: string | null;
  used: boolean;
};

export function explainContextQueryFromStore(
  storeRoot: string,
  input: GetContextInput = {}
): ContextQueryExplain {
  const lastNormalizeAt = readLastNormalizeAt(storeRoot);
  const indexRead = readRecordIndexes(storeRoot, lastNormalizeAt);

  return explainContextQuery(input, indexRead.indexes, indexRead.warnings);
}

export async function explainContextQueryFromContextStore(
  store: ContextStoreAdapter,
  input: GetContextInput = {}
): Promise<ContextQueryExplain> {
  const lastNormalizeAt = await readLastNormalizeAtFromContextStore(store);
  const indexRead = await readRecordIndexesFromContextStore(store, lastNormalizeAt);

  return explainContextQuery(input, indexRead.indexes, indexRead.warnings);
}

function explainContextQuery(
  input: GetContextInput,
  indexes: RecordIndexSet,
  warnings: string[]
): ContextQueryExplain {
  const indexed = canUseIndexedRead(input, indexes);
  const selectedRecordIds = indexed ? [...selectIndexedRecordIds(indexes, input)].sort() : [];
  const normalizedFiles = indexed
    ? indexedNormalizedFiles(selectedRecordIds, indexes)
    : NORMALIZED_RECORD_FILES;

  return {
    input,
    selectors: selectorSummary(input),
    indexes: {
      path_index: indexUse(indexes.pathIndex?.generated_at, indexed),
      symbol_index: indexUse(
        indexes.symbolIndex?.generated_at,
        indexed && (input.symbols ?? []).length > 0
      ),
      text_index: indexUse(indexes.textIndex?.generated_at, indexed && input.query !== undefined),
      warnings
    },
    read_plan: {
      mode: indexed ? "indexed_normalized_shards" : "full_normalized_scan",
      reason: indexed
        ? "lookup selectors matched generated indexes"
        : fullScanReason(input, indexes),
      normalized_files: normalizedFiles,
      selected_record_ids: selectedRecordIds
    }
  };
}

function indexUse(generatedAt: string | null | undefined, used: boolean): IndexUse {
  const output: IndexUse = {
    present: generatedAt !== undefined,
    used
  };

  if (generatedAt !== undefined) {
    output.generated_at = generatedAt;
  }

  return output;
}

function selectorSummary(input: GetContextInput): ContextQueryExplain["selectors"] {
  return {
    target_files: input.target_files ?? [],
    changed_files: input.changed_files ?? [],
    domains: input.domains ?? [],
    symbols: input.symbols ?? [],
    tags: input.tags ?? [],
    ...(input.query !== undefined ? { query: input.query } : {}),
    ...(input.since !== undefined ? { since: input.since } : {}),
    ...(input.until !== undefined ? { until: input.until } : {}),
    source_types: input.source_types ?? [],
    evidence_files: input.evidence_files ?? []
  };
}

function canUseIndexedRead(input: GetContextInput, indexes: RecordIndexSet): boolean {
  return (
    hasLookupSelectors(input) &&
    typeof indexes.pathIndex?.generated_at === "string" &&
    selectorsHaveUsableIndexes(input, indexes)
  );
}

function selectorsHaveUsableIndexes(input: GetContextInput, indexes: RecordIndexSet): boolean {
  if ((input.symbols ?? []).length > 0 && typeof indexes.symbolIndex?.generated_at !== "string") {
    return false;
  }

  if (input.query !== undefined && typeof indexes.textIndex?.generated_at !== "string") {
    return false;
  }

  return true;
}

function indexedNormalizedFiles(selectedRecordIds: string[], indexes: RecordIndexSet): string[] {
  const selected = new Set(selectedRecordIds);
  const files = new Set<string>();

  files.add(NORMALIZED_FILE_BY_KIND.fact);
  files.add(NORMALIZED_FILE_BY_KIND.rule);
  files.add(NORMALIZED_FILE_BY_KIND.glossary);

  for (const kind of Object.keys(NORMALIZED_FILE_BY_KIND) as KnowledgeKind[]) {
    const ids = indexes.pathIndex?.kinds[kind] ?? [];

    if (ids.some((id) => selected.has(id))) {
      files.add(NORMALIZED_FILE_BY_KIND[kind]);
    }
  }

  return NORMALIZED_RECORD_FILES.filter((file) => files.has(file));
}

function fullScanReason(input: GetContextInput, indexes: RecordIndexSet): string {
  if (!hasLookupSelectors(input)) {
    return "no lookup selectors were provided";
  }

  if (typeof indexes.pathIndex?.generated_at !== "string") {
    return "path index is missing or not generated";
  }

  if ((input.symbols ?? []).length > 0 && typeof indexes.symbolIndex?.generated_at !== "string") {
    return "symbol selectors require a generated symbol index";
  }

  if (input.query !== undefined && typeof indexes.textIndex?.generated_at !== "string") {
    return "query selector requires a generated text index";
  }

  return "indexes are not usable for this selector set";
}
