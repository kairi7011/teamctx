import type { GetContextInput } from "../../schemas/context-payload.js";

export type InferredContextSelectors = {
  target_files: string[];
  symbols: string[];
  domains: string[];
  tags: string[];
};

export type ContextSelectorResolution = {
  input: GetContextInput;
  inferred_selectors: InferredContextSelectors;
};

const EMPTY_INFERRED_SELECTORS: InferredContextSelectors = {
  target_files: [],
  symbols: [],
  domains: [],
  tags: []
};

const PATH_PATTERN =
  /(?:^|[\s"'`([{<])((?:\.{1,2}[\\/])?(?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|jsonl|md|mdx|yaml|yml|toml|css|scss|html|sql|rs|go|py|java|kt|cs|cpp|c|h|hpp|sh|ps1|bat|cmd))(?=$|[\s"'`)\]}>:;,])/giu;
const IDENTIFIER_PATTERN = /[A-Za-z_$][A-Za-z0-9_$]*(?:\/[A-Za-z_$][A-Za-z0-9_$]*)*/gu;
const SYMBOL_STOPWORDS = new Set([
  "behavior",
  "command",
  "domains",
  "handler",
  "index",
  "input",
  "json",
  "merge",
  "override",
  "parsing",
  "query",
  "regression",
  "selector",
  "symbols",
  "tags",
  "target",
  "teamctx",
  "test"
]);
const QUERY_SELECTOR_ALIASES: Array<{
  patterns: string[];
  domains?: string[];
  tags?: string[];
}> = [
  {
    patterns: ["context preview", "contextinput", "get_context", "teamctx context"],
    domains: ["context-preview"],
    tags: ["get-context", "preview-cli"]
  },
  {
    patterns: [
      "--domains",
      "--query",
      "--symbols",
      "--tags",
      "--target-files",
      "selector flag",
      "selector parsing"
    ],
    tags: ["selector-parsing", "get-context"]
  }
];

export function inferSelectorsFromQuery(query: string | undefined): InferredContextSelectors {
  if (query === undefined || query.trim().length === 0) {
    return { ...EMPTY_INFERRED_SELECTORS };
  }

  const targetFiles = extractTargetFiles(query);
  const queryWithoutPaths = query.replace(PATH_PATTERN, " ");
  const aliases = inferAliasSelectors(query);

  return {
    target_files: targetFiles,
    symbols: extractSymbols(queryWithoutPaths),
    domains: aliases.domains,
    tags: aliases.tags
  };
}

export function resolveContextInputSelectors(input: GetContextInput): ContextSelectorResolution {
  const inferred = inferSelectorsFromQuery(input.query);
  const targetFiles = mergeSelectors(input.target_files, inferred.target_files, normalizePathKey);
  const symbols = mergeSelectors(input.symbols, inferred.symbols, normalizeSymbolKey);
  const domains = mergeSelectors(input.domains, inferred.domains, normalizeTextKey);
  const tags = mergeSelectors(input.tags, inferred.tags, normalizeTextKey);
  const effectiveInput: GetContextInput = { ...input };

  if (targetFiles.values.length > 0) {
    effectiveInput.target_files = targetFiles.values;
  }
  if (symbols.values.length > 0) {
    effectiveInput.symbols = symbols.values;
  }
  if (domains.values.length > 0) {
    effectiveInput.domains = domains.values;
  }
  if (tags.values.length > 0) {
    effectiveInput.tags = tags.values;
  }

  return {
    input: effectiveInput,
    inferred_selectors: {
      target_files: targetFiles.added,
      symbols: symbols.added,
      domains: domains.added,
      tags: tags.added
    }
  };
}

function inferAliasSelectors(query: string): Pick<InferredContextSelectors, "domains" | "tags"> {
  const normalizedQuery = query.toLowerCase();
  const domains: string[] = [];
  const tags: string[] = [];

  for (const alias of QUERY_SELECTOR_ALIASES) {
    if (!alias.patterns.some((pattern) => normalizedQuery.includes(pattern))) {
      continue;
    }

    domains.push(...(alias.domains ?? []));
    tags.push(...(alias.tags ?? []));
  }

  return {
    domains: uniqueStable(domains, normalizeTextKey),
    tags: uniqueStable(tags, normalizeTextKey)
  };
}

function extractTargetFiles(query: string): string[] {
  const files: string[] = [];

  for (const match of query.matchAll(PATH_PATTERN)) {
    const rawPath = match[1];

    if (rawPath !== undefined) {
      files.push(normalizePathValue(rawPath));
    }
  }

  return uniqueStable(files, normalizePathKey);
}

function extractSymbols(query: string): string[] {
  const symbols: string[] = [];

  for (const match of query.matchAll(IDENTIFIER_PATTERN)) {
    const rawIdentifier = match[0];

    for (const identifier of rawIdentifier.split("/")) {
      if (isLikelySymbol(identifier)) {
        symbols.push(identifier.trim());
      }
    }
  }

  return uniqueStable(symbols, normalizeSymbolKey);
}

function isLikelySymbol(value: string): boolean {
  const symbol = value.trim();

  if (symbol.length < 3 || SYMBOL_STOPWORDS.has(symbol.toLowerCase())) {
    return false;
  }

  if (symbol.includes("_")) {
    return true;
  }

  if (/[a-z][A-Z]/.test(symbol)) {
    return true;
  }

  return (
    /^[A-Z][A-Za-z0-9_$]*$/.test(symbol) &&
    /[a-z]/.test(symbol) &&
    (symbol.match(/[A-Z]/g)?.length ?? 0) >= 2
  );
}

function mergeSelectors(
  explicitValues: string[] | undefined,
  inferredValues: string[],
  normalize: (value: string) => string
): { values: string[]; added: string[] } {
  const explicit = explicitValues ?? [];
  const values = [...explicit];
  const seen = new Set(explicit.map(normalize));
  const added: string[] = [];

  for (const inferred of inferredValues) {
    const key = normalize(inferred);

    if (key.length === 0 || seen.has(key)) {
      continue;
    }

    seen.add(key);
    values.push(inferred);
    added.push(inferred);
  }

  return { values, added };
}

function normalizePathValue(value: string): string {
  return value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
}

function normalizePathKey(value: string): string {
  return normalizePathValue(value);
}

function normalizeSymbolKey(value: string): string {
  return value.trim();
}

function normalizeTextKey(value: string): string {
  return value.trim().toLowerCase();
}

function uniqueStable(values: string[], normalize: (value: string) => string): string[] {
  const seen = new Set<string>();
  const output: string[] = [];

  for (const value of values) {
    const key = normalize(value);

    if (key.length === 0 || seen.has(key)) {
      continue;
    }

    seen.add(key);
    output.push(value);
  }

  return output;
}
