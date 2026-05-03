import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { DocRole, EvidenceKind } from "../../schemas/evidence.js";

export type BootstrapSource = {
  path: string;
  reason: string;
  evidence_kind: EvidenceKind;
  doc_role?: DocRole;
  priority: number;
};

export type BootstrapPlan = {
  repo: string;
  root: string;
  store: string;
  local_store: boolean;
  source_files: BootstrapSource[];
  recommended_observation_count: string;
  output_file: string;
  commands: string[];
  agent_prompt: string;
};

export type BootstrapDiscoveryOptions = {
  excludePaths?: string[];
  maxSources?: number;
};

const DEFAULT_MAX_SOURCES = 25;

const ROOT_CANDIDATES: readonly BootstrapSource[] = [
  {
    path: "AGENTS.md",
    reason: "agent instructions",
    evidence_kind: "docs",
    doc_role: "runbook",
    priority: 10
  },
  {
    path: "CLAUDE.md",
    reason: "agent instructions",
    evidence_kind: "docs",
    doc_role: "runbook",
    priority: 11
  },
  {
    path: ".github/copilot-instructions.md",
    reason: "agent instructions",
    evidence_kind: "docs",
    doc_role: "runbook",
    priority: 12
  },
  {
    path: "README.md",
    reason: "project README",
    evidence_kind: "docs",
    doc_role: "readme",
    priority: 20
  },
  {
    path: "package.json",
    reason: "package metadata and scripts",
    evidence_kind: "config",
    priority: 30
  },
  {
    path: "pyproject.toml",
    reason: "project metadata and tooling",
    evidence_kind: "config",
    priority: 31
  },
  {
    path: "Cargo.toml",
    reason: "project metadata and tooling",
    evidence_kind: "config",
    priority: 32
  },
  {
    path: "go.mod",
    reason: "project module metadata",
    evidence_kind: "config",
    priority: 33
  },
  {
    path: "Makefile",
    reason: "project workflow commands",
    evidence_kind: "config",
    priority: 34
  }
];

const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".teamctx",
  "coverage",
  "dist",
  "dist-test",
  "node_modules"
]);

export function discoverBootstrapSources(
  root: string,
  options: BootstrapDiscoveryOptions = {}
): BootstrapSource[] {
  const maxSources = options.maxSources ?? DEFAULT_MAX_SOURCES;
  const excludePaths = new Set((options.excludePaths ?? []).map(normalizeRelativePath));
  const sources = new Map<string, BootstrapSource>();

  for (const source of ROOT_CANDIDATES) {
    addSourceIfFile(sources, root, source, excludePaths);
  }

  addMarkdownSources(sources, root, "docs", excludePaths);
  addConfigSources(sources, root, join(".github", "workflows"), excludePaths);

  return [...sources.values()]
    .sort((left, right) => left.priority - right.priority || left.path.localeCompare(right.path))
    .slice(0, maxSources);
}

export function buildBootstrapPlan(options: {
  repo: string;
  root: string;
  store: string;
  localStore: boolean;
  sourceFiles: BootstrapSource[];
  outputFile?: string;
}): BootstrapPlan {
  const outputFile = options.outputFile ?? "teamctx-bootstrap-observations.json";
  const commands = [
    `teamctx record-verified ${outputFile}`,
    "teamctx normalize --dry-run",
    "teamctx normalize",
    'teamctx context --call-reason session_start --query "initial project context"'
  ];

  return {
    repo: options.repo,
    root: options.root,
    store: options.store,
    local_store: options.localStore,
    source_files: options.sourceFiles,
    recommended_observation_count: "8-15",
    output_file: outputFile,
    commands,
    agent_prompt: buildBootstrapAgentPrompt({
      repo: options.repo,
      sourceFiles: options.sourceFiles,
      outputFile,
      commands
    })
  };
}

function buildBootstrapAgentPrompt(options: {
  repo: string;
  sourceFiles: BootstrapSource[];
  outputFile: string;
  commands: string[];
}): string {
  const sources =
    options.sourceFiles.length > 0
      ? options.sourceFiles.map((source) => `- ${source.path}: ${source.reason}`).join("\n")
      : "- No standard source files were detected. Inspect the repository manually.";

  return [
    "Create initial teamctx context for this repository.",
    "",
    `Repository: ${options.repo}`,
    "",
    "Read these source files first:",
    sources,
    "",
    "Write 8-15 short verified observations into",
    `${options.outputFile}. Focus on durable knowledge that future agents need:`,
    "rules, pitfalls, decisions, workflows, facts, and glossary terms.",
    "",
    "Do not dump documentation. Each observation should be one reusable project",
    "constraint or workflow, include file-backed evidence, and use narrow scope",
    "paths/domains/tags so session-start retrieval stays bounded.",
    "Use the record-verified JSON shape: kind, text, source_type, scope,",
    "evidence, and supersedes when needed.",
    "",
    "Then run:",
    ...options.commands.map((command) => `- ${command}`)
  ].join("\n");
}

function addMarkdownSources(
  sources: Map<string, BootstrapSource>,
  root: string,
  relativeDirectory: string,
  excludePaths: Set<string>
): void {
  for (const path of listFiles(root, relativeDirectory)) {
    const normalized = normalizeRelativePath(path);

    if (!/\.(md|mdx)$/i.test(normalized)) {
      continue;
    }

    addSourceIfFile(
      sources,
      root,
      {
        path: normalized,
        reason: "project documentation",
        evidence_kind: "docs",
        doc_role: "other",
        priority: 50
      },
      excludePaths
    );
  }
}

function addConfigSources(
  sources: Map<string, BootstrapSource>,
  root: string,
  relativeDirectory: string,
  excludePaths: Set<string>
): void {
  for (const path of listFiles(root, relativeDirectory)) {
    const normalized = normalizeRelativePath(path);

    if (!/\.(ya?ml|json)$/i.test(normalized)) {
      continue;
    }

    addSourceIfFile(
      sources,
      root,
      {
        path: normalized,
        reason: "automation or CI configuration",
        evidence_kind: "config",
        priority: 60
      },
      excludePaths
    );
  }
}

function addSourceIfFile(
  sources: Map<string, BootstrapSource>,
  root: string,
  source: BootstrapSource,
  excludePaths: Set<string>
): void {
  const normalized = normalizeRelativePath(source.path);

  if (isExcluded(normalized, excludePaths) || sources.has(normalized)) {
    return;
  }

  const absolute = join(root, ...normalized.split("/"));

  if (existsSync(absolute) && statSync(absolute).isFile()) {
    sources.set(normalized, { ...source, path: normalized });
  }
}

function listFiles(root: string, relativeDirectory: string): string[] {
  const absoluteRoot = join(root, relativeDirectory);

  if (!existsSync(absoluteRoot) || !statSync(absoluteRoot).isDirectory()) {
    return [];
  }

  return listFilesRecursive(absoluteRoot).map((path) =>
    normalizeRelativePath(relative(root, path))
  );
}

function listFilesRecursive(directory: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        files.push(...listFilesRecursive(path));
      }
      continue;
    }

    if (entry.isFile()) {
      files.push(path);
    }
  }

  return files;
}

function isExcluded(path: string, excludePaths: Set<string>): boolean {
  for (const excluded of excludePaths) {
    if (path === excluded || path.startsWith(`${excluded}/`)) {
      return true;
    }
  }

  return false;
}

function normalizeRelativePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+$/, "");
}
