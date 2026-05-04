#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  describeGitHubAuth,
  GitHubClient,
  parseGitHubRepository
} from "../adapters/github/github-client.js";
import {
  assignDefined,
  type CliFlagValue,
  parseCsvFlag,
  parseLimitFlag,
  parseOffsetFlag
} from "./cli-args.js";
import { CliError, CLI_EXIT, mapErrorToExitCode } from "./cli-error.js";
import {
  getCurrentBranch,
  getHeadCommit,
  getOriginRemote,
  getRepoRoot
} from "../adapters/git/local-git.js";
import { normalizeGitHubRepo } from "../adapters/git/repo-url.js";
import { explainBoundItemAsync, invalidateBoundItemAsync } from "../core/audit/control.js";
import {
  buildBootstrapPlan,
  discoverBootstrapSources,
  type BootstrapPlan
} from "../core/bootstrap/bootstrap.js";
import {
  buildCapturePlan,
  discoverCaptureSources,
  type CapturePlan
} from "../core/capture/capture.js";
import {
  getBoundAuditSummary,
  parseAuditActions,
  type AuditSummaryInput
} from "../core/audit/summary.js";
import { parseContextStore } from "../core/binding/context-store.js";
import { findBinding, getConfigPath, upsertBinding } from "../core/binding/local-bindings.js";
import { describeBindingCapabilities } from "../core/capabilities.js";
import { explainBoundEpisodeAsync } from "../core/episodes/explain.js";
import {
  getBoundHygieneReport,
  type BoundHygieneOptions,
  type BoundHygieneReport
} from "../core/hygiene/report.js";
import {
  getBoundSupersedeDraft,
  type SupersedeDraftResult
} from "../core/hygiene/supersede-draft.js";
import {
  listBoundRecords,
  parseListKinds,
  parseListStates,
  type ListRecordsInput
} from "../core/list/records.js";
import { normalizeBoundStoreAsync } from "../core/normalize/normalize.js";
import { compactBoundStoreAsync } from "../core/retention/compact.js";
import { formatShowRecord } from "../core/show/record.js";
import { getBoundStatusAsync } from "../core/status/status.js";
import { initBoundStoreAsync } from "../core/store/init-store.js";
import { getContextToolAsync } from "../mcp/tools/get-context.js";
import {
  diffContextPayloads,
  type ContextCategory,
  type ContextDiff,
  type DiagnosticCategory,
  type DisabledSide,
  type IdSetDiff,
  type ValueSetDiff
} from "../core/context/context-diff.js";
import {
  explainContextQueryFromContextStore,
  explainContextQueryFromStore
} from "../core/context/query-explain.js";
import {
  rankContextFromStore,
  rankContextFromContextStore
} from "../core/context/compose-context.js";
import { resolveStoreRoot } from "../core/store/layout.js";
import { createContextStoreForBinding } from "../core/store/bound-store.js";
import {
  normalizeRecordObservationToolInput,
  recordObservationCandidateToolAsync,
  recordObservationVerifiedToolAsync,
  type NormalizedRecordObservationToolInput,
  type RecordObservationToolResult
} from "../mcp/tools/record-observation.js";
import { toolDefinitions } from "../mcp/tools/definitions.js";
import { validateGetContextInput, type GetContextInput } from "../schemas/context-payload.js";
import type { Binding, ToolDefinition } from "../schemas/types.js";

export type ParsedArgs = {
  command: string;
  positional: string[];
  flags: Record<string, CliFlagValue>;
};

const BOOLEAN_FLAGS = new Set(["dry-run", "force-refresh", "help", "json", "lease", "plan"]);
const REPEATABLE_VALUE_FLAGS = new Set([
  "action",
  "actions",
  "changed-files",
  "domain",
  "domains",
  "evidence-files",
  "item",
  "items",
  "kind",
  "kinds",
  "paths",
  "source-event",
  "source-events",
  "source-types",
  "state",
  "states",
  "symbol",
  "symbols",
  "tag",
  "tags",
  "target-files"
]);

export function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, CliFlagValue> = {};
  const repeatableValueFlags = repeatableValueFlagsForCommand(command);

  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];

    if (value === "--help") {
      flags.help = true;
    } else if (value === "-h") {
      flags.h = true;
    } else if (value?.startsWith("--")) {
      const key = value.slice(2);
      const next = rest[index + 1];

      if (BOOLEAN_FLAGS.has(key)) {
        assignFlag(flags, repeatableValueFlags, key, true);
      } else if (next && !isFlagToken(next)) {
        assignFlag(flags, repeatableValueFlags, key, next);
        index += 1;
      } else {
        throw new CliError(CLI_EXIT.USAGE, `--${key} requires a value`);
      }
    } else if (value) {
      positional.push(value);
    }
  }

  return { command, positional, flags };
}

function repeatableValueFlagsForCommand(command: string): Set<string> {
  if (command === "list") {
    return new Set([...REPEATABLE_VALUE_FLAGS, "path"]);
  }

  return REPEATABLE_VALUE_FLAGS;
}

function assignFlag(
  flags: Record<string, CliFlagValue>,
  repeatableValueFlags: Set<string>,
  key: string,
  value: CliFlagValue
): void {
  if (!repeatableValueFlags.has(key) || typeof value !== "string") {
    flags[key] = value;
    return;
  }

  const current = flags[key];

  if (typeof current === "string") {
    flags[key] = [current, value];
    return;
  }

  if (Array.isArray(current)) {
    current.push(value);
    return;
  }

  flags[key] = value;
}

function isFlagToken(value: string): boolean {
  return value.startsWith("--") || value === "-h";
}

export function shouldPrintHelp(args: ParsedArgs): boolean {
  return args.flags.help === true || args.flags.h === true;
}

export function formatHelp(): string {
  return `teamctx

Usage:
  teamctx bind <store> [--path <path>]
  teamctx setup <store> [--path <path>] [--json]
  teamctx bootstrap [<store>] [--path <path>] [--json]
  teamctx capture [--since-ref <ref>] [--json]
  teamctx init-store [--json]
  teamctx normalize [--dry-run] [--lease] [--json]
  teamctx compact [--dry-run] [--json]
  teamctx context [json-file] [--target-files <files>] [--changed-files <files>] [--domains <domains>] [--symbols <symbols>] [--tags <tags>] [--query <query>] [--call-reason <reason>] [--previous-context-payload-hash <hash>] [--force-refresh]
  teamctx context-diff <left-json> <right-json> [--json]
  teamctx query-explain [json-file]
  teamctx rank [--target-files <files>] [--domains <domains>] [--symbols <symbols>] [--tags <tags>] [--query <query>]
  teamctx list [--kind <kind>] [--state <state>] [--limit <n>] [--offset <n>]
  teamctx hygiene [--older-than-days <n>] [--large-record-tokens <n>] [--limit <n>] [--plan] [--json]
  teamctx supersede-draft <item-id> [<item-id> ...] [--json]
  teamctx audit [--action <action>] [--limit <n>] [--offset <n>]
  teamctx record-candidate <json-file> [--json]
  teamctx record-verified <json-file> [--json]
  teamctx first-record
  teamctx show <item-id>
  teamctx explain <item-id>
  teamctx explain-episode <episode-id>
  teamctx invalidate <item-id> [--reason <reason>] [--json]
  teamctx status [--json]
  teamctx doctor
  teamctx auth doctor
  teamctx tools [--json]
  teamctx capabilities [--json]

Examples:
  teamctx bind github.com/my-org/ai-context --path contexts/my-service
  teamctx setup . --path .teamctx
  teamctx bootstrap github.com/my-org/ai-context --path contexts/my-service
  teamctx bootstrap
  teamctx capture
  teamctx bind . --path .teamctx
  teamctx context --call-reason session_start --target-files src/index.ts --domains cli
  teamctx context-diff before.json after.json
  teamctx query-explain --target-files src/index.ts --domains cli
  teamctx rank --target-files src/index.ts --domains cli
  teamctx list --state active --domains cli --limit 20
  teamctx hygiene --older-than-days 90 --large-record-tokens 250 --plan
  teamctx supersede-draft rule-a rule-b --json
  teamctx audit --action created --limit 20
  teamctx first-record > observations.json
  teamctx record-verified observations.json
`;
}

function printHelp(): void {
  console.log(formatHelp());
}

function bind(args: ParsedArgs): void {
  const binding = bindCurrentRepo(args);

  console.log(formatBindReport(binding));
}

export function formatBindReport(binding: Binding): string {
  return [
    "Bound repository:",
    `  repo: ${binding.repo}`,
    `  root: ${binding.root}`,
    `  store: ${binding.contextStore.repo}/${binding.contextStore.path}`
  ].join("\n");
}

function bindCurrentRepo(args: ParsedArgs): ReturnType<typeof upsertBinding> {
  const [storeInput] = args.positional;

  if (!storeInput) {
    throw new CliError(
      CLI_EXIT.USAGE,
      "Missing context store. Usage: teamctx bind <store> [--path <path>]"
    );
  }

  const root = getRepoRoot();
  const repo = normalizeGitHubRepo(getOriginRemote(root));
  const storePath = typeof args.flags.path === "string" ? args.flags.path : ".teamctx";
  const contextStore = parseContextStore(storeInput, storePath, repo);

  return upsertBinding(repo, root, contextStore);
}

export const SETUP_NEXT_STEPS: readonly string[] = [
  "teamctx bootstrap",
  "teamctx record-verified teamctx-bootstrap-observations.json",
  "teamctx normalize",
  'teamctx context --call-reason session_start --query "<task>"'
];

export function formatSetupReport(
  binding: Binding,
  result: Awaited<ReturnType<typeof initBoundStoreAsync>>
): string {
  const lines = [
    "Set up teamctx:",
    `  repo: ${binding.repo}`,
    `  root: ${binding.root}`,
    `  store: ${binding.contextStore.repo}/${binding.contextStore.path}`,
    `  created_files: ${result.createdFiles.length}`,
    `  existing_files: ${result.existingFiles.length}`
  ];

  for (const step of SETUP_NEXT_STEPS) {
    lines.push(`  next: ${step}`);
  }

  return lines.join("\n");
}

async function setup(args: ParsedArgs): Promise<void> {
  const binding = bindCurrentRepo(args);
  const result = await initBoundStoreAsync();

  if (args.flags.json === true) {
    console.log(
      JSON.stringify(
        {
          binding,
          init_store: result,
          next: SETUP_NEXT_STEPS
        },
        null,
        2
      )
    );
    return;
  }

  console.log(formatSetupReport(binding, result));
}

async function bootstrap(args: ParsedArgs): Promise<void> {
  const storeInput = args.positional[0];
  const binding = storeInput ? bindCurrentRepo(args) : getCurrentBinding();
  const initResult = await initBoundStoreAsync();
  const plan = buildBootstrapPlan({
    repo: binding.repo,
    root: binding.root,
    store: `${binding.contextStore.repo}/${binding.contextStore.path}`,
    localStore: initResult.localStore,
    sourceFiles: discoverBootstrapSources(binding.root, {
      excludePaths: [binding.contextStore.path]
    })
  });

  if (args.flags.json === true) {
    console.log(
      JSON.stringify(
        {
          binding,
          init_store: initResult,
          bootstrap: plan
        },
        null,
        2
      )
    );
    return;
  }

  console.log(formatBootstrapPlan(plan, initResult));
}

async function capture(args: ParsedArgs): Promise<void> {
  const binding = getCurrentBinding();
  const initResult = await initBoundStoreAsync();
  const sinceRef =
    typeof args.flags["since-ref"] === "string" ? args.flags["since-ref"] : undefined;
  const sources = discoverCaptureSources(binding.root, {
    ...(sinceRef !== undefined ? { sinceRef } : {}),
    excludePaths: [binding.contextStore.path]
  });
  const plan = buildCapturePlan({
    repo: binding.repo,
    root: binding.root,
    store: `${binding.contextStore.repo}/${binding.contextStore.path}`,
    localStore: initResult.localStore,
    branch: getCurrentBranch(binding.root),
    headCommit: getHeadCommit(binding.root),
    sources
  });

  if (args.flags.json === true) {
    console.log(
      JSON.stringify(
        {
          binding,
          init_store: initResult,
          capture: plan
        },
        null,
        2
      )
    );
    return;
  }

  console.log(formatCapturePlan(plan, initResult));
}

function getCurrentBinding(): Binding {
  const root = getRepoRoot();
  const repo = normalizeGitHubRepo(getOriginRemote(root));
  const binding = findBinding(repo);

  if (!binding) {
    throw new CliError(
      CLI_EXIT.BINDING,
      "No teamctx binding found. Run `teamctx bootstrap <store> [--path <path>]` or `teamctx setup <store> [--path <path>]` first."
    );
  }

  return binding;
}

export function formatBootstrapPlan(
  plan: BootstrapPlan,
  initResult?: Awaited<ReturnType<typeof initBoundStoreAsync>>
): string {
  const lines = [
    "Bootstrap teamctx initial context:",
    `  repo: ${plan.repo}`,
    `  root: ${plan.root}`,
    `  store: ${plan.store}`,
    `  local_store: ${plan.local_store}`,
    `  source_files: ${plan.source_files.length}`,
    `  recommended_observations: ${plan.recommended_observation_count}`,
    `  recommended_aliases: ${plan.recommended_alias_count}`,
    `  output_file: ${plan.output_file}`,
    `  alias_file: ${plan.alias_file}`
  ];

  if (initResult !== undefined) {
    lines.push(`  created_files: ${initResult.createdFiles.length}`);
    lines.push(`  existing_files: ${initResult.existingFiles.length}`);
  }

  if (plan.source_files.length > 0) {
    lines.push("Source files to inspect:");
    for (const source of plan.source_files) {
      lines.push(`  - ${source.path} (${source.reason})`);
    }
  } else {
    lines.push("Source files to inspect:");
    lines.push("  - none detected; inspect the repository manually");
  }

  lines.push("Agent prompt:");
  for (const line of plan.agent_prompt.split("\n")) {
    lines.push(line.length > 0 ? `  ${line}` : "");
  }

  return lines.join("\n");
}

export function formatCapturePlan(
  plan: CapturePlan,
  initResult?: Awaited<ReturnType<typeof initBoundStoreAsync>>
): string {
  const lines = [
    "Capture teamctx knowledge from recent work:",
    `  repo: ${plan.repo}`,
    `  root: ${plan.root}`,
    `  store: ${plan.store}`,
    `  branch: ${plan.branch}`,
    `  head_commit: ${plan.head_commit}`,
    `  changed_files: ${plan.sources.changed_files.length}`,
    `  untracked_files: ${plan.sources.untracked_files.length}`,
    `  recent_commits: ${plan.sources.recent_commits.length}`,
    `  recommended_observations: ${plan.recommended_observation_count}`,
    `  output_file: ${plan.output_file}`
  ];

  if (plan.sources.since_ref !== undefined) {
    lines.push(`  since_ref: ${plan.sources.since_ref}`);
  }
  if (initResult !== undefined) {
    lines.push(`  created_files: ${initResult.createdFiles.length}`);
    lines.push(`  existing_files: ${initResult.existingFiles.length}`);
  }

  lines.push("Agent prompt:");
  for (const line of plan.agent_prompt.split("\n")) {
    lines.push(line.length > 0 ? `  ${line}` : "");
  }

  return lines.join("\n");
}

export function formatInitStoreResult(
  result: Awaited<ReturnType<typeof initBoundStoreAsync>>
): string {
  const lines = [
    "Initialized context store:",
    `  store: ${result.store}`,
    `  local_store: ${result.localStore}`
  ];

  if (result.root !== undefined) {
    lines.push(`  root: ${result.root}`);
  }

  lines.push(`  created_files: ${result.createdFiles.length}`);
  lines.push(`  existing_files: ${result.existingFiles.length}`);

  return lines.join("\n");
}

async function initStore(args: ParsedArgs): Promise<void> {
  const result = await initBoundStoreAsync();

  if (args.flags.json === true) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(formatInitStoreResult(result));
}

async function normalize(args: ParsedArgs): Promise<void> {
  const dryRun = args.flags["dry-run"] === true;
  const useLease = args.flags.lease === true;
  const result = await normalizeBoundStoreAsync({
    ...(dryRun ? { dryRun: true } : {}),
    ...(useLease ? { useLease: true } : {})
  });

  if (args.flags.json === true) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(formatNormalizeResult(result, { dryRun, useLease }));
}

export function formatNormalizeResult(
  result: Awaited<ReturnType<typeof normalizeBoundStoreAsync>>,
  options: { dryRun?: boolean; useLease?: boolean } = {}
): string {
  const lines = [
    options.dryRun === true ? "Normalized context store (dry-run):" : "Normalized context store:",
    `  run_id: ${result.runId}`,
    `  normalized_at: ${result.normalizedAt}`,
    `  raw_events_read: ${result.rawEventsRead}`,
    `  records_written: ${result.recordsWritten}`,
    `  dropped_events: ${result.droppedEvents}`,
    `  audit_entries_written: ${result.auditEntriesWritten}`
  ];

  if (options.dryRun === true) {
    lines.push("  note: no files were written; rerun without --dry-run to apply");
  }
  if (options.useLease === true && options.dryRun !== true) {
    lines.push("  lease: acquired and released");
  }

  return lines.join("\n");
}

export function formatCompactResult(
  result: Awaited<ReturnType<typeof compactBoundStoreAsync>>,
  options: { dryRun?: boolean } = {}
): string {
  const lines = [
    options.dryRun === true ? "Compacted context store (dry-run):" : "Compacted context store:",
    `  compacted_at: ${result.compactedAt}`,
    `  archive_root: ${result.archiveRoot}`,
    `  raw_candidate_events_archived: ${result.rawCandidateEventsArchived}`,
    `  raw_events_retained: ${result.rawEventsRetained}`,
    `  audit_entries_archived: ${result.auditEntriesArchived}`,
    `  audit_entries_retained: ${result.auditEntriesRetained}`,
    `  archived_records_archived: ${result.archivedRecordsArchived}`,
    `  normalized_records_retained: ${result.normalizedRecordsRetained}`
  ];

  if (options.dryRun === true) {
    lines.push("  note: no files were archived; rerun without --dry-run to apply");
  }

  return lines.join("\n");
}

async function compact(args: ParsedArgs): Promise<void> {
  const dryRun = args.flags["dry-run"] === true;
  const result = await compactBoundStoreAsync(dryRun ? { dryRun: true } : {});

  if (args.flags.json === true) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(formatCompactResult(result, { dryRun }));
}

async function context(args: ParsedArgs): Promise<void> {
  console.log(JSON.stringify(await getContextToolAsync(contextInput(args)), null, 2));
}

async function contextDiff(args: ParsedArgs): Promise<void> {
  const [leftPath, rightPath] = args.positional;

  if (!leftPath || !rightPath) {
    throw new CliError(
      CLI_EXIT.USAGE,
      "Missing input files. Usage: teamctx context-diff <left-json> <right-json> [--json]"
    );
  }

  const leftInput = readContextInputFile(leftPath);
  const rightInput = readContextInputFile(rightPath);
  const left = await getContextToolAsync(leftInput);
  const right = await getContextToolAsync(rightInput);
  const diff = diffContextPayloads(left, right, leftInput, rightInput);

  if (args.flags.json === true) {
    console.log(JSON.stringify(diff, null, 2));
    return;
  }

  console.log(formatContextDiff(diff));
}

export function formatContextDiff(diff: ContextDiff): string {
  if (!diff.enabled) {
    return [
      "Context diff unavailable:",
      disabledSideLine("left", diff.left),
      disabledSideLine("right", diff.right)
    ].join("\n");
  }

  const lines = [
    "Context diff:",
    `  left_hash: ${diff.left.context_payload_hash}`,
    `  right_hash: ${diff.right.context_payload_hash}`,
    `  left_store_head: ${diff.left.store_head ?? "<none>"}`,
    `  right_store_head: ${diff.right.store_head ?? "<none>"}`
  ];

  appendIdSetDiff(lines, "  scoped", diff.scoped);
  appendIdSetDiff(lines, "  relevant_episodes", diff.relevant_episodes);
  appendValueSetDiff(lines, "  canonical_doc_refs", diff.canonical_doc_refs);
  lines.push("  categories:");
  for (const category of CONTEXT_CATEGORY_ORDER) {
    appendValueSetDiff(lines, `    ${category}`, diff.categories[category]);
  }
  lines.push("  diagnostics:");
  for (const category of DIAGNOSTIC_CATEGORY_ORDER) {
    appendValueSetDiff(lines, `    ${category}`, diff.diagnostics[category]);
  }

  return lines.join("\n");
}

const CONTEXT_CATEGORY_ORDER: readonly ContextCategory[] = [
  "global",
  "must_follow_rules",
  "recent_decisions",
  "active_pitfalls",
  "applicable_workflows",
  "glossary_terms"
];

const DIAGNOSTIC_CATEGORY_ORDER: readonly DiagnosticCategory[] = [
  "contested_items",
  "stale_items",
  "dropped_items",
  "excluded_items",
  "budget_rejected",
  "index_warnings"
];

function disabledSideLine(label: string, side: DisabledSide): string {
  if (side.enabled) {
    return `  ${label}: enabled hash=${side.context_payload_hash}`;
  }

  return `  ${label}: disabled reason=${side.reason ?? "unknown"}`;
}

function appendValueSetDiff(lines: string[], label: string, diff: ValueSetDiff): void {
  lines.push(`${label}: +${diff.added_count} -${diff.removed_count} =${diff.unchanged_count}`);
  appendDiffValues(lines, label, diff);
}

function appendIdSetDiff(lines: string[], label: string, diff: IdSetDiff): void {
  lines.push(`${label}: +${diff.added.length} -${diff.removed.length} =${diff.unchanged.length}`);
  appendDiffValues(lines, label, diff);
}

function appendDiffValues(lines: string[], label: string, diff: IdSetDiff): void {
  const valueIndent = `${" ".repeat(label.search(/\S/) + 2)}`;

  for (const value of diff.added) {
    lines.push(`${valueIndent}+ ${value}`);
  }
  for (const value of diff.removed) {
    lines.push(`${valueIndent}- ${value}`);
  }
  for (const value of diff.unchanged.slice(0, 5)) {
    lines.push(`${valueIndent}= ${value}`);
  }
  if (diff.unchanged.length > 5) {
    lines.push(`${valueIndent}= ... ${diff.unchanged.length - 5} more unchanged`);
  }
}

async function queryExplain(args: ParsedArgs): Promise<void> {
  const root = getRepoRoot();
  const repo = normalizeGitHubRepo(getOriginRemote(root));
  const binding = findBinding(repo);

  if (!binding) {
    throw new CliError(CLI_EXIT.BINDING, "No teamctx binding found for this git root.");
  }

  const input = contextInput(args);

  if (binding.contextStore.repo === repo) {
    const storeRoot = resolveStoreRoot(root, binding.contextStore.path);
    console.log(JSON.stringify(explainContextQueryFromStore(storeRoot, input), null, 2));
    return;
  }

  const store = createContextStoreForBinding({ repo, repoRoot: root, binding });
  console.log(JSON.stringify(await explainContextQueryFromContextStore(store, input), null, 2));
}

async function rank(args: ParsedArgs): Promise<void> {
  const root = getRepoRoot();
  const repo = normalizeGitHubRepo(getOriginRemote(root));
  const binding = findBinding(repo);

  if (!binding) {
    throw new CliError(CLI_EXIT.BINDING, "No teamctx binding found for this git root.");
  }

  const input = contextInput(args);

  if (binding.contextStore.repo === repo) {
    const storeRoot = resolveStoreRoot(root, binding.contextStore.path);
    const trace = rankContextFromStore(storeRoot, input);

    console.log(JSON.stringify(trace, null, 2));
    return;
  }

  const store = createContextStoreForBinding({ repo, repoRoot: root, binding });
  const trace = await rankContextFromContextStore(store, input);

  console.log(JSON.stringify(trace, null, 2));
}

async function list(args: ParsedArgs): Promise<void> {
  const input: ListRecordsInput = {};

  assignDefined(
    input,
    "kinds",
    parseListKinds(parseCsvFlag(mergedFlag(args.flags.kind, args.flags.kinds)))
  );
  assignDefined(
    input,
    "states",
    parseListStates(parseCsvFlag(mergedFlag(args.flags.state, args.flags.states)))
  );
  assignDefined(input, "paths", parseCsvFlag(mergedFlag(args.flags.path, args.flags.paths)));
  assignDefined(input, "domains", parseCsvFlag(mergedFlag(args.flags.domain, args.flags.domains)));
  assignDefined(input, "symbols", parseCsvFlag(mergedFlag(args.flags.symbol, args.flags.symbols)));
  assignDefined(input, "tags", parseCsvFlag(mergedFlag(args.flags.tag, args.flags.tags)));

  if (typeof args.flags.query === "string") {
    input.query = args.flags.query;
  }
  assignDefined(input, "limit", parseLimitFlag(args.flags.limit));
  assignDefined(input, "offset", parseOffsetFlag(args.flags.offset));

  console.log(JSON.stringify(await listBoundRecords(input), null, 2));
}

async function hygiene(args: ParsedArgs): Promise<void> {
  const input: BoundHygieneOptions = {};

  assignDefined(
    input,
    "olderThanDays",
    parseLimitFlag(args.flags["older-than-days"], "--older-than-days")
  );
  assignDefined(
    input,
    "largeRecordTokens",
    parseLimitFlag(args.flags["large-record-tokens"], "--large-record-tokens")
  );
  assignDefined(input, "limit", parseLimitFlag(args.flags.limit));
  if (args.flags.plan === true) {
    input.includePlan = true;
  }

  const result = await getBoundHygieneReport(input);

  if (args.flags.json === true) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(formatHygieneReport(result));
}

export function formatHygieneReport(result: BoundHygieneReport): string {
  if (!result.enabled) {
    const lines = ["Context hygiene unavailable:", `  reason: ${result.reason}`];

    if (result.repo !== undefined) {
      lines.push(`  repo: ${result.repo}`);
    }

    return lines.join("\n");
  }

  const { counts } = result;
  const lines = [
    "Context hygiene:",
    `  repo: ${result.repo}`,
    `  branch: ${result.branch}`,
    `  head: ${result.head_commit}`,
    `  store: ${result.context_store}`,
    `  checked_at: ${result.checked_at}`,
    `  thresholds: old_active>=${result.older_than_days}d large_record>=${result.large_record_tokens} tokens`,
    `  records: total=${counts.total_records} active=${counts.active_records} inactive=${counts.inactive_records}`,
    `  risks: expired=${counts.expired_active_records} future=${counts.not_yet_valid_active_records} old=${counts.old_active_records} unverified=${counts.unverified_active_records} duplicate=${counts.duplicate_active_text_records} crowded=${counts.crowded_active_scope_records} large=${counts.large_active_records}`
  ];

  appendHygieneRiskList(lines, result);
  appendHygieneMaintenancePlan(lines, result);

  if (result.recovery_suggestions.length > 0) {
    lines.push("  suggestions:");
    for (const suggestion of result.recovery_suggestions) {
      lines.push(`    - ${suggestion}`);
    }
  }

  return lines.join("\n");
}

function appendHygieneMaintenancePlan(lines: string[], result: BoundHygieneReport): void {
  if (!result.enabled || result.maintenance_plan === undefined) {
    return;
  }

  const plan = result.maintenance_plan;
  lines.push(`  maintenance_plan: ${plan.mode}`);

  if (plan.items.length === 0) {
    lines.push("    items: none");
  } else {
    lines.push("    items:");

    for (const item of plan.items) {
      lines.push(`      - [${item.severity}] ${item.action}: ${item.record_ids.join(", ")}`);
      lines.push(`        title: ${item.title}`);
      lines.push(`        why: ${item.rationale}`);
      lines.push("        review:");
      for (const command of item.review_commands) {
        lines.push(`          - ${command}`);
      }
      lines.push("        candidate_write:");
      for (const command of item.candidate_write_commands) {
        lines.push(`          - ${command}`);
      }
      if (item.observation_drafts.length > 0) {
        lines.push(
          `        observation_drafts: ${item.observation_drafts.length} incomplete draft(s); fill evidence before record-verified`
        );
      }
      if (item.notes.length > 0) {
        lines.push("        notes:");
        for (const note of item.notes) {
          lines.push(`          - ${note}`);
        }
      }
    }
  }

  lines.push("    safety:");
  for (const note of plan.safety_notes) {
    lines.push(`      - ${note}`);
  }
}

function appendHygieneRiskList(lines: string[], result: BoundHygieneReport): void {
  if (!result.enabled || result.risk_items.length === 0) {
    lines.push("  risk_items: none");
    return;
  }

  lines.push("  risk_items:");

  for (const item of result.risk_items) {
    const metrics = [
      item.age_days !== undefined ? `age=${item.age_days}d` : undefined,
      item.token_count !== undefined ? `tokens=${item.token_count}` : undefined
    ]
      .filter((value): value is string => value !== undefined)
      .join(" ");
    const suffix = metrics.length > 0 ? ` ${metrics}` : "";

    lines.push(
      `    - [${item.severity}] ${item.risk} ${item.id} (${item.kind})${suffix}: ${item.detail}`
    );
  }
}

async function audit(args: ParsedArgs): Promise<void> {
  const input: AuditSummaryInput = {};

  assignDefined(
    input,
    "actions",
    parseAuditActions(parseCsvFlag(mergedFlag(args.flags.action, args.flags.actions)))
  );
  assignDefined(input, "item_ids", parseCsvFlag(mergedFlag(args.flags.item, args.flags.items)));
  assignDefined(
    input,
    "source_event_ids",
    parseCsvFlag(mergedFlag(args.flags["source-event"], args.flags["source-events"]))
  );

  if (typeof args.flags.query === "string") {
    input.query = args.flags.query;
  }
  assignDefined(input, "limit", parseLimitFlag(args.flags.limit));
  assignDefined(input, "offset", parseOffsetFlag(args.flags.offset));

  console.log(JSON.stringify(await getBoundAuditSummary(input), null, 2));
}

export function contextInput(args: ParsedArgs): GetContextInput {
  const [inputPath] = args.positional;
  const input: GetContextInput = inputPath ? readContextInputFile(inputPath) : {};

  assignCsv(input, "target_files", args.flags["target-files"]);
  assignCsv(input, "changed_files", args.flags["changed-files"]);
  assignCsv(input, "domains", mergedFlag(args.flags.domain, args.flags.domains));
  assignCsv(input, "symbols", mergedFlag(args.flags.symbol, args.flags.symbols));
  assignCsv(input, "tags", mergedFlag(args.flags.tag, args.flags.tags));
  assignCsv(input, "source_types", args.flags["source-types"]);
  assignCsv(input, "evidence_files", args.flags["evidence-files"]);
  assignString(input, "query", args.flags.query);
  assignString(input, "since", args.flags.since);
  assignString(input, "until", args.flags.until);
  assignString(input, "branch", args.flags.branch);
  assignString(input, "head_commit", args.flags["head-commit"]);
  assignString(input, "call_reason", args.flags["call-reason"]);
  assignString(input, "previous_context_payload_hash", args.flags["previous-context-payload-hash"]);

  if (args.flags["force-refresh"] === true) {
    input.force_refresh = true;
  }

  return input;
}

function readContextInputFile(path: string): GetContextInput {
  return validateGetContextInput(JSON.parse(readFileSync(resolve(path), "utf8")) as unknown);
}

function assignCsv<T extends keyof GetContextInput>(
  input: GetContextInput,
  key: T,
  value: CliFlagValue | undefined
): void {
  const values = parseCsvFlag(value);

  if (values !== undefined && values.length > 0) {
    Object.assign(input, { [key]: values });
  }
}

function assignString<T extends keyof GetContextInput>(
  input: GetContextInput,
  key: T,
  value: CliFlagValue | undefined
): void {
  if (typeof value === "string") {
    Object.assign(input, { [key]: value });
  }
}

function mergedFlag(...values: Array<CliFlagValue | undefined>): CliFlagValue | undefined {
  const merged: string[] = [];

  for (const value of values) {
    if (typeof value === "string") {
      merged.push(value);
    } else if (Array.isArray(value)) {
      merged.push(...value);
    }
  }

  if (merged.length === 0) {
    return undefined;
  }

  return merged.length === 1 ? merged[0] : merged;
}

async function recordObservation(args: ParsedArgs, trust: "candidate" | "verified"): Promise<void> {
  const [inputPath] = args.positional;

  if (!inputPath) {
    throw new CliError(
      CLI_EXIT.USAGE,
      `Missing json file. Usage: teamctx record-${trust} <json-file>`
    );
  }

  const input = JSON.parse(readFileSync(resolve(inputPath), "utf8")) as unknown;
  const observations = prepareRecordObservationInputs(input, trust);

  const results: Array<{ index: number; result: RecordObservationToolResult }> = [];

  for (const observation of observations) {
    const result =
      trust === "verified"
        ? await recordObservationVerifiedToolAsync(toRecordObservationToolInput(observation.input))
        : await recordObservationCandidateToolAsync(
            toRecordObservationToolInput(observation.input)
          );

    results.push({ index: observation.index, result });
  }

  if (args.flags.json === true) {
    console.log(
      JSON.stringify(
        {
          trust,
          count: results.length,
          observations: results.map((item) => ({
            index: item.index,
            ...item.result
          }))
        },
        null,
        2
      )
    );
    return;
  }

  console.log(formatRecordObservationsReport(trust, results, observations.length));
}

export function prepareRecordObservationInputs(
  input: unknown,
  trust: "candidate" | "verified"
): Array<{ index: number; input: NormalizedRecordObservationToolInput }> {
  const observations = Array.isArray(input) ? input : [input];

  if (observations.length === 0) {
    throw new CliError(
      CLI_EXIT.VALIDATION,
      "Observation json file must contain an object or a non-empty array."
    );
  }

  return observations.map((observation, index) => ({
    index: index + 1,
    input: normalizeRecordObservationToolInput(observation, trust)
  }));
}

function toRecordObservationToolInput(
  input: NormalizedRecordObservationToolInput
): Record<string, unknown> {
  return {
    ...input.observation,
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {})
  };
}

export function formatRecordObservationsReport(
  trust: "candidate" | "verified",
  results: Array<{ index: number; result: RecordObservationToolResult }>,
  totalCount: number = results.length
): string {
  const lines = [`Recorded ${trust} raw observations:`];

  for (const { index, result } of results) {
    lines.push(`  - ${index}: ${result.relative_path}`);

    for (const finding of result.findings) {
      lines.push(
        `      ${finding.severity}: ${finding.kind} in ${finding.field} ${finding.excerpt}`
      );
    }
  }

  lines.push(`  count: ${totalCount}`);

  return lines.join("\n");
}

export function buildFirstRecordTemplate(): {
  kind: "workflow";
  text: string;
  source_type: "inferred_from_code";
  scope: { paths: string[]; domains: string[]; tags: string[] };
  evidence: Array<{
    kind: "code";
    repo: string;
    file: string;
    line_start: number;
    line_end: number;
  }>;
} {
  return {
    kind: "workflow",
    text: "Describe one repo-specific workflow, rule, pitfall, decision, fact, or glossary term.",
    source_type: "inferred_from_code",
    scope: {
      paths: ["src/**"],
      domains: ["example"],
      tags: ["first-record"]
    },
    evidence: [
      {
        kind: "code",
        repo: "github.com/my-org/my-repo",
        file: "src/index.ts",
        line_start: 1,
        line_end: 20
      }
    ]
  };
}

function firstRecord(): void {
  console.log(JSON.stringify(buildFirstRecordTemplate(), null, 2));
}

async function supersedeDraft(args: ParsedArgs): Promise<void> {
  if (args.positional.length === 0) {
    throw new CliError(
      CLI_EXIT.USAGE,
      "Missing item id. Usage: teamctx supersede-draft <item-id> [<item-id> ...] [--json]"
    );
  }

  const result = await getBoundSupersedeDraft({ itemIds: args.positional });

  if (args.flags.json === true) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(formatSupersedeDraft(result));
}

export function formatSupersedeDraft(result: SupersedeDraftResult): string {
  const lines = [
    "Supersede draft:",
    `  mode: ${result.mode}`,
    `  records: ${result.record_ids.join(", ")}`,
    "  review:"
  ];

  for (const command of result.review_commands) {
    lines.push(`    - ${command}`);
  }

  if (result.warnings.length > 0) {
    lines.push("  warnings:");
    for (const warning of result.warnings) {
      lines.push(`    - ${warning}`);
    }
  }

  lines.push("  candidate_write:");
  for (const command of result.candidate_write_commands) {
    lines.push(`    - ${command}`);
  }

  lines.push("  draft_observation:", indent(JSON.stringify(result.draft_observation, null, 2), 4));

  return lines.join("\n");
}

function indent(value: string, spaces: number): string {
  const prefix = " ".repeat(spaces);

  return value
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

async function explain(args: ParsedArgs): Promise<void> {
  const [itemId] = args.positional;

  if (!itemId) {
    throw new CliError(CLI_EXIT.USAGE, "Missing item id. Usage: teamctx explain <item-id>");
  }

  console.log(JSON.stringify(await explainBoundItemAsync({ itemId }), null, 2));
}

async function show(args: ParsedArgs): Promise<void> {
  const [itemId] = args.positional;

  if (!itemId) {
    throw new CliError(CLI_EXIT.USAGE, "Missing item id. Usage: teamctx show <item-id>");
  }

  console.log(formatShowRecord(await explainBoundItemAsync({ itemId })));
}

async function explainEpisode(args: ParsedArgs): Promise<void> {
  const [episodeId] = args.positional;

  if (!episodeId) {
    throw new CliError(
      CLI_EXIT.USAGE,
      "Missing episode id. Usage: teamctx explain-episode <episode-id>"
    );
  }

  console.log(JSON.stringify(await explainBoundEpisodeAsync({ episodeId }), null, 2));
}

async function invalidate(args: ParsedArgs): Promise<void> {
  const [itemId] = args.positional;

  if (!itemId) {
    throw new CliError(
      CLI_EXIT.USAGE,
      "Missing item id. Usage: teamctx invalidate <item-id> [--reason <reason>]"
    );
  }

  const reason = typeof args.flags.reason === "string" ? args.flags.reason : undefined;
  const result = await invalidateBoundItemAsync({
    itemId,
    ...(reason !== undefined ? { reason } : {})
  });

  if (args.flags.json === true) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(formatInvalidateResult(result));
}

export function formatInvalidateResult(result: {
  item_id: string;
  before_state: string;
  after_state: string;
}): string {
  return [
    "Invalidated context item:",
    `  item_id: ${result.item_id}`,
    `  before_state: ${result.before_state}`,
    `  after_state: ${result.after_state}`
  ].join("\n");
}

export function formatStatusReport(
  result: Awaited<ReturnType<typeof getBoundStatusAsync>>
): string {
  if (!result.enabled) {
    const lines = ["teamctx disabled"];
    if (result.repo !== undefined) {
      lines.push(`  repo: ${result.repo}`);
    }
    lines.push(`  reason: ${result.reason}`);
    return lines.join("\n");
  }

  const lines = [
    "teamctx enabled",
    `  repo: ${result.repo}`,
    `  root: ${result.root}`,
    `  branch: ${result.branch}`,
    `  head: ${result.head_commit}`,
    `  store: ${result.context_store}`
  ];

  if (!result.summary) {
    lines.push(`  summary: ${result.summary_unavailable_reason ?? "unavailable"}`);
    return lines.join("\n");
  }

  const { summary } = result;
  const lastNormalize = summary.last_normalize_result;

  lines.push(
    `  records: active=${summary.counts.active_records} contested=${summary.counts.contested_records} stale=${summary.counts.stale_records} archived=${summary.counts.archived_records}`
  );
  lines.push(
    `  last_normalize: ${
      lastNormalize
        ? `${lastNormalize.normalizedAt} run=${lastNormalize.runId} raw=${lastNormalize.rawEventsRead} promoted=${lastNormalize.recordsWritten} dropped=${lastNormalize.droppedEvents}`
        : "never"
    }`
  );
  if (summary.normalize_lease.state !== "none") {
    const lease = summary.normalize_lease.lease;
    lines.push(
      `  normalize_lease: ${summary.normalize_lease.state} owner=${lease.owner.hostname}:${lease.owner.pid} expires=${lease.expires_at}`
    );
  }
  appendStatusList(
    lines,
    "recent_promoted",
    summary.recent_promoted_items.map((item) => ({
      id: item.item_id,
      detail: item.record?.text ?? item.reason ?? "record not found"
    })),
    summary.counts.promoted_records
  );
  appendStatusList(
    lines,
    "contested",
    summary.contested_items.map((item) => ({
      id: item.item_id,
      detail: contestedStatusDetail(item)
    })),
    summary.counts.contested_records
  );
  appendStatusList(
    lines,
    "dropped",
    summary.dropped_items.map((item) => ({
      id: item.source_event_ids.join(",") || "(unknown event)",
      detail: item.reason ?? "dropped"
    })),
    summary.counts.dropped_events
  );
  appendStatusList(
    lines,
    "stale",
    summary.stale_items.map((item) => ({ id: item.item_id, detail: item.text })),
    summary.counts.stale_records
  );

  if (summary.index_warnings.length > 0) {
    lines.push("  index_warnings:");

    for (const warning of summary.index_warnings) {
      lines.push(`    - ${warning}`);
    }
  }

  if (summary.recovery_suggestions.length > 0) {
    lines.push("  recovery:");

    for (const suggestion of summary.recovery_suggestions) {
      lines.push(`    - ${suggestion}`);
    }
  }

  return lines.join("\n");
}

async function status(args: ParsedArgs): Promise<void> {
  const result = await getBoundStatusAsync();

  if (args.flags.json === true) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(formatStatusReport(result));
}

function contestedStatusDetail(item: {
  text: string;
  competing_items?: Array<{ item_id: string; text: string }>;
  contest_audit_entries?: Array<{ reason?: string }>;
}): string {
  const competingIds = (item.competing_items ?? []).map((competing) => competing.item_id);
  const reason = item.contest_audit_entries?.[0]?.reason;
  const parts = [item.text];

  if (competingIds.length > 0) {
    parts.push(`conflicts_with=${competingIds.join(",")}`);
  }
  if (reason !== undefined) {
    parts.push(`reason=${reason}`);
  }

  return parts.join(" | ");
}

function appendStatusList(
  lines: string[],
  label: string,
  rows: Array<{ id: string; detail: string }>,
  total = rows.length
): void {
  const visibleCount =
    rows.length === total ? String(rows.length) : `${rows.length} of ${total} shown`;

  lines.push(`  ${label}: ${visibleCount}`);

  for (const row of rows) {
    lines.push(`    - ${row.id}: ${row.detail}`);
  }
}

async function doctor(): Promise<void> {
  console.log("teamctx doctor");
  console.log(`  version: ${packageVersion()}`);
  console.log(`  node: ${process.version}`);
  console.log(`  config: ${getConfigPath()}`);
  const auth = describeGitHubAuth({ allowGh: true });
  console.log(`  github_auth: ${auth.source}`);

  let root: string;
  let repo: string;

  try {
    root = getRepoRoot();
    repo = normalizeGitHubRepo(getOriginRemote(root));
  } catch (error) {
    console.log("  git: failed");
    console.log(`  reason: ${error instanceof Error ? error.message : String(error)}`);
    console.log("  next: run doctor from a git repository with an origin remote");
    return;
  }

  console.log("  git: ok");
  console.log(`  repo: ${repo}`);
  console.log(`  root: ${root}`);
  console.log(`  branch: ${getCurrentBranch(root)}`);
  console.log(`  head: ${getHeadCommit(root)}`);

  let binding: ReturnType<typeof findBinding>;

  try {
    binding = findBinding(repo);
  } catch (error) {
    console.log("  config: invalid");
    console.log(`  reason: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  if (!binding) {
    console.log("  binding: missing");
    console.log("  next: teamctx bind <store> --path <path>");
    return;
  }

  console.log("  binding: found");
  console.log(`  store: ${binding.contextStore.repo}/${binding.contextStore.path}`);

  if (binding.contextStore.provider === "github" && binding.contextStore.repo !== repo) {
    await reportStoreVisibility(binding.contextStore.repo, auth.token);
  }
}

async function authDoctor(): Promise<void> {
  console.log("teamctx auth doctor");
  const auth = describeGitHubAuth({ allowGh: true });
  console.log(`  github_auth: ${auth.source}`);
  console.log(`  token_available: ${auth.token === undefined ? "no" : "yes"}`);

  if (auth.token === undefined) {
    console.log("  github_api: unavailable");
    console.log("  next: set TEAMCTX_GITHUB_TOKEN, GITHUB_TOKEN, or authenticate gh");
    return;
  }

  let root: string;
  let repo: string;

  try {
    root = getRepoRoot();
    repo = normalizeGitHubRepo(getOriginRemote(root));
  } catch {
    console.log("  github_api: configured");
    console.log("  note: run from a bound git repository to check context store access");
    return;
  }

  let binding: ReturnType<typeof findBinding>;

  try {
    binding = findBinding(repo);
  } catch (error) {
    console.log("  github_api: configured");
    console.log(`  config: invalid (${error instanceof Error ? error.message : String(error)})`);
    return;
  }

  if (!binding) {
    console.log("  github_api: configured");
    console.log("  binding: missing");
    return;
  }

  console.log(`  store: ${binding.contextStore.repo}/${binding.contextStore.path}`);

  if (binding.contextStore.provider !== "github") {
    console.log("  github_api: not_required");
    return;
  }

  console.log("  github_api: configured");
  await reportStoreVisibility(binding.contextStore.repo, auth.token);
}

async function reportStoreVisibility(storeRepo: string, token: string | undefined): Promise<void> {
  if (token === undefined) {
    console.log("  store_visibility: unknown (no GitHub token available)");
    return;
  }

  let owner: string;
  let name: string;

  try {
    ({ owner, name } = parseGitHubRepository(storeRepo));
  } catch (error) {
    console.log(
      `  store_visibility: unknown (${error instanceof Error ? error.message : String(error)})`
    );
    return;
  }

  try {
    const client = new GitHubClient({ token });
    const response = (await client.requestJson("GET", `/repos/${owner}/${name}`)) as {
      private?: unknown;
    };
    const isPrivate = response.private === true;
    console.log(`  store_visibility: ${isPrivate ? "private" : "public"}`);

    if (!isPrivate && process.env.TEAMCTX_ALLOW_PUBLIC_STORE !== "1") {
      console.log("  warning: context store is public; set TEAMCTX_ALLOW_PUBLIC_STORE=1 to allow");
    }
  } catch (error) {
    console.log(
      `  store_visibility: unknown (${error instanceof Error ? error.message : String(error)})`
    );
  }
}

function packageVersion(): string {
  try {
    const path = fileURLToPath(new URL("../../package.json", import.meta.url));
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };

    return typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

function tools(args: ParsedArgs): void {
  if (args.flags.json === true) {
    console.log(JSON.stringify({ tools: toolDefinitions }, null, 2));
    return;
  }

  console.log(formatToolsReport(toolDefinitions));
}

export function formatToolsReport(
  tools: readonly Pick<ToolDefinition, "name" | "description">[]
): string {
  return tools.map((tool) => `${tool.name}: ${tool.description}`).join("\n");
}

function capabilities(args: ParsedArgs): void {
  let binding: ReturnType<typeof findBinding> | undefined;
  let repo: string | undefined;

  try {
    const root = getRepoRoot();
    repo = normalizeGitHubRepo(getOriginRemote(root));
    binding = findBinding(repo);
  } catch {
    binding = undefined;
  }

  const description = describeBindingCapabilities(binding, repo);

  if (args.flags.json === true) {
    console.log(JSON.stringify(description, null, 2));
    return;
  }

  console.log(formatCapabilitiesReport(description));
}

export function formatCapabilitiesReport(
  description: ReturnType<typeof describeBindingCapabilities>
): string {
  const lines = [
    `bound: ${description.bound}`,
    `store_kind: ${description.store_kind}`,
    `normalize_supported: ${description.normalize_supported}`,
    `background_jobs: ${description.background_jobs}`,
    "store:"
  ];

  for (const [key, value] of Object.entries(description.store)) {
    lines.push(`  ${key}: ${value}`);
  }

  return lines.join("\n");
}

export type CliCommandHandler = (args: ParsedArgs) => void | Promise<void>;

export const cliCommands: Record<string, CliCommandHandler> = {
  bind: (args) => bind(args),
  setup: (args) => setup(args),
  bootstrap: (args) => bootstrap(args),
  capture: (args) => capture(args),
  "init-store": (args) => initStore(args),
  normalize: (args) => normalize(args),
  compact: (args) => compact(args),
  context: (args) => context(args),
  "context-diff": (args) => contextDiff(args),
  "query-explain": (args) => queryExplain(args),
  rank: (args) => rank(args),
  list: (args) => list(args),
  hygiene: (args) => hygiene(args),
  "supersede-draft": (args) => supersedeDraft(args),
  audit: (args) => audit(args),
  "record-candidate": (args) => recordObservation(args, "candidate"),
  "record-verified": (args) => recordObservation(args, "verified"),
  "first-record": () => firstRecord(),
  show: (args) => show(args),
  explain: (args) => explain(args),
  "explain-episode": (args) => explainEpisode(args),
  invalidate: (args) => invalidate(args),
  status: (args) => status(args),
  doctor: () => doctor(),
  auth: (args) => runAuthSubcommand(args),
  tools: (args) => tools(args),
  capabilities: (args) => capabilities(args),
  help: () => printHelp(),
  "--help": () => printHelp(),
  "-h": () => printHelp()
};

function runAuthSubcommand(args: ParsedArgs): Promise<void> {
  if (args.positional[0] !== "doctor") {
    throw new CliError(CLI_EXIT.USAGE, "Unknown auth command. Usage: teamctx auth doctor");
  }

  return authDoctor();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (shouldPrintHelp(args)) {
    printHelp();
    return;
  }

  const handler = cliCommands[args.command];

  if (!handler) {
    throw new CliError(CLI_EXIT.USAGE, `Unknown command: ${args.command}`);
  }

  await handler(args);
}

if (isDirectCliRun()) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = mapErrorToExitCode(error);
  }
}

function isDirectCliRun(): boolean {
  return (
    process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  );
}
