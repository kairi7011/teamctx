import { matchesPath } from "../../core/indexes/record-index.js";
import type { NormalizedRecord, Scope } from "../../schemas/normalized-record.js";

export function dedupeKey(record: NormalizedRecord): string {
  return JSON.stringify({
    kind: record.kind,
    text: canonicalText(record.text),
    scope: scopeKey(record.scope)
  });
}

export function findDuplicateRecordKey(
  recordsByKey: Map<string, NormalizedRecord>,
  record: NormalizedRecord
): string | undefined {
  const exactKey = dedupeKey(record);

  if (recordsByKey.has(exactKey)) {
    return exactKey;
  }

  for (const [key, existing] of recordsByKey) {
    if (areDuplicateRecords(existing, record)) {
      return key;
    }
  }

  return undefined;
}

export function areDuplicateRecords(left: NormalizedRecord, right: NormalizedRecord): boolean {
  if (left.kind !== right.kind || scopeKey(left.scope) !== scopeKey(right.scope)) {
    return false;
  }

  const leftText = canonicalText(left.text);
  const rightText = canonicalText(right.text);

  if (leftText === rightText) {
    return true;
  }

  if (
    hasNegation(leftText) !== hasNegation(rightText) ||
    hasOrderingConflict(leftText, rightText)
  ) {
    return false;
  }

  return tokenSimilarity(significantTokens(leftText), significantTokens(rightText)) >= 0.9;
}

export function areConflictingRecords(left: NormalizedRecord, right: NormalizedRecord): boolean {
  if (left.kind !== right.kind || !scopesOverlap(left.scope, right.scope)) {
    return false;
  }

  const leftText = canonicalText(left.text);
  const rightText = canonicalText(right.text);

  if (hasOrderingConflict(leftText, rightText)) {
    return true;
  }

  return (
    stripNegation(leftText) === stripNegation(rightText) &&
    hasNegation(leftText) !== hasNegation(rightText)
  );
}

export function scopesOverlap(left: Scope, right: Scope): boolean {
  if (isGlobalScope(left) || isGlobalScope(right)) {
    return true;
  }

  return (
    pathScopesOverlap(left.paths, right.paths) ||
    normalizedOverlap(left.domains, right.domains, normalizeTextKey) ||
    normalizedOverlap(left.symbols, right.symbols, normalizeSymbolKey) ||
    normalizedOverlap(left.tags, right.tags, normalizeTextKey)
  );
}

export function emptyScope(): Scope {
  return {
    paths: [],
    domains: [],
    symbols: [],
    tags: []
  };
}

export function scopeKey(scope: Scope): string {
  return JSON.stringify({
    paths: [...scope.paths].sort(),
    domains: [...scope.domains].sort(),
    symbols: [...scope.symbols].sort(),
    tags: [...scope.tags].sort()
  });
}

export function canonicalText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function isGlobalScope(scope: Scope): boolean {
  return (
    scope.paths.length === 0 &&
    scope.domains.length === 0 &&
    scope.symbols.length === 0 &&
    scope.tags.length === 0
  );
}

function pathScopesOverlap(left: string[], right: string[]): boolean {
  return left.some((leftPath) =>
    right.some((rightPath) => matchesPath(leftPath, rightPath) || matchesPath(rightPath, leftPath))
  );
}

function normalizedOverlap(
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

function normalizeTextKey(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeSymbolKey(value: string): string {
  return value.trim();
}

function hasNegation(value: string): boolean {
  return value.split(" ").some((token) => NEGATION_TOKENS.has(token));
}

function stripNegation(value: string): string {
  return value
    .split(" ")
    .filter((token) => !NEGATION_TOKENS.has(token))
    .join(" ");
}

type OrderingAssertion = {
  before: string[];
  after: string[];
};

function hasOrderingConflict(leftText: string, rightText: string): boolean {
  const leftAssertions = extractOrderingAssertions(leftText);
  const rightAssertions = extractOrderingAssertions(rightText);

  return leftAssertions.some((left) =>
    rightAssertions.some(
      (right) =>
        sideSimilarity(left.before, right.after) >= 0.8 &&
        sideSimilarity(left.after, right.before) >= 0.8
    )
  );
}

function extractOrderingAssertions(value: string): OrderingAssertion[] {
  const tokens = value.split(" ").filter((token) => token.length > 0);
  const assertions: OrderingAssertion[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token === "before") {
      addOrderingAssertion(assertions, tokens.slice(0, index), tokens.slice(index + 1));
    } else if (token === "after") {
      addOrderingAssertion(assertions, tokens.slice(index + 1), tokens.slice(0, index));
    }
  }

  return assertions;
}

function addOrderingAssertion(
  assertions: OrderingAssertion[],
  beforeTokens: string[],
  afterTokens: string[]
): void {
  const before = orderingSideTokens(beforeTokens);
  const after = orderingSideTokens(afterTokens);

  if (before.length > 0 && after.length > 0) {
    assertions.push({ before, after });
  }
}

function orderingSideTokens(tokens: string[]): string[] {
  return tokens
    .filter((token) => !ORDERING_FILLER_TOKENS.has(token))
    .filter((token) => !NEGATION_TOKENS.has(token));
}

function significantTokens(value: string): string[] {
  return value
    .split(" ")
    .filter((token) => token.length > 0)
    .filter((token) => !DEDUPE_FILLER_TOKENS.has(token));
}

function sideSimilarity(left: string[], right: string[]): number {
  return tokenSimilarity(left, right);
}

function tokenSimilarity(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }

  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const intersection = [...leftSet].filter((token) => rightSet.has(token)).length;
  const union = new Set([...leftSet, ...rightSet]).size;

  return union === 0 ? 0 : intersection / union;
}

const NEGATION_TOKENS = new Set(["not", "never", "without", "disable", "disabled", "avoid"]);
const ORDERING_FILLER_TOKENS = new Set([
  "must",
  "should",
  "shall",
  "need",
  "needs",
  "to",
  "run",
  "runs",
  "execute",
  "executes",
  "happen",
  "happens",
  "be",
  "is",
  "are",
  "the",
  "a",
  "an"
]);
const DEDUPE_FILLER_TOKENS = new Set([...ORDERING_FILLER_TOKENS, "can", "could", "may", "might"]);
