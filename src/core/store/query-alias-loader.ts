import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ContextStoreAdapter } from "../../adapters/store/context-store.js";
import { parseQueryAliasConfig, type QueryAliasConfig } from "../../schemas/query-alias.js";
import type { QueryAlias } from "../indexes/query-tokens.js";

export const QUERY_ALIASES_FILE = "aliases/query-aliases.json";

export function readQueryAliases(storeRoot: string): QueryAlias[] {
  const path = join(storeRoot, QUERY_ALIASES_FILE);

  try {
    const content = readFileSync(path, "utf8");

    return queryAliasesFromConfig(parseQueryAliasConfigFile(content, path));
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }

    throw error;
  }
}

export async function readQueryAliasesFromContextStore(
  store: ContextStoreAdapter
): Promise<QueryAlias[]> {
  const file = await store.readText(QUERY_ALIASES_FILE);

  if (!file) {
    return [];
  }

  return queryAliasesFromConfig(parseQueryAliasConfigFile(file.content, QUERY_ALIASES_FILE));
}

export function queryAliasesFromConfig(config: QueryAliasConfig): QueryAlias[] {
  return config.aliases
    .filter((alias) => alias.enabled)
    .map((alias) => {
      const runtimeAlias: QueryAlias = {
        id: `project:${alias.id}`,
        tokenGroups: alias.expand.token_groups
      };

      if (alias.match.patterns !== undefined) {
        runtimeAlias.patterns = alias.match.patterns;
      }
      if (alias.match.all_pattern_groups !== undefined) {
        runtimeAlias.allPatternGroups = alias.match.all_pattern_groups;
      }

      return runtimeAlias;
    });
}

function parseQueryAliasConfigFile(content: string, path: string): QueryAliasConfig {
  try {
    return parseQueryAliasConfig(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    throw new Error(`Invalid teamctx query alias config ${path}: ${message}`);
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
