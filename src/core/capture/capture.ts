import { git } from "../../adapters/git/local-git.js";

export type CaptureDiscoveryServices = {
  git: (args: string[], cwd?: string) => string;
};

export type CaptureDiscoveryOptions = {
  sinceRef?: string;
  excludePaths?: string[];
  maxFiles?: number;
  maxCommits?: number;
  services?: CaptureDiscoveryServices;
};

export type CaptureSources = {
  since_ref?: string;
  changed_files: string[];
  untracked_files: string[];
  recent_commits: string[];
};

export type CapturePlan = {
  repo: string;
  root: string;
  store: string;
  local_store: boolean;
  branch: string;
  head_commit: string;
  sources: CaptureSources;
  recommended_observation_count: string;
  output_file: string;
  commands: string[];
  agent_prompt: string;
};

const DEFAULT_MAX_FILES = 40;
const DEFAULT_MAX_COMMITS = 8;

const defaultServices: CaptureDiscoveryServices = { git };

export function discoverCaptureSources(
  root: string,
  options: CaptureDiscoveryOptions = {}
): CaptureSources {
  const services = options.services ?? defaultServices;
  const excludePaths = new Set((options.excludePaths ?? []).map(normalizeRelativePath));
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxCommits = options.maxCommits ?? DEFAULT_MAX_COMMITS;
  const sinceRef = normalizeOptional(options.sinceRef);

  const changedFiles =
    sinceRef === undefined
      ? uniqueSorted([
          ...gitLines(services, ["diff", "--name-only"], root),
          ...gitLines(services, ["diff", "--cached", "--name-only"], root)
        ])
      : gitLines(services, ["diff", "--name-only", `${sinceRef}..HEAD`], root);
  const untrackedFiles =
    sinceRef === undefined
      ? gitLines(services, ["ls-files", "--others", "--exclude-standard"], root)
      : [];
  const recentCommits =
    sinceRef === undefined
      ? gitLines(services, ["log", "--oneline", `--max-count=${maxCommits}`], root)
      : gitLines(
          services,
          ["log", "--oneline", `--max-count=${maxCommits}`, `${sinceRef}..HEAD`],
          root
        );

  const sources: CaptureSources = {
    changed_files: filteredFiles(changedFiles, excludePaths).slice(0, maxFiles),
    untracked_files: filteredFiles(untrackedFiles, excludePaths).slice(0, maxFiles),
    recent_commits: recentCommits.slice(0, maxCommits)
  };

  if (sinceRef !== undefined) {
    sources.since_ref = sinceRef;
  }

  return sources;
}

export function buildCapturePlan(options: {
  repo: string;
  root: string;
  store: string;
  localStore: boolean;
  branch: string;
  headCommit: string;
  sources: CaptureSources;
  outputFile?: string;
}): CapturePlan {
  const outputFile = options.outputFile ?? "teamctx-capture-observations.json";
  const commands = [
    `teamctx record-verified ${outputFile}`,
    "teamctx normalize --dry-run",
    "teamctx normalize"
  ];

  return {
    repo: options.repo,
    root: options.root,
    store: options.store,
    local_store: options.localStore,
    branch: options.branch,
    head_commit: options.headCommit,
    sources: options.sources,
    recommended_observation_count: "3-10",
    output_file: outputFile,
    commands,
    agent_prompt: buildCaptureAgentPrompt({
      repo: options.repo,
      branch: options.branch,
      headCommit: options.headCommit,
      sources: options.sources,
      outputFile,
      commands
    })
  };
}

function buildCaptureAgentPrompt(options: {
  repo: string;
  branch: string;
  headCommit: string;
  sources: CaptureSources;
  outputFile: string;
  commands: string[];
}): string {
  return [
    "Capture durable teamctx knowledge from the latest work.",
    "",
    `Repository: ${options.repo}`,
    `Branch: ${options.branch}`,
    `Head: ${options.headCommit}`,
    ...(options.sources.since_ref !== undefined ? [`Since: ${options.sources.since_ref}`] : []),
    "",
    "Changed files:",
    bulletList(options.sources.changed_files, "- none detected"),
    "",
    "Untracked files:",
    bulletList(options.sources.untracked_files, "- none detected"),
    "",
    "Recent commits:",
    bulletList(options.sources.recent_commits, "- none detected"),
    "",
    "Write 3-10 short verified observations into",
    `${options.outputFile}. Record only durable future-use knowledge:`,
    "rules, pitfalls, decisions, workflows, facts, or glossary terms.",
    "",
    "Skip temporary progress notes, generic summaries, and anything without",
    "file-backed evidence. Use narrow scope paths/domains/tags so later",
    "session-start retrieval stays bounded. If there is no durable knowledge,",
    "do not create a record batch.",
    "",
    "For each captured record, include verification commands/files/notes when",
    "the latest work revealed a focused test command, a regression test file,",
    "or a manual check that future agents should reuse. Keep these hints narrow;",
    "they should improve specificity without turning teamctx into broad repo",
    "summarization.",
    "",
    "Then run:",
    ...options.commands.map((command) => `- ${command}`)
  ].join("\n");
}

function bulletList(values: string[], emptyLine: string): string {
  if (values.length === 0) {
    return emptyLine;
  }

  return values.map((value) => `- ${value}`).join("\n");
}

function gitLines(services: CaptureDiscoveryServices, args: string[], root: string): string[] {
  try {
    return services
      .git(args, root)
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

function filteredFiles(paths: string[], excludePaths: Set<string>): string[] {
  return uniqueSorted(
    paths.map(normalizeRelativePath).filter((path) => !isExcluded(path, excludePaths))
  );
}

function isExcluded(path: string, excludePaths: Set<string>): boolean {
  for (const excluded of excludePaths) {
    if (path === excluded || path.startsWith(`${excluded}/`)) {
      return true;
    }
  }

  return false;
}

function normalizeOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();

  return normalized && normalized.length > 0 ? normalized : undefined;
}

function normalizeRelativePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
