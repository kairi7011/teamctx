import type { ContextStore } from "./types.js";

export function parseContextStore(input: string, path = ".teamctx", currentRepo?: string): ContextStore {
  const repo = input === "." ? currentRepo : input;

  if (!repo) {
    throw new Error("Cannot use '.' as context store outside a git repository with origin remote.");
  }

  return {
    provider: "github",
    repo: normalizeStoreRepo(repo),
    path
  };
}

function normalizeStoreRepo(repo: string): string {
  const trimmed = repo.trim().replace(/\.git$/, "");

  if (trimmed.startsWith("https://github.com/")) {
    return `github.com/${trimmed.slice("https://github.com/".length)}`;
  }

  if (trimmed.startsWith("git@github.com:")) {
    return `github.com/${trimmed.slice("git@github.com:".length)}`;
  }

  if (trimmed.startsWith("github.com/")) {
    return trimmed;
  }

  return `github.com/${trimmed}`;
}

