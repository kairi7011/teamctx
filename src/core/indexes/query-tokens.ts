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

export function queryTokenGroups(query: string | undefined): string[][] {
  const rawQuery = query ?? "";
  const aliasGroups: string[][] = [];
  const originalTokens = textTokens(rawQuery);
  const normalizedQuery = rawQuery.toLowerCase();

  for (const alias of QUERY_ALIASES) {
    if (matchesQueryAlias(alias, normalizedQuery)) {
      aliasGroups.push(...alias.tokenGroups);
    }
  }

  const groups = aliasGroups.length > 0 ? aliasGroups : [originalTokens];

  return uniqueTokenGroups(groups.map((group) => uniqueSorted(group)));
}

type QueryAlias = {
  patterns?: string[];
  allPatternGroups?: string[][];
  tokenGroups: string[][];
};

const QUERY_ALIASES: QueryAlias[] = [
  {
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
    patterns: ["\u4e88\u7b97", "\u30d0\u30b8\u30a7\u30c3\u30c8", "budget"],
    tokenGroups: [["context", "budgets"], ["context_budgets"], ["budgeting"], ["budget_rejected"]]
  },
  {
    patterns: ["\u8a3a\u65ad", "diagnostic", "diagnostics"],
    tokenGroups: [["budget_rejected"]]
  },
  {
    patterns: ["\u30d8\u30eb\u30d7", "help"],
    tokenGroups: [
      ["command", "help"],
      ["mutating", "command", "safety"]
    ]
  },
  {
    patterns: ["\u5b89\u5168", "safety"],
    tokenGroups: [["safety"], ["mutating", "command", "safety"]]
  },
  {
    patterns: ["\u7121\u99c4\u30b3\u30df\u30c3\u30c8", "commit"],
    tokenGroups: [["commit", "reduction"], ["writeifchanged"]]
  },
  {
    patterns: ["github\u30b9\u30c8\u30a2", "github store"],
    tokenGroups: [["commit", "github", "reduction", "store"]]
  },
  {
    allPatternGroups: [["github"], ["\u7af6\u5408", "conflict", "concurrency"]],
    tokenGroups: [["commit", "github", "reduction", "store"], ["writeifchanged"]]
  },
  {
    patterns: ["\u7af6\u5408", "conflict", "concurrency"],
    tokenGroups: [["optimistic", "concurrency"], ["concurrency"]]
  },
  {
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
    alias.patterns?.some((pattern) => normalizedQuery.includes(pattern)) ?? false;
  const allPatternGroupsMatch =
    alias.allPatternGroups?.every((group) =>
      group.some((pattern) => normalizedQuery.includes(pattern))
    ) ?? false;

  return anyPatternMatches || allPatternGroupsMatch;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
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
