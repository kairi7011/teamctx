export function textTokens(value: string): string[] {
  return uniqueSorted(
    value
      .toLowerCase()
      .split(/[^a-z0-9_]+/g)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2)
      .filter((token) => !TEXT_STOP_WORDS.has(token))
  );
}

export type QueryAlias = {
  id: string;
  patterns?: string[];
  allPatternGroups?: string[][];
  tokenGroups: string[][];
  domains?: string[];
  tags?: string[];
  symbols?: string[];
};

export type QueryExpansion = {
  tokenGroups: string[][];
  matchedAliasIds: string[];
};

export function queryWarnings(
  query: string | undefined,
  projectAliases: QueryAlias[] = []
): string[] {
  if (!isBroadQueryOnly(query, projectAliases)) {
    return [];
  }

  const token = textTokens(query ?? "")[0] ?? "";

  return [
    `query "${token}" is too broad for scoped context; add target_files, changed_files, symbols, tags, or a more specific query`
  ];
}

export function queryTokenGroups(
  query: string | undefined,
  projectAliases: QueryAlias[] = []
): string[][] {
  return expandQueryTokens(query, projectAliases).tokenGroups;
}

export function expandQueryTokens(
  query: string | undefined,
  projectAliases: QueryAlias[] = []
): QueryExpansion {
  const rawQuery = query ?? "";
  const aliasGroups: string[][] = [];
  const matchedAliasIds: string[] = [];
  const originalTokens = textTokens(rawQuery);
  const normalizedQuery = rawQuery.toLowerCase();

  for (const alias of [...QUERY_ALIASES, ...projectAliases]) {
    if (matchesQueryAlias(alias, normalizedQuery)) {
      matchedAliasIds.push(alias.id);
      aliasGroups.push(...alias.tokenGroups);
    }
  }

  if (aliasGroups.length === 0 && isBroadTokenOnly(originalTokens)) {
    return {
      tokenGroups: [],
      matchedAliasIds: []
    };
  }

  const groups = aliasGroups.length > 0 ? aliasGroups : queryTokenWindows(originalTokens);

  return {
    tokenGroups: uniqueTokenGroups(groups.map((group) => uniqueSorted(group))),
    matchedAliasIds: uniqueSorted(matchedAliasIds)
  };
}

function isBroadQueryOnly(query: string | undefined, projectAliases: QueryAlias[]): boolean {
  const rawQuery = query ?? "";
  const normalizedQuery = rawQuery.toLowerCase();

  if (
    [...QUERY_ALIASES, ...projectAliases].some((alias) => matchesQueryAlias(alias, normalizedQuery))
  ) {
    return false;
  }

  return isBroadTokenOnly(textTokens(rawQuery));
}

const QUERY_ALIASES: QueryAlias[] = [
  {
    id: "builtin:context-preview",
    patterns: [
      "\u30b3\u30f3\u30c6\u30ad\u30b9\u30c8\u30d7\u30ec\u30d3\u30e5\u30fc",
      "\u30d7\u30ec\u30d3\u30e5\u30fc",
      "context preview"
    ],
    tokenGroups: [
      ["context", "preview"],
      ["preview", "cli"]
    ]
  },
  {
    id: "builtin:budget",
    patterns: ["\u4e88\u7b97", "\u30d0\u30b8\u30a7\u30c3\u30c8", "budget"],
    tokenGroups: [["context", "budgets"], ["context_budgets"], ["budgeting"], ["budget_rejected"]]
  },
  {
    id: "builtin:diagnostics",
    allPatternGroups: [
      ["\u8a3a\u65ad", "diagnostic", "diagnostics"],
      [
        "budget",
        "overflow",
        "rejected",
        "dropped",
        "rank",
        "rank_score",
        "rank reasons",
        "budget_rejected"
      ]
    ],
    tokenGroups: [["budget_rejected"]]
  },
  {
    id: "builtin:help",
    allPatternGroups: [
      ["\u30d8\u30eb\u30d7", "help", "-h", "--help"],
      ["command", "flag", "handler", "mutating", "normalize", "output", "prints", "side effect"]
    ],
    tokenGroups: [
      ["command", "help"],
      ["mutating", "command", "safety"]
    ]
  },
  {
    id: "builtin:safety",
    allPatternGroups: [
      ["\u5b89\u5168", "safety"],
      ["command", "cli", "help", "handler", "mutating", "normalize"]
    ],
    tokenGroups: [["safety"], ["mutating", "command", "safety"]]
  },
  {
    id: "builtin:commit-reduction",
    patterns: ["\u7121\u99c4\u30b3\u30df\u30c3\u30c8", "commit"],
    tokenGroups: [["commit", "reduction"], ["writeifchanged"]]
  },
  {
    id: "builtin:github-store",
    patterns: ["github\u30b9\u30c8\u30a2", "github store"],
    tokenGroups: [["commit", "github", "reduction", "store"]]
  },
  {
    id: "builtin:github-conflict",
    allPatternGroups: [["github"], ["\u7af6\u5408", "conflict", "concurrency"]],
    tokenGroups: [["commit", "github", "reduction", "store"], ["writeifchanged"]]
  },
  {
    id: "builtin:concurrency",
    patterns: ["\u7af6\u5408", "conflict", "concurrency"],
    tokenGroups: [["optimistic", "concurrency"], ["concurrency"]]
  },
  {
    id: "builtin:noise",
    patterns: ["\u30ce\u30a4\u30ba", "noise"],
    tokenGroups: [["precision", "fix"]]
  }
];

function uniqueTokenGroups(groups: string[][]): string[][] {
  const seen = new Set<string>();
  const unique: string[][] = [];

  for (const group of groups) {
    if (group.length === 0) {
      continue;
    }

    const key = group.join("\0");
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(group);
  }

  return unique.sort(
    (left, right) => right.length - left.length || left.join(" ").localeCompare(right.join(" "))
  );
}

function matchesQueryAlias(alias: QueryAlias, normalizedQuery: string): boolean {
  const anyPatternMatches =
    alias.patterns?.some((pattern) => normalizedQuery.includes(pattern.toLowerCase())) ?? false;
  const allPatternGroupsMatch =
    alias.allPatternGroups?.every((group) =>
      group.some((pattern) => normalizedQuery.includes(pattern.toLowerCase()))
    ) ?? false;

  return anyPatternMatches || allPatternGroupsMatch;
}

export function queryAliasSelectors(
  query: string | undefined,
  projectAliases: QueryAlias[] = []
): { domains: string[]; tags: string[]; symbols: string[] } {
  const normalizedQuery = (query ?? "").toLowerCase();
  const domains: string[] = [];
  const tags: string[] = [];
  const symbols: string[] = [];

  for (const alias of projectAliases) {
    if (!matchesQueryAlias(alias, normalizedQuery)) {
      continue;
    }

    domains.push(...(alias.domains ?? []));
    tags.push(...(alias.tags ?? []));
    symbols.push(...(alias.symbols ?? []));
  }

  return {
    domains: uniqueSorted(domains),
    tags: uniqueSorted(tags),
    symbols: uniqueSorted(symbols)
  };
}

function isBroadTokenOnly(tokens: string[]): boolean {
  return tokens.length === 1 && BROAD_QUERY_TOKENS.has(tokens[0] ?? "");
}

function queryTokenWindows(tokens: string[]): string[][] {
  if (tokens.length <= 2) {
    return tokens.length === 0 ? [] : [tokens];
  }

  const groups: string[][] = [tokens];
  const maxWindow = Math.min(4, tokens.length);

  for (let size = maxWindow; size >= 2; size -= 1) {
    for (let index = 0; index <= tokens.length - size; index += 1) {
      groups.push(tokens.slice(index, index + size));
    }
  }

  return groups;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

const BROAD_QUERY_TOKENS = new Set(["cli", "code", "context", "github", "normalize"]);

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
