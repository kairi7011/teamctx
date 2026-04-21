#!/usr/bin/env node

import {
  getCurrentBranch,
  getHeadCommit,
  getOriginRemote,
  getRepoRoot
} from "../adapters/git/local-git.js";
import { normalizeGitHubRepo } from "../adapters/git/repo-url.js";
import { parseContextStore } from "../core/binding/context-store.js";
import { findBinding, getConfigPath, upsertBinding } from "../core/binding/local-bindings.js";
import { toolDefinitions } from "../mcp/tools/definitions.js";

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

function status(): void {
  const root = getRepoRoot();
  const repo = normalizeGitHubRepo(getOriginRemote(root));
  const binding = findBinding(repo);

  if (!binding) {
    console.log("teamctx disabled");
    console.log(`  repo: ${repo}`);
    console.log("  reason: no binding found");
    return;
  }

  console.log("teamctx enabled");
  console.log(`  repo: ${repo}`);
  console.log(`  root: ${root}`);
  console.log(`  branch: ${getCurrentBranch(root)}`);
  console.log(`  head: ${getHeadCommit(root)}`);
  console.log(`  store: ${binding.contextStore.repo}/${binding.contextStore.path}`);
}

function doctor(): void {
  console.log("teamctx doctor");
  console.log(`  config: ${getConfigPath()}`);

  try {
    const root = getRepoRoot();
    const repo = normalizeGitHubRepo(getOriginRemote(root));
    console.log("  git: ok");
    console.log(`  repo: ${repo}`);
    console.log(`  root: ${root}`);
    console.log(`  binding: ${findBinding(repo) ? "found" : "missing"}`);
  } catch (error) {
    console.log("  git: failed");
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
