#!/usr/bin/env node

import {
  getCurrentBranch,
  getHeadCommit,
  getOriginRemote,
  getRepoRoot
} from "../adapters/git/local-git.js";
import { normalizeGitHubRepo } from "../adapters/git/repo-url.js";
import { explainBoundItem, invalidateBoundItem } from "../core/audit/control.js";
import { parseContextStore } from "../core/binding/context-store.js";
import { findBinding, getConfigPath, upsertBinding } from "../core/binding/local-bindings.js";
import { normalizeBoundStore } from "../core/normalize/normalize.js";
import { getBoundStatus } from "../core/status/status.js";
import { initStoreLayout, resolveStoreRoot } from "../core/store/layout.js";
import { toolDefinitions } from "../mcp/tools/definitions.js";
import { createDefaultProjectConfig } from "../schemas/project.js";

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
  teamctx normalize
  teamctx explain <item-id>
  teamctx invalidate <item-id> [--reason <reason>]
  teamctx status
  teamctx doctor
  teamctx tools

Examples:
  teamctx bind github.com/my-org/ai-context --path contexts/my-service
  teamctx bind . --path .teamctx
`);
}

function bind(args: ParsedArgs): void {
  const [storeInput] = args.positional;

  if (!storeInput) {
    throw new Error("Missing context store. Usage: teamctx bind <store> [--path <path>]");
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

function initStore(): void {
  const root = getRepoRoot();
  const repo = normalizeGitHubRepo(getOriginRemote(root));
  const binding = findBinding(repo);

  if (!binding) {
    throw new Error("No teamctx binding found. Run: teamctx bind <store> --path <path>");
  }

  if (binding.contextStore.repo !== repo) {
    throw new Error("init-store currently supports context stores inside the current repository.");
  }

  const storeRoot = resolveStoreRoot(root, binding.contextStore.path);
  const result = initStoreLayout({
    root: storeRoot,
    projectConfig: createDefaultProjectConfig(repo)
  });

  console.log("Initialized context store:");
  console.log(`  root: ${result.root}`);
  console.log(`  created_files: ${result.createdFiles.length}`);
  console.log(`  existing_files: ${result.existingFiles.length}`);
}

function normalize(): void {
  const result = normalizeBoundStore();

  console.log("Normalized context store:");
  console.log(`  normalized_at: ${result.normalizedAt}`);
  console.log(`  raw_events_read: ${result.rawEventsRead}`);
  console.log(`  records_written: ${result.recordsWritten}`);
  console.log(`  dropped_events: ${result.droppedEvents}`);
  console.log(`  audit_entries_written: ${result.auditEntriesWritten}`);
}

function explain(args: ParsedArgs): void {
  const [itemId] = args.positional;

  if (!itemId) {
    throw new Error("Missing item id. Usage: teamctx explain <item-id>");
  }

  console.log(JSON.stringify(explainBoundItem({ itemId }), null, 2));
}

function invalidate(args: ParsedArgs): void {
  const [itemId] = args.positional;

  if (!itemId) {
    throw new Error("Missing item id. Usage: teamctx invalidate <item-id> [--reason <reason>]");
  }

  const reason = typeof args.flags.reason === "string" ? args.flags.reason : undefined;
  const result = invalidateBoundItem({
    itemId,
    ...(reason !== undefined ? { reason } : {})
  });

  console.log("Invalidated context item:");
  console.log(`  item_id: ${result.item_id}`);
  console.log(`  before_state: ${result.before_state}`);
  console.log(`  after_state: ${result.after_state}`);
}

function status(): void {
  const result = getBoundStatus();

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
        ? `${lastNormalize.normalizedAt} raw=${lastNormalize.rawEventsRead} promoted=${lastNormalize.recordsWritten} dropped=${lastNormalize.droppedEvents}`
        : "never"
    }`
  );
  printStatusList(
    "recent_promoted",
    summary.recent_promoted_items.map((item) => ({
      id: item.item_id,
      detail: item.record?.text ?? item.reason ?? "record not found"
    }))
  );
  printStatusList(
    "contested",
    summary.contested_items.map((item) => ({ id: item.item_id, detail: item.text }))
  );
  printStatusList(
    "dropped",
    summary.dropped_items.map((item) => ({
      id: item.source_event_ids.join(",") || "(unknown event)",
      detail: item.reason ?? "dropped"
    }))
  );
  printStatusList(
    "stale",
    summary.stale_items.map((item) => ({ id: item.item_id, detail: item.text }))
  );
}

function printStatusList(label: string, rows: Array<{ id: string; detail: string }>): void {
  console.log(`  ${label}: ${rows.length}`);

  for (const row of rows) {
    console.log(`    - ${row.id}: ${row.detail}`);
  }
}

function doctor(): void {
  console.log("teamctx doctor");
  console.log(`  config: ${getConfigPath()}`);

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

  try {
    const binding = findBinding(repo);

    if (binding) {
      console.log("  binding: found");
      console.log(`  store: ${binding.contextStore.repo}/${binding.contextStore.path}`);
    } else {
      console.log("  binding: missing");
      console.log("  next: teamctx bind <store> --path <path>");
    }
  } catch (error) {
    console.log("  config: invalid");
    console.log(`  reason: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function tools(): void {
  for (const tool of toolDefinitions) {
    console.log(`${tool.name}: ${tool.description}`);
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    case "bind":
      bind(args);
      return;
    case "init-store":
      initStore();
      return;
    case "normalize":
      normalize();
      return;
    case "explain":
      explain(args);
      return;
    case "invalidate":
      invalidate(args);
      return;
    case "status":
      status();
      return;
    case "doctor":
      doctor();
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
      throw new Error(`Unknown command: ${args.command}`);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
