#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  describeGitHubAuth,
  GitHubClient,
  parseGitHubRepository
} from "../adapters/github/github-client.js";
import { assignDefined, parseCsvFlag, parseLimitFlag, parseOffsetFlag } from "./cli-args.js";
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
  getBoundAuditSummary,
  parseAuditActions,
  type AuditSummaryInput
} from "../core/audit/summary.js";
import { parseContextStore } from "../core/binding/context-store.js";
import { findBinding, getConfigPath, upsertBinding } from "../core/binding/local-bindings.js";
import { describeBindingCapabilities } from "../core/capabilities.js";
import { explainBoundEpisodeAsync } from "../core/episodes/explain.js";
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
import { diffContextPayloads } from "../core/context/context-diff.js";
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
  recordObservationCandidateToolAsync,
  recordObservationVerifiedToolAsync,
  type RecordObservationToolResult
} from "../mcp/tools/record-observation.js";
import { toolDefinitions } from "../mcp/tools/definitions.js";
import { validateGetContextInput, type GetContextInput } from "../schemas/context-payload.js";
import type { Binding } from "../schemas/types.js";

export type ParsedArgs = {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
};

export function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];

    if (value?.startsWith("--")) {
      const key = value.slice(2);
      const next = rest[index + 1];

      if (next && !next.startsWith("--")) {
        flags[key] = next;
        index += 1;
      } else {
        flags[key] = true;
      }
    } else if (value) {
      positional.push(value);
    }
  }

  return { command, positional, flags };
}

export function formatHelp(): string {
  return `teamctx

Usage:
  teamctx bind <store> [--path <path>]
  teamctx setup <store> [--path <path>] [--json]
  teamctx init-store [--json]
  teamctx normalize [--dry-run] [--lease] [--json]
  teamctx compact [--dry-run] [--json]
  teamctx context [json-file]
  teamctx context-diff <left-json> <right-json>
  teamctx query-explain [json-file]
  teamctx rank [--target-files <files>] [--domains <domains>] [--symbols <symbols>] [--tags <tags>] [--query <query>]
  teamctx list [--kind <kind>] [--state <state>] [--limit <n>] [--offset <n>]
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
  teamctx bind . --path .teamctx
  teamctx context --target-files src/index.ts --domains cli
  teamctx context-diff before.json after.json
  teamctx query-explain --target-files src/index.ts --domains cli
  teamctx rank --target-files src/index.ts --domains cli
  teamctx list --state active --domains cli --limit 20
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

  console.log("Bound repository:");
  console.log(`  repo: ${binding.repo}`);
  console.log(`  root: ${binding.root}`);
  console.log(`  store: ${binding.contextStore.repo}/${binding.contextStore.path}`);
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
  "teamctx record-verified observations.json",
  "teamctx normalize",
  "teamctx context --target-files <file>"
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
      "Missing input files. Usage: teamctx context-diff <left-json> <right-json>"
    );
  }

  const leftInput = readContextInputFile(leftPath);
  const rightInput = readContextInputFile(rightPath);
  const left = await getContextToolAsync(leftInput);
  const right = await getContextToolAsync(rightInput);

  console.log(JSON.stringify(diffContextPayloads(left, right, leftInput, rightInput), null, 2));
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

  assignDefined(input, "kinds", parseListKinds(parseCsvFlag(args.flags.kind ?? args.flags.kinds)));
  assignDefined(
    input,
    "states",
    parseListStates(parseCsvFlag(args.flags.state ?? args.flags.states))
  );
  assignDefined(input, "paths", parseCsvFlag(args.flags.path ?? args.flags.paths));
  assignDefined(input, "domains", parseCsvFlag(args.flags.domain ?? args.flags.domains));
  assignDefined(input, "symbols", parseCsvFlag(args.flags.symbol ?? args.flags.symbols));
  assignDefined(input, "tags", parseCsvFlag(args.flags.tag ?? args.flags.tags));

  if (typeof args.flags.query === "string") {
    input.query = args.flags.query;
  }
  assignDefined(input, "limit", parseLimitFlag(args.flags.limit));
  assignDefined(input, "offset", parseOffsetFlag(args.flags.offset));

  console.log(JSON.stringify(await listBoundRecords(input), null, 2));
}

async function audit(args: ParsedArgs): Promise<void> {
  const input: AuditSummaryInput = {};

  assignDefined(
    input,
    "actions",
    parseAuditActions(parseCsvFlag(args.flags.action ?? args.flags.actions))
  );
  assignDefined(input, "item_ids", parseCsvFlag(args.flags.item ?? args.flags.items));
  assignDefined(
    input,
    "source_event_ids",
    parseCsvFlag(args.flags["source-event"] ?? args.flags["source-events"])
  );

  if (typeof args.flags.query === "string") {
    input.query = args.flags.query;
  }
  assignDefined(input, "limit", parseLimitFlag(args.flags.limit));
  assignDefined(input, "offset", parseOffsetFlag(args.flags.offset));

  console.log(JSON.stringify(await getBoundAuditSummary(input), null, 2));
}

function contextInput(args: ParsedArgs): GetContextInput {
  const [inputPath] = args.positional;

  if (inputPath) {
    return readContextInputFile(inputPath);
  }

  const input: GetContextInput = {};

  assignCsv(input, "target_files", args.flags["target-files"]);
  assignCsv(input, "changed_files", args.flags["changed-files"]);
  assignCsv(input, "domains", args.flags.domains);
  assignCsv(input, "symbols", args.flags.symbols);
  assignCsv(input, "tags", args.flags.tags);
  assignCsv(input, "source_types", args.flags["source-types"]);
  assignCsv(input, "evidence_files", args.flags["evidence-files"]);
  assignString(input, "query", args.flags.query);
  assignString(input, "since", args.flags.since);
  assignString(input, "until", args.flags.until);
  assignString(input, "branch", args.flags.branch);
  assignString(input, "head_commit", args.flags["head-commit"]);

  return input;
}

function readContextInputFile(path: string): GetContextInput {
  return validateGetContextInput(JSON.parse(readFileSync(resolve(path), "utf8")) as unknown);
}

function assignCsv<T extends keyof GetContextInput>(
  input: GetContextInput,
  key: T,
  value: string | boolean | undefined
): void {
  const values = parseCsvFlag(value);

  if (values !== undefined && values.length > 0) {
    Object.assign(input, { [key]: values });
  }
}

function assignString<T extends keyof GetContextInput>(
  input: GetContextInput,
  key: T,
  value: string | boolean | undefined
): void {
  if (typeof value === "string") {
    Object.assign(input, { [key]: value });
  }
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
  const observations = Array.isArray(input) ? input : [input];

  if (observations.length === 0) {
    throw new CliError(
      CLI_EXIT.VALIDATION,
      "Observation json file must contain an object or a non-empty array."
    );
  }

  const results: Array<{ index: number; result: RecordObservationToolResult }> = [];

  for (const [index, observation] of observations.entries()) {
    const result =
      trust === "verified"
        ? await recordObservationVerifiedToolAsync(observation)
        : await recordObservationCandidateToolAsync(observation);

    results.push({ index: index + 1, result });
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

  for (const tool of toolDefinitions) {
    console.log(`${tool.name}: ${tool.description}`);
  }
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

  console.log(`bound: ${description.bound}`);
  console.log(`store_kind: ${description.store_kind}`);
  console.log(`normalize_supported: ${description.normalize_supported}`);
  console.log(`background_jobs: ${description.background_jobs}`);
  console.log("store:");
  for (const [key, value] of Object.entries(description.store)) {
    console.log(`  ${key}: ${value}`);
  }
}

export type CliCommandHandler = (args: ParsedArgs) => void | Promise<void>;

export const cliCommands: Record<string, CliCommandHandler> = {
  bind: (args) => bind(args),
  setup: (args) => setup(args),
  "init-store": (args) => initStore(args),
  normalize: (args) => normalize(args),
  compact: (args) => compact(args),
  context: (args) => context(args),
  "context-diff": (args) => contextDiff(args),
  "query-explain": (args) => queryExplain(args),
  rank: (args) => rank(args),
  list: (args) => list(args),
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
