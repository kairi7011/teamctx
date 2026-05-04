import { isRecord, isStringArray } from "./validation.js";

export type QueryAliasMatchConfig = {
  patterns?: string[];
  all_pattern_groups?: string[][];
};

export type QueryAliasExpandConfig = {
  token_groups: string[][];
  domains?: string[];
  tags?: string[];
  symbols?: string[];
};

export type QueryAliasConfigEntry = {
  id: string;
  enabled: boolean;
  match: QueryAliasMatchConfig;
  expand: QueryAliasExpandConfig;
  rationale?: string;
  updated_at?: string;
};

export type QueryAliasConfig = {
  schema_version: 1;
  aliases: QueryAliasConfigEntry[];
};

const BROAD_SINGLE_PATTERNS = new Set(["github", "git", "cli", "context"]);

export function createEmptyQueryAliasConfig(): QueryAliasConfig {
  return {
    schema_version: 1,
    aliases: []
  };
}

export function serializeQueryAliasConfig(config: QueryAliasConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

export function parseQueryAliasConfig(content: string): QueryAliasConfig {
  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    throw new Error(`query alias config must be valid JSON: ${message}`);
  }

  return validateQueryAliasConfig(parsed);
}

export function validateQueryAliasConfig(value: unknown): QueryAliasConfig {
  if (!isRecord(value)) {
    throw new Error("query alias config must be an object");
  }

  if (value.schema_version !== 1) {
    throw new Error("query alias config schema_version must be 1");
  }

  if (!Array.isArray(value.aliases)) {
    throw new Error("query alias config aliases must be an array");
  }

  return {
    schema_version: 1,
    aliases: value.aliases.map(validateQueryAliasConfigEntry)
  };
}

function validateQueryAliasConfigEntry(value: unknown, index: number): QueryAliasConfigEntry {
  if (!isRecord(value)) {
    throw new Error(`query alias ${index} must be an object`);
  }

  if (typeof value.id !== "string" || value.id.trim().length === 0) {
    throw new Error(`query alias ${index} id must be a non-empty string`);
  }

  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    throw new Error(`query alias ${value.id} enabled must be a boolean`);
  }

  const alias: QueryAliasConfigEntry = {
    id: value.id.trim(),
    enabled: value.enabled !== false,
    match: validateMatch(value.match, value.id),
    expand: validateExpand(value.expand, value.id)
  };

  if (value.rationale !== undefined) {
    if (typeof value.rationale !== "string") {
      throw new Error(`query alias ${alias.id} rationale must be a string`);
    }
    alias.rationale = value.rationale;
  }

  if (value.updated_at !== undefined) {
    if (typeof value.updated_at !== "string" || value.updated_at.length === 0) {
      throw new Error(`query alias ${alias.id} updated_at must be a non-empty string`);
    }
    alias.updated_at = value.updated_at;
  }

  rejectOverbroadAlias(alias);

  return alias;
}

function validateMatch(value: unknown, aliasId: unknown): QueryAliasMatchConfig {
  if (!isRecord(value)) {
    throw new Error(`query alias ${aliasId} match must be an object`);
  }

  const match: QueryAliasMatchConfig = {};

  if (value.patterns !== undefined) {
    match.patterns = nonEmptyStringArray(value.patterns, `query alias ${aliasId} match.patterns`);
  }

  if (value.all_pattern_groups !== undefined) {
    if (!Array.isArray(value.all_pattern_groups)) {
      throw new Error(`query alias ${aliasId} match.all_pattern_groups must be an array`);
    }

    match.all_pattern_groups = value.all_pattern_groups.map((group, index) =>
      nonEmptyStringArray(group, `query alias ${aliasId} match.all_pattern_groups[${index}]`)
    );

    if (match.all_pattern_groups.length === 0) {
      throw new Error(`query alias ${aliasId} match.all_pattern_groups must not be empty`);
    }
  }

  if ((match.patterns ?? []).length === 0 && (match.all_pattern_groups ?? []).length === 0) {
    throw new Error(`query alias ${aliasId} must define patterns or all_pattern_groups`);
  }

  return match;
}

function validateExpand(value: unknown, aliasId: unknown): QueryAliasExpandConfig {
  if (!isRecord(value)) {
    throw new Error(`query alias ${aliasId} expand must be an object`);
  }

  if (!Array.isArray(value.token_groups) || value.token_groups.length === 0) {
    throw new Error(`query alias ${aliasId} expand.token_groups must be a non-empty array`);
  }

  const expand: QueryAliasExpandConfig = {
    token_groups: value.token_groups.map((group, index) =>
      normalizedTokenGroup(group, `query alias ${aliasId} expand.token_groups[${index}]`)
    )
  };

  if (value.domains !== undefined) {
    expand.domains = nonEmptyStringArray(value.domains, `query alias ${aliasId} expand.domains`);
  }
  if (value.tags !== undefined) {
    expand.tags = nonEmptyStringArray(value.tags, `query alias ${aliasId} expand.tags`);
  }
  if (value.symbols !== undefined) {
    expand.symbols = nonEmptyStringArray(value.symbols, `query alias ${aliasId} expand.symbols`);
  }

  return expand;
}

function rejectOverbroadAlias(alias: QueryAliasConfigEntry): void {
  const hasCompoundMatch = (alias.match.all_pattern_groups ?? []).length >= 2;
  const singlePatterns = alias.match.patterns ?? [];

  if (hasCompoundMatch) {
    return;
  }

  for (const pattern of singlePatterns) {
    if (BROAD_SINGLE_PATTERNS.has(pattern.trim().toLowerCase())) {
      throw new Error(
        `query alias ${alias.id} pattern ${JSON.stringify(pattern)} is too broad without all_pattern_groups`
      );
    }
  }
}

function nonEmptyStringArray(value: unknown, name: string): string[] {
  if (!isStringArray(value)) {
    throw new Error(`${name} must be a string array`);
  }

  const output = [...new Set(value.map((item) => item.trim()).filter((item) => item.length > 0))];

  if (output.length === 0) {
    throw new Error(`${name} must not be empty`);
  }

  return output;
}

function normalizedTokenGroup(value: unknown, name: string): string[] {
  const tokens = nonEmptyStringArray(value, name).map((token) => token.toLowerCase());

  return [...new Set(tokens)].sort((left, right) => left.localeCompare(right));
}
