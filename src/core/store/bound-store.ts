import { GitHubContentsStore } from "../../adapters/github/contents-store.js";
import { LocalContextStore } from "../../adapters/store/local-store.js";
import type { ContextStoreAdapter } from "../../adapters/store/context-store.js";
import type { Binding } from "../../schemas/types.js";
import { resolveStoreRoot } from "./layout.js";

export type ContextStoreFactoryOptions = {
  repo: string;
  repoRoot: string;
  binding: Binding;
};

export type ContextStoreFactory = (options: ContextStoreFactoryOptions) => ContextStoreAdapter;

export type ContextStoreFactoryServices = {
  createContextStore?: ContextStoreFactory;
};

export function createContextStoreForBinding(
  options: ContextStoreFactoryOptions & ContextStoreFactoryServices
): ContextStoreAdapter {
  if (options.createContextStore) {
    return options.createContextStore({
      repo: options.repo,
      repoRoot: options.repoRoot,
      binding: options.binding
    });
  }

  if (options.binding.contextStore.repo === options.repo) {
    return new LocalContextStore(
      resolveStoreRoot(options.repoRoot, options.binding.contextStore.path)
    );
  }

  return new GitHubContentsStore({
    repository: options.binding.contextStore.repo,
    storePath: options.binding.contextStore.path
  });
}
