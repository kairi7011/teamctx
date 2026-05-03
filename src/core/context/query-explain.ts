import type { ContextStoreAdapter } from "../../adapters/store/context-store.js";
import type { BaselineContextDiagnostics, GetContextInput } from "../../schemas/context-payload.js";
import type { KnowledgeKind } from "../../schemas/normalized-record.js";
import { NORMALIZED_FILE_BY_KIND } from "../normalize/normalize.js";
import { NORMALIZED_RECORD_FILES } from "../store/layout.js";
import {
  hasLookupSelectors,
  selectIndexedRecordIds,
  type RecordIndexSet
} from "../indexes/record-index.js";
import { expandQueryTokens, queryWarnings, type QueryAlias } from "../indexes/query-tokens.js";
import { readQueryAliases, readQueryAliasesFromContextStore } from "../store/query-alias-loader.js";
import {
  resolveContextInputSelectors,
  type InferredContextSelectors
} from "./selector-inference.js";
import { explainBaselineContext } from "./baseline-context.js";
import {
  readLastNormalizeAt,
  readLastNormalizeAtFromContextStore,
  readRecordIndexes,
  readRecordIndexesFromContextStore
} from "./index-loader.js";

export type ContextQueryExplain = {
  input: GetContextInput;
  selectors: ContextQuerySelectorSummary;
  inferred_selectors: InferredContextSelectors;
  effective_selectors: ContextQuerySelectorSummary;
  query_expansion: {
    matched_aliases: string[];
    token_groups: string[][];
    warnings: string[];
  };
  baseline_context: BaselineContextDiagnostics;
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

export type ContextQuerySelectorSummary = {
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
  const queryAliases = readQueryAliases(storeRoot);

  return explainContextQuery(input, indexRead.indexes, indexRead.warnings, queryAliases);
}

export async function explainContextQueryFromContextStore(
  store: ContextStoreAdapter,
  input: GetContextInput = {}
): Promise<ContextQueryExplain> {
  const lastNormalizeAt = await readLastNormalizeAtFromContextStore(store);
  const indexRead = await readRecordIndexesFromContextStore(store, lastNormalizeAt);
  const queryAliases = await readQueryAliasesFromContextStore(store);

  return explainContextQuery(input, indexRead.indexes, indexRead.warnings, queryAliases);
}

function explainContextQuery(
  input: GetContextInput,
  indexes: RecordIndexSet,
  warnings: string[],
  queryAliases: QueryAlias[] = []
): ContextQueryExplain {
  const resolved = resolveContextInputSelectors(input);
  const queryExpansion = expandQueryTokens(resolved.input.query, queryAliases);
  const indexed = canUseIndexedRead(resolved.input, indexes, queryAliases);
  const selectedRecordIds = indexed
    ? [...selectIndexedRecordIds(indexes, resolved.input, queryAliases)].sort()
    : [];
  const normalizedFiles = indexed
    ? indexedNormalizedFiles(selectedRecordIds, indexes)
    : NORMALIZED_RECORD_FILES;

  return {
    input,
    selectors: selectorSummary(input),
    inferred_selectors: resolved.inferred_selectors,
    effective_selectors: selectorSummary(resolved.input),
    query_expansion: {
      matched_aliases: queryExpansion.matchedAliasIds,
      token_groups: queryExpansion.tokenGroups,
      warnings: queryWarnings(resolved.input.query, queryAliases)
    },
    baseline_context: explainBaselineContext(resolved.input),
    indexes: {
      path_index: indexUse(indexes.pathIndex?.generated_at, indexed),
      symbol_index: indexUse(
        indexes.symbolIndex?.generated_at,
        indexed && (resolved.input.symbols ?? []).length > 0
      ),
      text_index: indexUse(
        indexes.textIndex?.generated_at,
        indexed && queryExpansion.tokenGroups.length > 0
      ),
      warnings
    },
    read_plan: {
      mode: indexed ? "indexed_normalized_shards" : "full_normalized_scan",
      reason: indexed
        ? "lookup selectors matched generated indexes"
        : fullScanReason(resolved.input, indexes, queryAliases),
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

function selectorSummary(input: GetContextInput): ContextQuerySelectorSummary {
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

function canUseIndexedRead(
  input: GetContextInput,
  indexes: RecordIndexSet,
  queryAliases: QueryAlias[]
): boolean {
  return (
    hasLookupSelectors(input, queryAliases) &&
    typeof indexes.pathIndex?.generated_at === "string" &&
    selectorsHaveUsableIndexes(input, indexes, queryAliases)
  );
}

function selectorsHaveUsableIndexes(
  input: GetContextInput,
  indexes: RecordIndexSet,
  queryAliases: QueryAlias[]
): boolean {
  if ((input.symbols ?? []).length > 0 && typeof indexes.symbolIndex?.generated_at !== "string") {
    return false;
  }

  if (
    expandQueryTokens(input.query, queryAliases).tokenGroups.length > 0 &&
    typeof indexes.textIndex?.generated_at !== "string"
  ) {
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

function fullScanReason(
  input: GetContextInput,
  indexes: RecordIndexSet,
  queryAliases: QueryAlias[]
): string {
  if (!hasLookupSelectors(input, queryAliases)) {
    return "no lookup selectors were provided";
  }

  if (typeof indexes.pathIndex?.generated_at !== "string") {
    return "path index is missing or not generated";
  }

  if ((input.symbols ?? []).length > 0 && typeof indexes.symbolIndex?.generated_at !== "string") {
    return "symbol selectors require a generated symbol index";
  }

  if (
    expandQueryTokens(input.query, queryAliases).tokenGroups.length > 0 &&
    typeof indexes.textIndex?.generated_at !== "string"
  ) {
    return "query selector requires a generated text index";
  }

  return "indexes are not usable for this selector set";
}
