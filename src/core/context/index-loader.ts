import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ContextStoreAdapter } from "../../adapters/store/context-store.js";
import {
  validatePathIndex,
  validateSymbolIndex,
  validateTextIndex,
  type RecordIndexSet
} from "../indexes/record-index.js";
import { validateEpisodeIndex, type EpisodeIndex } from "../indexes/episode-index.js";

export type RecordIndexReadResult = {
  indexes: RecordIndexSet;
  warnings: string[];
};

export function readRecordIndexes(
  storeRoot: string,
  lastNormalizeAt: string | undefined
): RecordIndexReadResult {
  const pathIndex = readPathIndex(storeRoot, lastNormalizeAt);
  const symbolIndex = readSymbolIndex(storeRoot, lastNormalizeAt);
  const textIndex = readTextIndex(storeRoot, lastNormalizeAt);

  return {
    indexes: {
      ...pathIndex.indexes,
      ...symbolIndex.indexes,
      ...textIndex.indexes
    },
    warnings: [...pathIndex.warnings, ...symbolIndex.warnings, ...textIndex.warnings]
  };
}

export async function readRecordIndexesFromContextStore(
  store: ContextStoreAdapter,
  lastNormalizeAt: string | undefined
): Promise<RecordIndexReadResult> {
  const pathIndex = await readPathIndexFromContextStore(store, lastNormalizeAt);
  const symbolIndex = await readSymbolIndexFromContextStore(store, lastNormalizeAt);
  const textIndex = await readTextIndexFromContextStore(store, lastNormalizeAt);

  return {
    indexes: {
      ...pathIndex.indexes,
      ...symbolIndex.indexes,
      ...textIndex.indexes
    },
    warnings: [...pathIndex.warnings, ...symbolIndex.warnings, ...textIndex.warnings]
  };
}

export function readEpisodeIndex(
  storeRoot: string,
  lastNormalizeAt: string | undefined
): { index?: EpisodeIndex; warnings: string[] } {
  const path = join(storeRoot, "indexes", "episode-index.json");

  if (!existsSync(path)) {
    return { warnings: ["missing episode index"] };
  }

  try {
    const index = validateEpisodeIndex(JSON.parse(readFileSync(path, "utf8")) as unknown);

    return {
      index,
      warnings: indexFreshnessWarnings("episode", index.generated_at, lastNormalizeAt)
    };
  } catch (error) {
    return { warnings: [`invalid episode index: ${errorMessage(error)}`] };
  }
}

export async function readEpisodeIndexFromContextStore(
  store: ContextStoreAdapter,
  lastNormalizeAt: string | undefined
): Promise<{ index?: EpisodeIndex; warnings: string[] }> {
  try {
    const file = await store.readText("indexes/episode-index.json");

    if (!file) {
      return { warnings: ["missing episode index"] };
    }

    const index = validateEpisodeIndex(JSON.parse(file.content) as unknown);

    return {
      index,
      warnings: indexFreshnessWarnings("episode", index.generated_at, lastNormalizeAt)
    };
  } catch (error) {
    return { warnings: [`invalid episode index: ${errorMessage(error)}`] };
  }
}

export function readLastNormalizeAt(storeRoot: string): string | undefined {
  try {
    const value = JSON.parse(
      readFileSync(join(storeRoot, "indexes", "last-normalize.json"), "utf8")
    ) as unknown;

    return typeof value === "object" &&
      value !== null &&
      "normalizedAt" in value &&
      typeof value.normalizedAt === "string"
      ? value.normalizedAt
      : undefined;
  } catch {
    return undefined;
  }
}

export async function readLastNormalizeAtFromContextStore(
  store: ContextStoreAdapter
): Promise<string | undefined> {
  try {
    const file = await store.readText("indexes/last-normalize.json");
    const value = file ? (JSON.parse(file.content) as unknown) : undefined;

    return typeof value === "object" &&
      value !== null &&
      "normalizedAt" in value &&
      typeof value.normalizedAt === "string"
      ? value.normalizedAt
      : undefined;
  } catch {
    return undefined;
  }
}

function readPathIndex(
  storeRoot: string,
  lastNormalizeAt: string | undefined
): RecordIndexReadResult {
  const path = join(storeRoot, "indexes", "path-index.json");

  if (!existsSync(path)) {
    return { indexes: {}, warnings: ["missing path index"] };
  }

  try {
    const pathIndex = validatePathIndex(JSON.parse(readFileSync(path, "utf8")) as unknown);

    return {
      indexes: { pathIndex },
      warnings: indexFreshnessWarnings("path", pathIndex.generated_at, lastNormalizeAt)
    };
  } catch (error) {
    return { indexes: {}, warnings: [`invalid path index: ${errorMessage(error)}`] };
  }
}

function readSymbolIndex(
  storeRoot: string,
  lastNormalizeAt: string | undefined
): RecordIndexReadResult {
  const path = join(storeRoot, "indexes", "symbol-index.json");

  if (!existsSync(path)) {
    return { indexes: {}, warnings: ["missing symbol index"] };
  }

  try {
    const symbolIndex = validateSymbolIndex(JSON.parse(readFileSync(path, "utf8")) as unknown);

    return {
      indexes: { symbolIndex },
      warnings: indexFreshnessWarnings("symbol", symbolIndex.generated_at, lastNormalizeAt)
    };
  } catch (error) {
    return { indexes: {}, warnings: [`invalid symbol index: ${errorMessage(error)}`] };
  }
}

function readTextIndex(
  storeRoot: string,
  lastNormalizeAt: string | undefined
): RecordIndexReadResult {
  const path = join(storeRoot, "indexes", "text-index.json");

  if (!existsSync(path)) {
    return { indexes: {}, warnings: ["missing text index"] };
  }

  try {
    const textIndex = validateTextIndex(JSON.parse(readFileSync(path, "utf8")) as unknown);

    return {
      indexes: { textIndex },
      warnings: indexFreshnessWarnings("text", textIndex.generated_at, lastNormalizeAt)
    };
  } catch (error) {
    return { indexes: {}, warnings: [`invalid text index: ${errorMessage(error)}`] };
  }
}

async function readPathIndexFromContextStore(
  store: ContextStoreAdapter,
  lastNormalizeAt: string | undefined
): Promise<RecordIndexReadResult> {
  try {
    const file = await store.readText("indexes/path-index.json");

    if (!file) {
      return { indexes: {}, warnings: ["missing path index"] };
    }

    const pathIndex = validatePathIndex(JSON.parse(file.content) as unknown);

    return {
      indexes: { pathIndex },
      warnings: indexFreshnessWarnings("path", pathIndex.generated_at, lastNormalizeAt)
    };
  } catch (error) {
    return { indexes: {}, warnings: [`invalid path index: ${errorMessage(error)}`] };
  }
}

async function readSymbolIndexFromContextStore(
  store: ContextStoreAdapter,
  lastNormalizeAt: string | undefined
): Promise<RecordIndexReadResult> {
  try {
    const file = await store.readText("indexes/symbol-index.json");

    if (!file) {
      return { indexes: {}, warnings: ["missing symbol index"] };
    }

    const symbolIndex = validateSymbolIndex(JSON.parse(file.content) as unknown);

    return {
      indexes: { symbolIndex },
      warnings: indexFreshnessWarnings("symbol", symbolIndex.generated_at, lastNormalizeAt)
    };
  } catch (error) {
    return { indexes: {}, warnings: [`invalid symbol index: ${errorMessage(error)}`] };
  }
}

async function readTextIndexFromContextStore(
  store: ContextStoreAdapter,
  lastNormalizeAt: string | undefined
): Promise<RecordIndexReadResult> {
  try {
    const file = await store.readText("indexes/text-index.json");

    if (!file) {
      return { indexes: {}, warnings: ["missing text index"] };
    }

    const textIndex = validateTextIndex(JSON.parse(file.content) as unknown);

    return {
      indexes: { textIndex },
      warnings: indexFreshnessWarnings("text", textIndex.generated_at, lastNormalizeAt)
    };
  } catch (error) {
    return { indexes: {}, warnings: [`invalid text index: ${errorMessage(error)}`] };
  }
}

function indexFreshnessWarnings(
  indexName: string,
  generatedAt: string | null,
  lastNormalizeAt: string | undefined
): string[] {
  if (generatedAt === null) {
    return [`${indexName} index is uninitialized`];
  }

  if (lastNormalizeAt !== undefined && generatedAt !== lastNormalizeAt) {
    return [
      `${indexName} index generated_at ${generatedAt} differs from last normalize ${lastNormalizeAt}`
    ];
  }

  return [];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
