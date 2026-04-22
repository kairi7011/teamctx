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

  if (matchesAnyPath(record, input.target_files ?? [])) {
    score += 80;
    reasons.push("target file match");
  }
  if (matchesAnyPath(record, input.changed_files ?? [])) {
    score += 60;
    reasons.push("changed file match");
  }
  if (hasOverlap(record.scope.symbols, input.symbols ?? [], exactKey)) {
    score += 70;
    reasons.push("symbol match");
  }
  if (hasOverlap(record.scope.domains, input.domains ?? [], textKey)) {
    score += 45;
    reasons.push("domain match");
  }
  if (hasOverlap(record.scope.tags, input.tags ?? [], textKey)) {
    score += 25;
    reasons.push("tag match");
  }
  if (matchesQuery(record, input.query)) {
    score += 50;
    reasons.push("text query match");
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

function matchesAnyPath(record: NormalizedRecord, files: string[]): boolean {
  if (files.length === 0 || record.scope.paths.length === 0) {
    return false;
  }

  return record.scope.paths.some((pattern) => files.some((file) => matchesPath(pattern, file)));
}

function hasOverlap(
  left: string[],
  right: string[],
  normalize: (value: string) => string
): boolean {
  if (left.length === 0 || right.length === 0) {
    return false;
  }

  const rightKeys = new Set(right.map(normalize));

  return left.some((value) => rightKeys.has(normalize(value)));
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

function matchesQuery(record: NormalizedRecord, query: string | undefined): boolean {
  const tokens = textTokens(query ?? "");

  if (tokens.length === 0) {
    return false;
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

  return tokens.every((token) => recordTokens.has(token));
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
