import { normalizeStoreRepo } from "../../adapters/git/repo-url.js";
import type { ContextStore } from "../../schemas/types.js";

export function parseContextStore(
  input: string,
  path = ".teamctx",
  currentRepo?: string
): ContextStore {
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
