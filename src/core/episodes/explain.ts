import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ContextStoreAdapter } from "../../adapters/store/context-store.js";
import { getOriginRemote, getRepoRoot } from "../../adapters/git/local-git.js";
import { normalizeGitHubRepo } from "../../adapters/git/repo-url.js";
import { findBinding } from "../binding/local-bindings.js";
import { bindingMissingError } from "../errors.js";
import {
  createContextStoreForBinding,
  type ContextStoreFactoryServices
} from "../store/bound-store.js";
import { resolveStoreRoot } from "../store/layout.js";
import { validateEpisodeIndex } from "../indexes/episode-index.js";
import type { EpisodeReference } from "../../schemas/episode.js";
import type { Binding } from "../../schemas/types.js";

export type ExplainEpisodeResult =
  | {
      found: true;
      episode: EpisodeReference;
    }
  | {
      found: false;
      episode_id: string;
      reason: string;
    };

export type ExplainEpisodeServices = ContextStoreFactoryServices & {
  getRepoRoot: (cwd?: string) => string;
  getOriginRemote: (cwd?: string) => string;
  findBinding: (repo: string) => Binding | undefined;
};

export type ExplainBoundEpisodeOptions = {
  episodeId: string;
  cwd?: string;
  services?: ExplainEpisodeServices;
};

const defaultServices: ExplainEpisodeServices = {
  getRepoRoot,
  getOriginRemote,
  findBinding
};

export function explainEpisode(options: {
  storeRoot: string;
  episodeId: string;
}): ExplainEpisodeResult {
  return explainEpisodeFromIndex(readEpisodeIndex(options.storeRoot), options.episodeId);
}

export async function explainEpisodeFromContextStore(options: {
  store: ContextStoreAdapter;
  episodeId: string;
}): Promise<ExplainEpisodeResult> {
  try {
    const file = await options.store.readText("indexes/episode-index.json");
    const index = file ? validateEpisodeIndex(JSON.parse(file.content) as unknown) : undefined;

    return explainEpisodeFromIndex(index, options.episodeId);
  } catch {
    return explainEpisodeFromIndex(undefined, options.episodeId);
  }
}

export async function explainBoundEpisodeAsync(
  options: ExplainBoundEpisodeOptions
): Promise<ExplainEpisodeResult> {
  const services = options.services ?? defaultServices;
  const root = services.getRepoRoot(options.cwd);
  const repo = normalizeGitHubRepo(services.getOriginRemote(root));
  const binding = services.findBinding(repo);

  if (!binding) {
    throw bindingMissingError();
  }

  if (binding.contextStore.repo === repo) {
    return explainEpisode({
      storeRoot: resolveStoreRoot(root, binding.contextStore.path),
      episodeId: options.episodeId
    });
  }

  const store =
    services.createContextStore?.({ repo, repoRoot: root, binding }) ??
    createContextStoreForBinding({ repo, repoRoot: root, binding });

  return explainEpisodeFromContextStore({ store, episodeId: options.episodeId });
}

function explainEpisodeFromIndex(
  index: ReturnType<typeof readEpisodeIndex>,
  episodeId: string
): ExplainEpisodeResult {
  if (!index) {
    return {
      found: false,
      episode_id: episodeId,
      reason: "episode index is missing or invalid"
    };
  }

  const episode = index.episodes.find((item) => item.episode_id === episodeId);

  if (!episode) {
    return {
      found: false,
      episode_id: episodeId,
      reason: "episode not found"
    };
  }

  return { found: true, episode };
}

function readEpisodeIndex(storeRoot: string): ReturnType<typeof validateEpisodeIndex> | undefined {
  try {
    return validateEpisodeIndex(
      JSON.parse(readFileSync(join(storeRoot, "indexes", "episode-index.json"), "utf8")) as unknown
    );
  } catch {
    return undefined;
  }
}
