import type { GetContextInput } from "../../schemas/context-payload.js";
import type { KnowledgeKind, NormalizedRecord } from "../../schemas/normalized-record.js";
import { matchesPath } from "../indexes/record-index.js";

export type ContextBudgets = {
  scopedItems: number;
  globalItems: number;
  decisions: number;
  pitfalls: number;
  workflows: number;
  glossary: number;
  contentChars: number;
};

export type RankedRecord = {
  record: NormalizedRecord;
  score: number;
  reasons: string[];
  recency: number;
};

export type BudgetedRecords = {
  selected: RankedRecord[];
  overflow: RankedRecord[];
};

export type ScopedContextItem = {
  id: string;
  kind: KnowledgeKind;
  scope: NormalizedRecord["scope"];
  content: string;
  reason: string;
  rank_score: number;
  rank_reasons: string[];
  confidence_level: NormalizedRecord["confidence_level"];
  confidence_score?: number;
  last_verified_at?: string;
};

export const DEFAULT_CONTEXT_BUDGETS: ContextBudgets = {
  scopedItems: 20,
  globalItems: 20,
  decisions: 10,
  pitfalls: 10,
  workflows: 10,
  glossary: 10,
  contentChars: 1200
};

const KIND_WEIGHT: Record<KnowledgeKind, number> = {
  rule: 40,
  pitfall: 35,
  decision: 30,
  workflow: 25,
  fact: 20,
  glossary: 15
};

const CONFIDENCE_WEIGHT: Record<NormalizedRecord["confidence_level"], number> = {
  high: 12,
  medium: 8,
  low: 4
};

export function rankRecords(records: NormalizedRecord[], input: GetContextInput): RankedRecord[] {
  return records.map((record) => rankRecord(record, input)).sort(compareRankedRecords);
}

export function budgetRecords(
  records: NormalizedRecord[],
  input: GetContextInput,
  limit: number
): BudgetedRecords {
  const ranked = rankRecords(records, input);

  return {
    selected: ranked.slice(0, limit),
    overflow: ranked.slice(limit)
  };
}

export function scopedContextItem(
  ranked: RankedRecord,
  maxContentChars: number
): ScopedContextItem {
  const item: ScopedContextItem = {
    id: ranked.record.id,
    kind: ranked.record.kind,
    scope: ranked.record.scope,
    content: truncateText(ranked.record.text, maxContentChars),
    reason: selectionReason(ranked),
    rank_score: ranked.score,
    rank_reasons: ranked.reasons,
    confidence_level: ranked.record.confidence_level
  };

  if (ranked.record.confidence_score !== undefined) {
    item.confidence_score = ranked.record.confidence_score;
  }
  if (ranked.record.last_verified_at !== undefined) {
    item.last_verified_at = ranked.record.last_verified_at;
  }

  return item;
}

export function rankedTexts(ranked: RankedRecord[], maxContentChars: number): string[] {
  return ranked.map((item) => truncateText(item.record.text, maxContentChars));
}

function rankRecord(record: NormalizedRecord, input: GetContextInput): RankedRecord {
  const reasons: string[] = [];
  let score = KIND_WEIGHT[record.kind] + CONFIDENCE_WEIGHT[record.confidence_level];
  const targetFileMatches = matchingPathFiles(record, input.target_files ?? []);
  const changedFileMatches = matchingPathFiles(record, input.changed_files ?? []);
  const symbolMatches = matchingOverlapValues(record.scope.symbols, input.symbols ?? [], exactKey);
  const domainMatches = matchingOverlapValues(record.scope.domains, input.domains ?? [], textKey);
  const tagMatches = matchingOverlapValues(record.scope.tags, input.tags ?? [], textKey);
  const queryMatches = matchingQueryTokens(record, input.query);

  if (targetFileMatches.length > 0) {
    score += 80;
    reasons.push(formatMatchReason("target file match", targetFileMatches));
  }
  if (changedFileMatches.length > 0) {
    score += 60;
    reasons.push(formatMatchReason("changed file match", changedFileMatches));
  }
  if (symbolMatches.length > 0) {
    score += 70;
    reasons.push(formatMatchReason("symbol match", symbolMatches));
  }
  if (domainMatches.length > 0) {
    score += 45;
    reasons.push(formatMatchReason("domain match", domainMatches));
  }
  if (tagMatches.length > 0) {
    score += 25;
    reasons.push(formatMatchReason("tag match", tagMatches));
  }
  if (queryMatches.length > 0) {
    score += 50;
    reasons.push(formatMatchReason("text query match", queryMatches));
  }

  reasons.push(`${record.kind} context`);
  reasons.push(`${record.confidence_level} confidence`);

  return {
    record,
    score,
    reasons,
    recency: recency(record)
  };
}

function compareRankedRecords(left: RankedRecord, right: RankedRecord): number {
  return (
    right.score - left.score ||
    right.recency - left.recency ||
    left.record.kind.localeCompare(right.record.kind) ||
    left.record.id.localeCompare(right.record.id)
  );
}

function selectionReason(ranked: RankedRecord): string {
  return ranked.reasons.slice(0, 3).join("; ");
}

function matchingPathFiles(record: NormalizedRecord, files: string[]): string[] {
  if (files.length === 0 || record.scope.paths.length === 0) {
    return [];
  }

  return uniqueSorted(
    files.filter((file) => record.scope.paths.some((pattern) => matchesPath(pattern, file)))
  );
}

function matchingOverlapValues(
  left: string[],
  right: string[],
  normalize: (value: string) => string
): string[] {
  if (left.length === 0 || right.length === 0) {
    return [];
  }

  const leftKeys = new Set(left.map(normalize));

  return uniqueSorted(right.filter((value) => leftKeys.has(normalize(value))));
}

function recency(record: NormalizedRecord): number {
  const timestamp = Date.parse(record.last_verified_at ?? record.provenance.observed_at);

  return Number.isFinite(timestamp) ? timestamp : 0;
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function textKey(value: string): string {
  return value.trim().toLowerCase();
}

function exactKey(value: string): string {
  return value.trim();
}

function matchingQueryTokens(record: NormalizedRecord, query: string | undefined): string[] {
  const tokens = textTokens(query ?? "");

  if (tokens.length === 0) {
    return [];
  }

  const recordTokens = new Set(
    textTokens(
      [
        record.text,
        record.kind,
        ...record.scope.domains,
        ...record.scope.symbols,
        ...record.scope.tags
      ].join(" ")
    )
  );

  return tokens.every((token) => recordTokens.has(token)) ? tokens : [];
}

function formatMatchReason(label: string, matches: string[]): string {
  const visibleMatches = matches.slice(0, 3);
  const suffix = matches.length > visibleMatches.length ? ` (+${matches.length - 3} more)` : "";

  return `${label}: ${visibleMatches.join(", ")}${suffix}`;
}

function textTokens(value: string): string[] {
  return [
    ...new Set(
      value
        .toLowerCase()
        .split(/[^a-z0-9_]+/g)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2)
        .filter((token) => !TEXT_STOP_WORDS.has(token))
    )
  ].sort((left, right) => left.localeCompare(right));
}

const TEXT_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "to",
  "with"
]);

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))].sort(
    (left, right) => left.localeCompare(right)
  );
}
