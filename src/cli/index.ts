#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  describeGitHubAuth,
  GitHubClient,
  parseGitHubRepository
} from "../adapters/github/github-client.js";
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
import { explainBoundEpisodeAsync } from "../core/episodes/explain.js";
import {
  listBoundRecords,
  parseListKinds,
  parseListStates,
  type ListRecordsInput
} from "../core/list/records.js";
import { normalizeBoundStoreAsync } from "../core/normalize/normalize.js";
import { compactBoundStoreAsync } from "../core/retention/compact.js";
import { getBoundStatusAsync } from "../core/status/status.js";
import { initBoundStoreAsync } from "../core/store/init-store.js";
import { getContextToolAsync } from "../mcp/tools/get-context.js";
import {
  recordObservationCandidateToolAsync,
  recordObservationVerifiedToolAsync
} from "../mcp/tools/record-observation.js";
import { toolDefinitions } from "../mcp/tools/definitions.js";
import type { GetContextInput } from "../schemas/context-payload.js";

type ParsedArgs = {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
};

function parseArgs(argv: string[]): ParsedArgs {
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

function printHelp(): void {
  console.log(`teamctx

Usage:
  teamctx bind <store> [--path <path>]
  teamctx init-store
  teamctx normalize [--dry-run]
  teamctx compact
  teamctx context [json-file]
  teamctx list [--kind <kind>] [--state <state>] [--limit <n>] [--offset <n>]
  teamctx audit [--action <action>] [--limit <n>] [--offset <n>]
  teamctx record-candidate <json-file>
  teamctx record-verified <json-file>
  teamctx explain <item-id>
  teamctx explain-episode <episode-id>
  teamctx invalidate <item-id> [--reason <reason>]
  teamctx status
  teamctx doctor
  teamctx tools

Examples:
  teamctx bind github.com/my-org/ai-context --path contexts/my-service
  teamctx bind . --path .teamctx
  teamctx context --target-files src/index.ts --domains cli
  teamctx list --state active --domains cli --limit 20
  teamctx audit --action created --limit 20
  teamctx record-verified observations.json
`);
}

function bind(args: ParsedArgs): void {
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
  const binding = upsertBinding(repo, root, contextStore);

  console.log("Bound repository:");
  console.log(`  repo: ${binding.repo}`);
  console.log(`  root: ${binding.root}`);
  console.log(`  store: ${binding.contextStore.repo}/${binding.contextStore.path}`);
}

async function initStore(): Promise<void> {
  const result = await initBoundStoreAsync();

  console.log("Initialized context store:");
  console.log(`  store: ${result.store}`);
  console.log(`  local_store: ${result.localStore}`);
  if (result.root !== undefined) {
    console.log(`  root: ${result.root}`);
  }
  console.log(`  created_files: ${result.createdFiles.length}`);
  console.log(`  existing_files: ${result.existingFiles.length}`);
}

async function normalize(args: ParsedArgs): Promise<void> {
  const dryRun = args.flags["dry-run"] === true;
  const result = await normalizeBoundStoreAsync(dryRun ? { dryRun: true } : {});

  console.log(dryRun ? "Normalized context store (dry-run):" : "Normalized context store:");
  console.log(`  run_id: ${result.runId}`);
  console.log(`  normalized_at: ${result.normalizedAt}`);
  console.log(`  raw_events_read: ${result.rawEventsRead}`);
  console.log(`  records_written: ${result.recordsWritten}`);
  console.log(`  dropped_events: ${result.droppedEvents}`);
  console.log(`  audit_entries_written: ${result.auditEntriesWritten}`);
  if (dryRun) {
    console.log("  note: no files were written; rerun without --dry-run to apply");
  }
}

async function compact(): Promise<void> {
  const result = await compactBoundStoreAsync();

  console.log("Compacted context store:");
  console.log(`  compacted_at: ${result.compactedAt}`);
  console.log(`  archive_root: ${result.archiveRoot}`);
  console.log(`  raw_candidate_events_archived: ${result.rawCandidateEventsArchived}`);
  console.log(`  raw_events_retained: ${result.rawEventsRetained}`);
  console.log(`  audit_entries_archived: ${result.auditEntriesArchived}`);
  console.log(`  audit_entries_retained: ${result.auditEntriesRetained}`);
  console.log(`  archived_records_archived: ${result.archivedRecordsArchived}`);
  console.log(`  normalized_records_retained: ${result.normalizedRecordsRetained}`);
}

async function context(args: ParsedArgs): Promise<void> {
  console.log(JSON.stringify(await getContextToolAsync(contextInput(args)), null, 2));
}

async function list(args: ParsedArgs): Promise<void> {
  const limit = typeof args.flags.limit === "string" ? Number(args.flags.limit) : undefined;
  const offset = typeof args.flags.offset === "string" ? Number(args.flags.offset) : undefined;
  const input: ListRecordsInput = {};

  assignListInput(input, "kinds", parseListKinds(csvFlag(args.flags.kind ?? args.flags.kinds)));
  assignListInput(input, "states", parseListStates(csvFlag(args.flags.state ?? args.flags.states)));
  assignListInput(input, "paths", csvFlag(args.flags.path ?? args.flags.paths));
  assignListInput(input, "domains", csvFlag(args.flags.domain ?? args.flags.domains));
  assignListInput(input, "symbols", csvFlag(args.flags.symbol ?? args.flags.symbols));
  assignListInput(input, "tags", csvFlag(args.flags.tag ?? args.flags.tags));

  if (typeof args.flags.query === "string") {
    input.query = args.flags.query;
  }
  if (limit !== undefined) {
    input.limit = limit;
  }
  if (offset !== undefined) {
    input.offset = offset;
  }

  console.log(JSON.stringify(await listBoundRecords(input), null, 2));
}

async function audit(args: ParsedArgs): Promise<void> {
  const limit = typeof args.flags.limit === "string" ? Number(args.flags.limit) : undefined;
  const offset = typeof args.flags.offset === "string" ? Number(args.flags.offset) : undefined;
  const input: AuditSummaryInput = {};

  assignAuditInput(
    input,
    "actions",
    parseAuditActions(csvFlag(args.flags.action ?? args.flags.actions))
  );
  assignAuditInput(input, "item_ids", csvFlag(args.flags.item ?? args.flags.items));
  assignAuditInput(
    input,
    "source_event_ids",
    csvFlag(args.flags["source-event"] ?? args.flags["source-events"])
  );

  if (typeof args.flags.query === "string") {
    input.query = args.flags.query;
  }
  if (limit !== undefined) {
    input.limit = limit;
  }
  if (offset !== undefined) {
    input.offset = offset;
  }

  console.log(JSON.stringify(await getBoundAuditSummary(input), null, 2));
}

function assignAuditInput<T extends keyof AuditSummaryInput>(
  input: AuditSummaryInput,
  key: T,
  value: AuditSummaryInput[T] | undefined
): void {
  if (value !== undefined) {
    Object.assign(input, { [key]: value });
  }
}

function assignListInput<T extends keyof ListRecordsInput>(
  input: ListRecordsInput,
  key: T,
  value: ListRecordsInput[T] | undefined
): void {
  if (value !== undefined) {
    Object.assign(input, { [key]: value });
  }
}

function contextInput(args: ParsedArgs): GetContextInput {
  const [inputPath] = args.positional;

  if (inputPath) {
    return JSON.parse(readFileSync(resolve(inputPath), "utf8")) as GetContextInput;
  }

  const input: GetContextInput = {};

  assignCsvFlag(input, "target_files", args.flags["target-files"]);
  assignCsvFlag(input, "changed_files", args.flags["changed-files"]);
  assignCsvFlag(input, "domains", args.flags.domains);
  assignCsvFlag(input, "symbols", args.flags.symbols);
  assignCsvFlag(input, "tags", args.flags.tags);
  assignCsvFlag(input, "source_types", args.flags["source-types"]);
  assignCsvFlag(input, "evidence_files", args.flags["evidence-files"]);
  assignStringFlag(input, "query", args.flags.query);
  assignStringFlag(input, "since", args.flags.since);
  assignStringFlag(input, "until", args.flags.until);
  assignStringFlag(input, "branch", args.flags.branch);
  assignStringFlag(input, "head_commit", args.flags["head-commit"]);

  return input;
}

function csvFlag(value: string | boolean | undefined): string[] | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function assignCsvFlag<T extends keyof GetContextInput>(
  input: GetContextInput,
  key: T,
  value: string | boolean | undefined
): void {
  if (typeof value !== "string") {
    return;
  }

  const values = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  if (values.length > 0) {
    Object.assign(input, { [key]: values });
  }
}

function assignStringFlag<T extends keyof GetContextInput>(
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

  console.log(`Recorded ${trust} raw observations:`);

  for (const [index, observation] of observations.entries()) {
    const result =
      trust === "verified"
        ? await recordObservationVerifiedToolAsync(observation)
        : await recordObservationCandidateToolAsync(observation);

    console.log(`  - ${index + 1}: ${result.relative_path}`);

    for (const finding of result.findings) {
      console.log(
        `      ${finding.severity}: ${finding.kind} in ${finding.field} ${finding.excerpt}`
      );
    }
  }

  console.log(`  count: ${observations.length}`);
}

async function explain(args: ParsedArgs): Promise<void> {
  const [itemId] = args.positional;

  if (!itemId) {
    throw new CliError(CLI_EXIT.USAGE, "Missing item id. Usage: teamctx explain <item-id>");
  }

  console.log(JSON.stringify(await explainBoundItemAsync({ itemId }), null, 2));
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

  console.log("Invalidated context item:");
  console.log(`  item_id: ${result.item_id}`);
  console.log(`  before_state: ${result.before_state}`);
  console.log(`  after_state: ${result.after_state}`);
}

async function status(): Promise<void> {
  const result = await getBoundStatusAsync();

  if (!result.enabled) {
    console.log("teamctx disabled");
    if (result.repo !== undefined) {
      console.log(`  repo: ${result.repo}`);
    }
    console.log(`  reason: ${result.reason}`);
    return;
  }

  console.log("teamctx enabled");
  console.log(`  repo: ${result.repo}`);
  console.log(`  root: ${result.root}`);
  console.log(`  branch: ${result.branch}`);
  console.log(`  head: ${result.head_commit}`);
  console.log(`  store: ${result.context_store}`);

  if (!result.summary) {
    console.log(`  summary: ${result.summary_unavailable_reason ?? "unavailable"}`);
    return;
  }

  const { summary } = result;
  const lastNormalize = summary.last_normalize_result;

  console.log(
    `  records: active=${summary.counts.active_records} contested=${summary.counts.contested_records} stale=${summary.counts.stale_records} archived=${summary.counts.archived_records}`
  );
  console.log(
    `  last_normalize: ${
      lastNormalize
        ? `${lastNormalize.normalizedAt} run=${lastNormalize.runId} raw=${lastNormalize.rawEventsRead} promoted=${lastNormalize.recordsWritten} dropped=${lastNormalize.droppedEvents}`
        : "never"
    }`
  );
  printStatusList(
    "recent_promoted",
    summary.recent_promoted_items.map((item) => ({
      id: item.item_id,
      detail: item.record?.text ?? item.reason ?? "record not found"
    })),
    summary.counts.promoted_records
  );
  printStatusList(
    "contested",
    summary.contested_items.map((item) => ({
      id: item.item_id,
      detail: contestedStatusDetail(item)
    })),
    summary.counts.contested_records
  );
  printStatusList(
    "dropped",
    summary.dropped_items.map((item) => ({
      id: item.source_event_ids.join(",") || "(unknown event)",
      detail: item.reason ?? "dropped"
    })),
    summary.counts.dropped_events
  );
  printStatusList(
    "stale",
    summary.stale_items.map((item) => ({ id: item.item_id, detail: item.text })),
    summary.counts.stale_records
  );
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

function printStatusList(
  label: string,
  rows: Array<{ id: string; detail: string }>,
  total = rows.length
): void {
  const visibleCount =
    rows.length === total ? String(rows.length) : `${rows.length} of ${total} shown`;

  console.log(`  ${label}: ${visibleCount}`);

  for (const row of rows) {
    console.log(`    - ${row.id}: ${row.detail}`);
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

function tools(): void {
  for (const tool of toolDefinitions) {
    console.log(`${tool.name}: ${tool.description}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    case "bind":
      bind(args);
      return;
    case "init-store":
      await initStore();
      return;
    case "normalize":
      await normalize(args);
      return;
    case "compact":
      await compact();
      return;
    case "context":
      await context(args);
      return;
    case "list":
      await list(args);
      return;
    case "audit":
      await audit(args);
      return;
    case "record-candidate":
      await recordObservation(args, "candidate");
      return;
    case "record-verified":
      await recordObservation(args, "verified");
      return;
    case "explain":
      await explain(args);
      return;
    case "explain-episode":
      await explainEpisode(args);
      return;
    case "invalidate":
      await invalidate(args);
      return;
    case "status":
      await status();
      return;
    case "doctor":
      await doctor();
      return;
    case "tools":
      tools();
      return;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    default:
      throw new CliError(CLI_EXIT.USAGE, `Unknown command: ${args.command}`);
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = mapErrorToExitCode(error);
}
