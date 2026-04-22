import { relative } from "node:path";
import type { GetContextInput } from "../../schemas/context-payload.js";
import type { NormalizedRecord } from "../../schemas/normalized-record.js";
import { isRecord, isStringArray } from "../../schemas/validation.js";

export type PathIndex = {
  schema_version: 1;
  generated_at: string | null;
  paths: Record<string, string[]>;
  domains: Record<string, string[]>;
  tags: Record<string, string[]>;
  kinds: Record<string, string[]>;
  states: Record<string, string[]>;
};

export type SymbolIndex = {
  schema_version: 1;
  generated_at: string | null;
  symbols: Record<string, string[]>;
};

export type RecordIndexSet = {
  pathIndex?: PathIndex;
  symbolIndex?: SymbolIndex;
};

export function createEmptyPathIndex(generatedAt: string | null = null): PathIndex {
  return {
    schema_version: 1,
    generated_at: generatedAt,
    paths: {},
    domains: {},
    tags: {},
    kinds: {},
    states: {}
  };
}

export function createEmptySymbolIndex(generatedAt: string | null = null): SymbolIndex {
  return {
    schema_version: 1,
    generated_at: generatedAt,
    symbols: {}
  };
}

export function buildRecordIndexes(
  records: NormalizedRecord[],
  generatedAt: string | null
): { pathIndex: PathIndex; symbolIndex: SymbolIndex } {
  const pathIndex = createEmptyPathIndex(generatedAt);
  const symbolIndex = createEmptySymbolIndex(generatedAt);

  for (const record of records) {
    for (const path of record.scope.paths) {
      addIndexedId(pathIndex.paths, normalizePath(path), record.id);
    }
    for (const domain of record.scope.domains) {
      addIndexedId(pathIndex.domains, normalizeTextKey(domain), record.id);
    }
    for (const tag of record.scope.tags) {
      addIndexedId(pathIndex.tags, normalizeTextKey(tag), record.id);
    }
    for (const symbol of record.scope.symbols) {
      addIndexedId(symbolIndex.symbols, normalizeSymbolKey(symbol), record.id);
    }

    addIndexedId(pathIndex.kinds, record.kind, record.id);
    addIndexedId(pathIndex.states, record.state, record.id);
  }

  return {
    pathIndex: sortPathIndex(pathIndex),
    symbolIndex: sortSymbolIndex(symbolIndex)
  };
}

export function serializePathIndex(index: PathIndex): string {
  return `${JSON.stringify(index, null, 2)}\n`;
}

export function serializeSymbolIndex(index: SymbolIndex): string {
  return `${JSON.stringify(index, null, 2)}\n`;
}

export function validatePathIndex(value: unknown): PathIndex {
  if (!isRecord(value)) {
    throw new Error("path index must be an object");
  }

  if (value.schema_version !== 1) {
    throw new Error("path index schema_version must be 1");
  }

  return sortPathIndex({
    schema_version: 1,
    generated_at: validateGeneratedAt(value.generated_at, "path index"),
    paths: validateIdMap(value.paths, "path index paths"),
    domains: validateIdMap(value.domains, "path index domains"),
    tags: validateIdMap(value.tags, "path index tags"),
    kinds: validateIdMap(value.kinds, "path index kinds"),
    states: validateIdMap(value.states, "path index states")
  });
}

export function validateSymbolIndex(value: unknown): SymbolIndex {
  if (!isRecord(value)) {
    throw new Error("symbol index must be an object");
  }

  if (value.schema_version !== 1) {
    throw new Error("symbol index schema_version must be 1");
  }

  return sortSymbolIndex({
    schema_version: 1,
    generated_at: validateGeneratedAt(value.generated_at, "symbol index"),
    symbols: validateIdMap(value.symbols, "symbol index symbols")
  });
}

export function hasLookupSelectors(input: GetContextInput): boolean {
  return (
    selectedFiles(input).length > 0 ||
    (input.domains ?? []).length > 0 ||
    (input.symbols ?? []).length > 0 ||
    (input.tags ?? []).length > 0
  );
}

export function selectIndexedRecordIds(
  indexes: RecordIndexSet,
  input: GetContextInput
): Set<string> {
  const selected = new Set<string>();

  for (const file of selectedFiles(input)) {
    for (const [pattern, ids] of Object.entries(indexes.pathIndex?.paths ?? {})) {
      if (matchesPath(pattern, file)) {
        addAll(selected, ids);
      }
    }
  }

  for (const domain of input.domains ?? []) {
    addAll(selected, indexes.pathIndex?.domains[normalizeTextKey(domain)] ?? []);
  }

  for (const symbol of input.symbols ?? []) {
    addAll(selected, indexes.symbolIndex?.symbols[normalizeSymbolKey(symbol)] ?? []);
  }

  for (const tag of input.tags ?? []) {
    addAll(selected, indexes.pathIndex?.tags[normalizeTextKey(tag)] ?? []);
  }

  return selected;
}

export function matchesScopeInput(record: NormalizedRecord, input: GetContextInput): boolean {
  const files = selectedFiles(input);

  return (
    record.scope.paths.some((pattern) => files.some((file) => matchesPath(pattern, file))) ||
    hasOverlap(record.scope.domains, input.domains ?? [], normalizeTextKey) ||
    hasOverlap(record.scope.symbols, input.symbols ?? [], normalizeSymbolKey) ||
    hasOverlap(record.scope.tags, input.tags ?? [], normalizeTextKey)
  );
}

export function matchesPath(pattern: string, file: string): boolean {
  const normalizedPattern = normalizePath(pattern);
  const normalizedFile = normalizePath(file);

  if (normalizedPattern.length === 0 || normalizedFile.length === 0) {
    return false;
  }

  if (normalizedPattern.endsWith("/**")) {
    const prefix = normalizedPattern.slice(0, -"/**".length);

    return normalizedFile === prefix || normalizedFile.startsWith(`${prefix}/`);
  }

  if (normalizedPattern.includes("*")) {
    const regex = new RegExp(`^${globToRegex(normalizedPattern)}$`);

    return regex.test(normalizedFile);
  }

  return normalizedFile === normalizedPattern || relative(normalizedPattern, normalizedFile) === "";
}

function selectedFiles(input: GetContextInput): string[] {
  return [...(input.target_files ?? []), ...(input.changed_files ?? [])];
}

function addIndexedId<T extends string>(index: Record<T, string[]>, rawKey: T, id: string): void {
  const key = rawKey.trim() as T;

  if (key.length === 0) {
    return;
  }

  const ids = index[key] ?? [];
  ids.push(id);
  index[key] = ids;
}

function addAll(target: Set<string>, ids: string[]): void {
  for (const id of ids) {
    target.add(id);
  }
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

function validateGeneratedAt(value: unknown, name: string): string | null {
  if (value === null) {
    return null;
  }

  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  throw new Error(`${name} generated_at must be a string or null`);
}

function validateIdMap(value: unknown, name: string): Record<string, string[]> {
  if (!isRecord(value)) {
    throw new Error(`${name} must be an object`);
  }

  const output: Record<string, string[]> = {};

  for (const [key, ids] of Object.entries(value)) {
    if (key.length === 0 || !isStringArray(ids)) {
      throw new Error(`${name} must map non-empty keys to string arrays`);
    }

    output[key] = uniqueSorted(ids.filter((id) => id.length > 0));
  }

  return sortRecord(output);
}

function sortPathIndex(index: PathIndex): PathIndex {
  return {
    schema_version: 1,
    generated_at: index.generated_at,
    paths: sortRecordIds(index.paths),
    domains: sortRecordIds(index.domains),
    tags: sortRecordIds(index.tags),
    kinds: sortRecordIds(index.kinds),
    states: sortRecordIds(index.states)
  };
}

function sortSymbolIndex(index: SymbolIndex): SymbolIndex {
  return {
    schema_version: 1,
    generated_at: index.generated_at,
    symbols: sortRecordIds(index.symbols)
  };
}

function sortRecordIds<T extends string>(record: Record<T, string[]>): Record<T, string[]> {
  const output: Record<string, string[]> = {};

  for (const key of Object.keys(record) as T[]) {
    output[key] = uniqueSorted(record[key] ?? []);
  }

  return sortRecord(output) as Record<T, string[]>;
}

function sortRecord(record: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right))
  );
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

function normalizeTextKey(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeSymbolKey(value: string): string {
  return value.trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

function globToRegex(pattern: string): string {
  let output = "";

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];

    if (char === "*" && next === "*") {
      output += ".*";
      index += 1;
    } else if (char === "*") {
      output += "[^/]*";
    } else if (char) {
      output += escapeRegex(char);
    }
  }

  return output;
}
