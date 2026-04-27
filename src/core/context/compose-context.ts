import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ContextStoreAdapter } from "../../adapters/store/context-store.js";
import {
  budgetRecords,
  DEFAULT_CONTEXT_BUDGETS,
  rankRecords,
  rankedTexts,
  scopedContextItem,
  type BudgetedRecords,
  type RankedRecord
} from "./context-ranking.js";
import {
  readEpisodeIndex,
  readEpisodeIndexFromContextStore,
  readLastNormalizeAt,
  readLastNormalizeAtFromContextStore,
  readRecordIndexes,
  readRecordIndexesFromContextStore
} from "./index-loader.js";
import type { EpisodeIndex } from "../indexes/episode-index.js";
import { selectRelevantEpisodes } from "./episode-selection.js";
import { jsonlLines } from "../store/jsonl.js";
import { NORMALIZED_RECORD_FILES } from "../store/layout.js";
import { NORMALIZED_FILE_BY_KIND } from "../normalize/normalize.js";
import {
  hasLookupSelectors,
  matchesScopeInput,
  selectIndexedRecordIds,
  type RecordIndexSet
} from "../indexes/record-index.js";
import {
  validateNormalizedRecord,
  type KnowledgeKind,
  type NormalizedRecord
} from "../../schemas/normalized-record.js";
import type { GetContextInput, EnabledContextPayload } from "../../schemas/context-payload.js";

export type ComposedContext = Pick<
  EnabledContextPayload,
  "normalized_context" | "relevant_episodes" | "canonical_doc_refs" | "diagnostics"
>;

export function composeContextFromStore(
  storeRoot: string,
  input: GetContextInput = {}
): ComposedContext {
  const records = readNormalizedRecords(storeRoot);
  const lastNormalizeAt = readLastNormalizeAt(storeRoot);
  const indexRead = readRecordIndexes(storeRoot, lastNormalizeAt);
  const episodeRead = readEpisodeIndex(storeRoot, lastNormalizeAt);

  return composeContextFromRecords(
    records,
    input,
    indexRead.indexes,
    undefined,
    episodeRead.index,
    [...indexRead.warnings, ...episodeRead.warnings]
  );
}

export async function composeContextFromContextStore(
  store: ContextStoreAdapter,
  input: GetContextInput = {}
): Promise<ComposedContext> {
  const lastNormalizeAt = await readLastNormalizeAtFromContextStore(store);
  const indexRead = await readRecordIndexesFromContextStore(store, lastNormalizeAt);
  const episodeRead = await readEpisodeIndexFromContextStore(store, lastNormalizeAt);
  const readResult = await readNormalizedRecordsFromContextStore(store, input, indexRead.indexes);

  return composeContextFromRecords(
    readResult.records,
    input,
    indexRead.indexes,
    readResult.diagnostics,
    episodeRead.index,
    [...indexRead.warnings, ...episodeRead.warnings]
  );
}

function composeContextFromRecords(
  records: NormalizedRecord[],
  input: GetContextInput,
  indexes: RecordIndexSet = {},
  diagnostics?: PrecomputedDiagnostics,
  episodeIndex?: EpisodeIndex,
  indexWarnings: string[] = []
): ComposedContext {
  const activeRecords = records.filter(
    (record) => record.state === "active" && matchesTimeInput(record, input)
  );
  const scopedRecords = selectScopedRecords(activeRecords, input, indexes);
  const globallyApplicableRecords = activeRecords.filter(isGloballyApplicableRecord);
  const applicableRecords = uniqueRecordsById([...scopedRecords, ...globallyApplicableRecords]);
  const scopedBudget = budgetRecords(scopedRecords, input, DEFAULT_CONTEXT_BUDGETS.scopedItems);
  const globalBudget = budgetRecords(
    globallyApplicableRecords.filter((record) => isGlobalKind(record.kind)),
    input,
    DEFAULT_CONTEXT_BUDGETS.globalItems
  );
  const ruleBudget = budgetRecords(
    applicableRecords.filter((record) => record.kind === "rule"),
    input,
    DEFAULT_CONTEXT_BUDGETS.globalItems
  );
  const decisionBudget = budgetRecords(
    applicableRecords.filter((record) => record.kind === "decision"),
    input,
    DEFAULT_CONTEXT_BUDGETS.decisions
  );
  const pitfallBudget = budgetRecords(
    applicableRecords.filter((record) => record.kind === "pitfall"),
    input,
    DEFAULT_CONTEXT_BUDGETS.pitfalls
  );
  const workflowBudget = budgetRecords(
    applicableRecords.filter((record) => record.kind === "workflow"),
    input,
    DEFAULT_CONTEXT_BUDGETS.workflows
  );
  const glossaryBudget = budgetRecords(
    applicableRecords.filter((record) => record.kind === "glossary"),
    input,
    DEFAULT_CONTEXT_BUDGETS.glossary
  );

  return {
    normalized_context: {
      global: globalContext(globalBudget.selected),
      scoped: scopedBudget.selected.map((ranked) =>
        scopedContextItem(ranked, DEFAULT_CONTEXT_BUDGETS.contentChars)
      ),
      must_follow_rules: rankedTexts(ruleBudget.selected, DEFAULT_CONTEXT_BUDGETS.contentChars),
      recent_decisions: rankedTexts(decisionBudget.selected, DEFAULT_CONTEXT_BUDGETS.contentChars),
      active_pitfalls: rankedTexts(pitfallBudget.selected, DEFAULT_CONTEXT_BUDGETS.contentChars),
      applicable_workflows: rankedTexts(
        workflowBudget.selected,
        DEFAULT_CONTEXT_BUDGETS.contentChars
      ),
      glossary_terms: rankedTexts(glossaryBudget.selected, DEFAULT_CONTEXT_BUDGETS.contentChars)
    },
    relevant_episodes: selectRelevantEpisodes(episodeIndex, input),
    canonical_doc_refs: canonicalDocRefs(scopedBudget.selected.map((ranked) => ranked.record)),
    diagnostics: {
      contested_items:
        diagnostics?.contested_items ??
        records.filter((record) => record.state === "contested").map((record) => record.id),
      stale_items:
        diagnostics?.stale_items ??
        records.filter((record) => record.state === "stale").map((record) => record.id),
      dropped_items: budgetDroppedIds([scopedBudget]),
      excluded_items: diagnostics?.excluded_items ?? excludedItems(records),
      budget_rejected: budgetRejected([
        { budget: scopedBudget, reason: "budget_overflow:scoped" },
        { budget: ruleBudget, reason: "budget_overflow:rule" },
        { budget: decisionBudget, reason: "budget_overflow:decision" },
        { budget: pitfallBudget, reason: "budget_overflow:pitfall" },
        { budget: workflowBudget, reason: "budget_overflow:workflow" },
        { budget: glossaryBudget, reason: "budget_overflow:glossary" }
      ]),
      index_warnings: indexWarnings
    }
  };
}

function selectScopedRecords(
  activeRecords: NormalizedRecord[],
  input: GetContextInput,
  indexes: RecordIndexSet
): NormalizedRecord[] {
  if (
    hasLookupSelectors(input) &&
    hasGeneratedIndex(indexes) &&
    selectorsHaveUsableIndexes(input, indexes)
  ) {
    const selectedIds = selectIndexedRecordIds(indexes, input);

    return activeRecords.filter((record) => selectedIds.has(record.id));
  }

  if (!hasLookupSelectors(input) && hasTimeFilters(input)) {
    return activeRecords;
  }

  return activeRecords.filter((record) => matchesScopeInput(record, input));
}

function hasGeneratedIndex(indexes: RecordIndexSet): boolean {
  return (
    typeof indexes.pathIndex?.generated_at === "string" ||
    typeof indexes.symbolIndex?.generated_at === "string" ||
    typeof indexes.textIndex?.generated_at === "string"
  );
}

export function emptyComposedContext(): ComposedContext {
  return {
    normalized_context: {
      global: "",
      scoped: [],
      must_follow_rules: [],
      recent_decisions: [],
      active_pitfalls: [],
      applicable_workflows: [],
      glossary_terms: []
    },
    canonical_doc_refs: [],
    relevant_episodes: [],
    diagnostics: {
      contested_items: [],
      stale_items: [],
      dropped_items: [],
      excluded_items: [],
      budget_rejected: [],
      index_warnings: []
    }
  };
}

function readNormalizedRecords(storeRoot: string): NormalizedRecord[] {
  const records: NormalizedRecord[] = [];

  for (const file of NORMALIZED_RECORD_FILES) {
    const path = join(storeRoot, "normalized", file);

    for (const line of readJsonlLines(path)) {
      records.push(validateNormalizedRecord(JSON.parse(line) as unknown));
    }
  }

  return records.sort((left, right) => left.id.localeCompare(right.id));
}

async function readNormalizedRecordsFromContextStore(
  store: ContextStoreAdapter,
  input: GetContextInput,
  indexes: RecordIndexSet
): Promise<ContextStoreReadResult> {
  const records: NormalizedRecord[] = [];
  const readPlan = contextStoreReadPlan(input, indexes);

  for (const file of readPlan.files) {
    const storeFile = await store.readText(`normalized/${file}`);

    for (const line of jsonlLines(storeFile?.content ?? "")) {
      records.push(validateNormalizedRecord(JSON.parse(line) as unknown));
    }
  }

  const sortedRecords = records.sort((left, right) => left.id.localeCompare(right.id));

  return readPlan.diagnostics === undefined
    ? { records: sortedRecords }
    : { records: sortedRecords, diagnostics: readPlan.diagnostics };
}

function readJsonlLines(path: string): string[] {
  try {
    return jsonlLines(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
}

function globalContext(ranked: RankedRecord[]): string {
  return rankedTexts(ranked, DEFAULT_CONTEXT_BUDGETS.contentChars).join("\n");
}

function isGlobalKind(kind: NormalizedRecord["kind"]): boolean {
  return kind === "fact" || kind === "rule" || kind === "glossary";
}

function isGloballyApplicableRecord(record: NormalizedRecord): boolean {
  return (
    isGlobalKind(record.kind) &&
    record.scope.paths.length === 0 &&
    record.scope.domains.length === 0 &&
    record.scope.symbols.length === 0 &&
    record.scope.tags.length === 0
  );
}

function uniqueRecordsById(records: NormalizedRecord[]): NormalizedRecord[] {
  const seen = new Set<string>();
  const unique: NormalizedRecord[] = [];

  for (const record of records) {
    if (seen.has(record.id)) {
      continue;
    }

    seen.add(record.id);
    unique.push(record);
  }

  return unique;
}

function budgetDroppedIds(budgets: Array<{ overflow: RankedRecord[] }>): string[] {
  return [
    ...new Set(
      budgets.flatMap((budget) => budget.overflow.map((ranked) => `budget:${ranked.record.id}`))
    )
  ].sort((left, right) => left.localeCompare(right));
}

function budgetRejected(budgets: Array<{ budget: BudgetedRecords; reason: string }>): Array<{
  id: string;
  kind: string;
  rank_score: number;
  rank_reasons: string[];
  exclusion_reason: string;
}> {
  const seen = new Set<string>();
  const rejected: Array<{
    id: string;
    kind: string;
    rank_score: number;
    rank_reasons: string[];
    exclusion_reason: string;
  }> = [];

  for (const { budget, reason } of budgets) {
    for (const ranked of budget.overflow) {
      if (seen.has(ranked.record.id)) {
        continue;
      }

      seen.add(ranked.record.id);
      rejected.push({
        id: ranked.record.id,
        kind: ranked.record.kind,
        rank_score: ranked.score,
        rank_reasons: ranked.reasons,
        exclusion_reason: reason
      });
    }
  }

  return rejected.sort(
    (left, right) => right.rank_score - left.rank_score || left.id.localeCompare(right.id)
  );
}

function excludedItems(records: NormalizedRecord[]): Array<{
  id: string;
  state: string;
  reason: string;
}> {
  return records
    .filter((record) => record.state !== "active")
    .map((record) => ({
      id: record.id,
      state: record.state,
      reason: exclusionReason(record.state)
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

type ContextStoreReadResult = {
  records: NormalizedRecord[];
  diagnostics?: PrecomputedDiagnostics;
};

type PrecomputedDiagnostics = Pick<
  ComposedContext["diagnostics"],
  "contested_items" | "stale_items" | "excluded_items" | "budget_rejected"
>;

function contextStoreReadPlan(
  input: GetContextInput,
  indexes: RecordIndexSet
): { files: readonly string[]; diagnostics?: PrecomputedDiagnostics } {
  if (!canUseIndexedContextStoreRead(input, indexes)) {
    return { files: NORMALIZED_RECORD_FILES };
  }

  const diagnostics = diagnosticsFromIndexes(indexes);
  const files = indexedNormalizedFiles(input, indexes);

  return diagnostics === undefined ? { files } : { files, diagnostics };
}

function canUseIndexedContextStoreRead(input: GetContextInput, indexes: RecordIndexSet): boolean {
  return (
    hasLookupSelectors(input) &&
    typeof indexes.pathIndex?.generated_at === "string" &&
    selectorsHaveUsableIndexes(input, indexes)
  );
}

function indexedNormalizedFiles(input: GetContextInput, indexes: RecordIndexSet): string[] {
  const selectedIds = selectIndexedRecordIds(indexes, input);
  const files = new Set<string>();

  addGlobalNormalizedFiles(files);

  for (const kind of Object.keys(NORMALIZED_FILE_BY_KIND) as KnowledgeKind[]) {
    const ids = indexes.pathIndex?.kinds[kind] ?? [];

    if (ids.some((id) => selectedIds.has(id))) {
      files.add(NORMALIZED_FILE_BY_KIND[kind]);
    }
  }

  return NORMALIZED_RECORD_FILES.filter((file) => files.has(file));
}

function addGlobalNormalizedFiles(files: Set<string>): void {
  files.add(NORMALIZED_FILE_BY_KIND.fact);
  files.add(NORMALIZED_FILE_BY_KIND.rule);
  files.add(NORMALIZED_FILE_BY_KIND.glossary);
}

function diagnosticsFromIndexes(indexes: RecordIndexSet): PrecomputedDiagnostics | undefined {
  const states = indexes.pathIndex?.states;

  if (states === undefined) {
    return undefined;
  }

  const excluded_items = (["contested", "stale", "superseded", "archived"] as const).flatMap(
    (state) =>
      (states[state] ?? []).map((id) => ({
        id,
        state,
        reason: exclusionReason(state)
      }))
  );

  return {
    contested_items: uniqueSorted(states.contested ?? []),
    stale_items: uniqueSorted(states.stale ?? []),
    excluded_items: excluded_items.sort((left, right) => left.id.localeCompare(right.id)),
    budget_rejected: []
  };
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
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

function matchesTimeInput(record: NormalizedRecord, input: GetContextInput): boolean {
  const since = input.since === undefined ? undefined : Date.parse(input.since);
  const until = input.until === undefined ? undefined : Date.parse(input.until);

  if (since === undefined && until === undefined) {
    return true;
  }

  const recordTime = Date.parse(record.last_verified_at ?? record.provenance.observed_at);

  if (Number.isNaN(recordTime)) {
    return false;
  }

  return (
    (since === undefined || recordTime >= since) && (until === undefined || recordTime <= until)
  );
}

function hasTimeFilters(input: GetContextInput): boolean {
  return input.since !== undefined || input.until !== undefined;
}

function exclusionReason(state: NormalizedRecord["state"]): string {
  switch (state) {
    case "contested":
      return "excluded because competing same-scope assertions need human review";
    case "stale":
      return "excluded because supporting evidence is stale";
    case "superseded":
      return "excluded because a newer record supersedes it";
    case "archived":
      return "excluded because it was manually archived";
    case "active":
      return "included";
  }
}

export type RankTraceEntry = {
  id: string;
  kind: string;
  state: string;
  scope_summary: string;
  rank_score: number;
  rank_reasons: string[];
  in_context: boolean;
  context_placement?: string;
  exclusion_reason?: string;
};

export type RankTrace = {
  total_records: number;
  active_records: number;
  candidates: number;
  in_context: number;
  entries: RankTraceEntry[];
};

export function rankContextFromStore(storeRoot: string, input: GetContextInput = {}): RankTrace {
  const records = readNormalizedRecords(storeRoot);
  const lastNormalizeAt = readLastNormalizeAt(storeRoot);
  const indexRead = readRecordIndexes(storeRoot, lastNormalizeAt);

  return buildRankTrace(records, input, indexRead.indexes);
}

export async function rankContextFromContextStore(
  store: ContextStoreAdapter,
  input: GetContextInput = {}
): Promise<RankTrace> {
  const lastNormalizeAt = await readLastNormalizeAtFromContextStore(store);
  const indexRead = await readRecordIndexesFromContextStore(store, lastNormalizeAt);
  const records: NormalizedRecord[] = [];

  for (const file of NORMALIZED_RECORD_FILES) {
    const storeFile = await store.readText(`normalized/${file}`);

    for (const line of jsonlLines(storeFile?.content ?? "")) {
      records.push(validateNormalizedRecord(JSON.parse(line) as unknown));
    }
  }

  const sortedRecords = records.sort((left, right) => left.id.localeCompare(right.id));

  return buildRankTrace(sortedRecords, input, indexRead.indexes);
}

function buildRankTrace(
  records: NormalizedRecord[],
  input: GetContextInput,
  indexes: RecordIndexSet = {}
): RankTrace {
  const activeRecords = records.filter(
    (record) => record.state === "active" && matchesTimeInput(record, input)
  );
  const scopedRecords = selectScopedRecords(activeRecords, input, indexes);
  const globallyApplicableRecords = activeRecords.filter(isGloballyApplicableRecord);
  const applicableRecords = uniqueRecordsById([...scopedRecords, ...globallyApplicableRecords]);
  const applicableIds = new Set(applicableRecords.map((r) => r.id));

  const scopedBudget = budgetRecords(scopedRecords, input, DEFAULT_CONTEXT_BUDGETS.scopedItems);
  const globalBudget = budgetRecords(
    globallyApplicableRecords.filter((record) => isGlobalKind(record.kind)),
    input,
    DEFAULT_CONTEXT_BUDGETS.globalItems
  );
  const ruleBudget = budgetRecords(
    applicableRecords.filter((record) => record.kind === "rule"),
    input,
    DEFAULT_CONTEXT_BUDGETS.globalItems
  );
  const decisionBudget = budgetRecords(
    applicableRecords.filter((record) => record.kind === "decision"),
    input,
    DEFAULT_CONTEXT_BUDGETS.decisions
  );
  const pitfallBudget = budgetRecords(
    applicableRecords.filter((record) => record.kind === "pitfall"),
    input,
    DEFAULT_CONTEXT_BUDGETS.pitfalls
  );
  const workflowBudget = budgetRecords(
    applicableRecords.filter((record) => record.kind === "workflow"),
    input,
    DEFAULT_CONTEXT_BUDGETS.workflows
  );
  const glossaryBudget = budgetRecords(
    applicableRecords.filter((record) => record.kind === "glossary"),
    input,
    DEFAULT_CONTEXT_BUDGETS.glossary
  );

  const placements = new Map<string, string>();
  for (const ranked of scopedBudget.selected) placements.set(ranked.record.id, "scoped");
  for (const ranked of globalBudget.selected) placements.set(ranked.record.id, "global");
  for (const ranked of ruleBudget.selected) placements.set(ranked.record.id, "rules");
  for (const ranked of decisionBudget.selected) placements.set(ranked.record.id, "decisions");
  for (const ranked of pitfallBudget.selected) placements.set(ranked.record.id, "pitfalls");
  for (const ranked of workflowBudget.selected) placements.set(ranked.record.id, "workflows");
  for (const ranked of glossaryBudget.selected) placements.set(ranked.record.id, "glossary");

  const overflowReasons = new Map<string, string>();
  for (const [budget, reason] of [
    [scopedBudget, "budget_overflow:scoped"],
    [ruleBudget, "budget_overflow:rule"],
    [decisionBudget, "budget_overflow:decision"],
    [pitfallBudget, "budget_overflow:pitfall"],
    [workflowBudget, "budget_overflow:workflow"],
    [glossaryBudget, "budget_overflow:glossary"]
  ] as Array<[BudgetedRecords, string]>) {
    for (const ranked of budget.overflow) {
      if (!overflowReasons.has(ranked.record.id)) {
        overflowReasons.set(ranked.record.id, reason);
      }
    }
  }

  const entries: RankTraceEntry[] = [];

  for (const entry of rankRecords(activeRecords, input)) {
    const placement = placements.get(entry.record.id);
    const overflowReason = overflowReasons.get(entry.record.id);
    const traceEntry: RankTraceEntry = {
      id: entry.record.id,
      kind: entry.record.kind,
      state: entry.record.state,
      scope_summary: traceScopeSummary(entry.record),
      rank_score: entry.score,
      rank_reasons: entry.reasons,
      in_context: placement !== undefined
    };

    if (placement !== undefined) {
      traceEntry.context_placement = placement;
    } else {
      traceEntry.exclusion_reason =
        overflowReason ??
        (applicableIds.has(entry.record.id) ? "budget_overflow" : "scope_not_matched");
    }

    entries.push(traceEntry);
  }

  for (const record of records.filter((r) => r.state !== "active")) {
    entries.push({
      id: record.id,
      kind: record.kind,
      state: record.state,
      scope_summary: traceScopeSummary(record),
      rank_score: 0,
      rank_reasons: [],
      in_context: false,
      exclusion_reason: `state_excluded:${record.state}`
    });
  }

  entries.sort(
    (left, right) =>
      Number(right.in_context) - Number(left.in_context) ||
      right.rank_score - left.rank_score ||
      left.id.localeCompare(right.id)
  );

  return {
    total_records: records.length,
    active_records: activeRecords.length,
    candidates: applicableIds.size,
    in_context: placements.size,
    entries
  };
}

function traceScopeSummary(record: NormalizedRecord): string {
  const parts: string[] = [];

  if (record.scope.paths.length > 0) {
    const shown = record.scope.paths.slice(0, 2);
    const suffix = record.scope.paths.length > 2 ? "..." : "";
    parts.push(`paths: [${shown.join(", ")}${suffix}]`);
  }
  if (record.scope.domains.length > 0) {
    parts.push(`domains: [${record.scope.domains.join(", ")}]`);
  }
  if (record.scope.symbols.length > 0) {
    const shown = record.scope.symbols.slice(0, 2);
    const suffix = record.scope.symbols.length > 2 ? "..." : "";
    parts.push(`symbols: [${shown.join(", ")}${suffix}]`);
  }
  if (record.scope.tags.length > 0) {
    parts.push(`tags: [${record.scope.tags.join(", ")}]`);
  }

  return parts.length > 0 ? parts.join("; ") : "global";
}

function canonicalDocRefs(records: NormalizedRecord[]): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const refs: Array<Record<string, unknown>> = [];

  for (const record of records) {
    for (const evidence of record.evidence) {
      if (evidence.kind !== "docs" || !evidence.repo || !evidence.file || !evidence.commit) {
        continue;
      }

      const key = JSON.stringify({
        repo: evidence.repo,
        path: evidence.file,
        commit: evidence.commit,
        lines: evidence.lines ?? null,
        doc_role: evidence.doc_role ?? null
      });

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);

      const ref: Record<string, unknown> = {
        repo: evidence.repo,
        path: evidence.file,
        commit: evidence.commit,
        item_id: record.id,
        reason: "scope_match"
      };

      if (evidence.doc_role !== undefined) {
        ref.doc_role = evidence.doc_role;
      }
      if (evidence.lines !== undefined) {
        ref.lines = evidence.lines;
      }
      if (evidence.url !== undefined) {
        ref.url = evidence.url;
      }

      refs.push(ref);
    }
  }

  return refs;
}
