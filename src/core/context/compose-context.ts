import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ContextStoreAdapter } from "../../adapters/store/context-store.js";
import {
  budgetRecords,
  DEFAULT_CONTEXT_BUDGETS,
  rankedTexts,
  scopedContextItem,
  type RankedRecord
} from "./context-ranking.js";
import { NORMALIZED_RECORD_FILES } from "../store/layout.js";
import {
  hasLookupSelectors,
  matchesScopeInput,
  selectIndexedRecordIds,
  validatePathIndex,
  validateSymbolIndex,
  type RecordIndexSet
} from "../indexes/record-index.js";
import {
  validateNormalizedRecord,
  type NormalizedRecord
} from "../../schemas/normalized-record.js";
import type { GetContextInput, EnabledContextPayload } from "../../schemas/context-payload.js";

export type ComposedContext = Pick<
  EnabledContextPayload,
  "normalized_context" | "canonical_doc_refs" | "diagnostics"
>;

export function composeContextFromStore(
  storeRoot: string,
  input: GetContextInput = {}
): ComposedContext {
  const records = readNormalizedRecords(storeRoot);
  const indexes = readRecordIndexes(storeRoot);

  return composeContextFromRecords(records, input, indexes);
}

export async function composeContextFromContextStore(
  store: ContextStoreAdapter,
  input: GetContextInput = {}
): Promise<ComposedContext> {
  const records = await readNormalizedRecordsFromContextStore(store);
  const indexes = await readRecordIndexesFromContextStore(store);

  return composeContextFromRecords(records, input, indexes);
}

function composeContextFromRecords(
  records: NormalizedRecord[],
  input: GetContextInput,
  indexes: RecordIndexSet = {}
): ComposedContext {
  const activeRecords = records.filter((record) => record.state === "active");
  const scopedBudget = budgetRecords(
    selectScopedRecords(activeRecords, input, indexes),
    input,
    DEFAULT_CONTEXT_BUDGETS.scopedItems
  );
  const globalBudget = budgetRecords(
    activeRecords.filter((record) => isGlobalKind(record.kind)),
    input,
    DEFAULT_CONTEXT_BUDGETS.globalItems
  );
  const ruleBudget = budgetRecords(
    activeRecords.filter((record) => record.kind === "rule"),
    input,
    DEFAULT_CONTEXT_BUDGETS.globalItems
  );
  const decisionBudget = budgetRecords(
    activeRecords.filter((record) => record.kind === "decision"),
    input,
    DEFAULT_CONTEXT_BUDGETS.decisions
  );
  const pitfallBudget = budgetRecords(
    activeRecords.filter((record) => record.kind === "pitfall"),
    input,
    DEFAULT_CONTEXT_BUDGETS.pitfalls
  );
  const workflowBudget = budgetRecords(
    activeRecords.filter((record) => record.kind === "workflow"),
    input,
    DEFAULT_CONTEXT_BUDGETS.workflows
  );
  const glossaryBudget = budgetRecords(
    activeRecords.filter((record) => record.kind === "glossary"),
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
    canonical_doc_refs: canonicalDocRefs(scopedBudget.selected.map((ranked) => ranked.record)),
    diagnostics: {
      contested_items: records
        .filter((record) => record.state === "contested")
        .map((record) => record.id),
      stale_items: records.filter((record) => record.state === "stale").map((record) => record.id),
      dropped_items: budgetDroppedIds([scopedBudget]),
      excluded_items: excludedItems(records)
    }
  };
}

function selectScopedRecords(
  activeRecords: NormalizedRecord[],
  input: GetContextInput,
  indexes: RecordIndexSet
): NormalizedRecord[] {
  if (hasLookupSelectors(input) && hasGeneratedIndex(indexes)) {
    const selectedIds = selectIndexedRecordIds(indexes, input);

    return activeRecords.filter((record) => selectedIds.has(record.id));
  }

  return activeRecords.filter((record) => matchesScopeInput(record, input));
}

function hasGeneratedIndex(indexes: RecordIndexSet): boolean {
  return (
    typeof indexes.pathIndex?.generated_at === "string" ||
    typeof indexes.symbolIndex?.generated_at === "string"
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
    diagnostics: {
      contested_items: [],
      stale_items: [],
      dropped_items: [],
      excluded_items: []
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
  store: ContextStoreAdapter
): Promise<NormalizedRecord[]> {
  const records: NormalizedRecord[] = [];

  for (const file of NORMALIZED_RECORD_FILES) {
    const storeFile = await store.readText(`normalized/${file}`);

    for (const line of jsonlLines(storeFile?.content ?? "")) {
      records.push(validateNormalizedRecord(JSON.parse(line) as unknown));
    }
  }

  return records.sort((left, right) => left.id.localeCompare(right.id));
}

function readRecordIndexes(storeRoot: string): RecordIndexSet {
  return {
    ...readPathIndex(storeRoot),
    ...readSymbolIndex(storeRoot)
  };
}

async function readRecordIndexesFromContextStore(
  store: ContextStoreAdapter
): Promise<RecordIndexSet> {
  return {
    ...(await readPathIndexFromContextStore(store)),
    ...(await readSymbolIndexFromContextStore(store))
  };
}

function readPathIndex(storeRoot: string): RecordIndexSet {
  try {
    return {
      pathIndex: validatePathIndex(
        JSON.parse(readFileSync(join(storeRoot, "indexes", "path-index.json"), "utf8")) as unknown
      )
    };
  } catch {
    return {};
  }
}

function readSymbolIndex(storeRoot: string): RecordIndexSet {
  try {
    return {
      symbolIndex: validateSymbolIndex(
        JSON.parse(readFileSync(join(storeRoot, "indexes", "symbol-index.json"), "utf8")) as unknown
      )
    };
  } catch {
    return {};
  }
}

async function readPathIndexFromContextStore(store: ContextStoreAdapter): Promise<RecordIndexSet> {
  try {
    const file = await store.readText("indexes/path-index.json");

    if (!file) {
      return {};
    }

    return {
      pathIndex: validatePathIndex(JSON.parse(file.content) as unknown)
    };
  } catch {
    return {};
  }
}

async function readSymbolIndexFromContextStore(
  store: ContextStoreAdapter
): Promise<RecordIndexSet> {
  try {
    const file = await store.readText("indexes/symbol-index.json");

    if (!file) {
      return {};
    }

    return {
      symbolIndex: validateSymbolIndex(JSON.parse(file.content) as unknown)
    };
  } catch {
    return {};
  }
}

function readJsonlLines(path: string): string[] {
  try {
    return jsonlLines(readFileSync(path, "utf8"));
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

function globalContext(ranked: RankedRecord[]): string {
  return rankedTexts(ranked, DEFAULT_CONTEXT_BUDGETS.contentChars).join("\n");
}

function isGlobalKind(kind: NormalizedRecord["kind"]): boolean {
  return kind === "fact" || kind === "rule" || kind === "glossary";
}

function budgetDroppedIds(budgets: Array<{ overflow: RankedRecord[] }>): string[] {
  return [
    ...new Set(
      budgets.flatMap((budget) => budget.overflow.map((ranked) => `budget:${ranked.record.id}`))
    )
  ].sort((left, right) => left.localeCompare(right));
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
