import {
  getCurrentBranch,
  getHeadCommit,
  getOriginRemote,
  getRepoRoot
} from "../../adapters/git/local-git.js";
import { normalizeGitHubRepo } from "../../adapters/git/repo-url.js";
import { findBinding } from "../binding/local-bindings.js";
import { resolveStoreRoot } from "../store/layout.js";
import type { Binding } from "../../schemas/types.js";
import { summarizeContextStore, type StatusSummary } from "./summary.js";

export type BoundStatusServices = {
  getRepoRoot: (cwd?: string) => string;
  getOriginRemote: (cwd?: string) => string;
  getCurrentBranch: (cwd?: string) => string;
  getHeadCommit: (cwd?: string) => string;
  findBinding: (repo: string) => Binding | undefined;
};

export type BoundStatusOptions = {
  cwd?: string;
  recentLimit?: number;
  services?: BoundStatusServices;
};

export type DisabledBoundStatus = {
  enabled: false;
  reason: string;
  repo?: string;
  root?: string;
  branch?: string;
  head_commit?: string;
};

export type EnabledBoundStatus = {
  enabled: true;
  repo: string;
  root: string;
  branch: string;
  head_commit: string;
  context_store: string;
  local_store: boolean;
  summary: StatusSummary | null;
  summary_unavailable_reason?: string;
};

export type BoundStatus = DisabledBoundStatus | EnabledBoundStatus;

const defaultServices: BoundStatusServices = {
  getRepoRoot,
  getOriginRemote,
  getCurrentBranch,
  getHeadCommit,
  findBinding
};

export function getBoundStatus(options: BoundStatusOptions = {}): BoundStatus {
  const services = options.services ?? defaultServices;

  try {
    const root = services.getRepoRoot(options.cwd);
    const repo = normalizeGitHubRepo(services.getOriginRemote(root));
    const branch = services.getCurrentBranch(root);
    const headCommit = services.getHeadCommit(root);
    const binding = services.findBinding(repo);

    if (!binding) {
      return {
        enabled: false,
        reason: "No teamctx binding found for this git root.",
        repo,
        root,
        branch,
        head_commit: headCommit
      };
    }

    if (binding.contextStore.repo !== repo) {
      return {
        enabled: true,
        repo,
        root,
        branch,
        head_commit: headCommit,
        context_store: `${binding.contextStore.repo}/${binding.contextStore.path}`,
        local_store: false,
        summary: null,
        summary_unavailable_reason:
          "Status summaries currently support context stores inside the current repository."
      };
    }

    return {
      enabled: true,
      repo,
      root,
      branch,
      head_commit: headCommit,
      context_store: `${binding.contextStore.repo}/${binding.contextStore.path}`,
      local_store: true,
      summary: summarizeContextStore({
        storeRoot: resolveStoreRoot(root, binding.contextStore.path),
        ...(options.recentLimit !== undefined ? { recentLimit: options.recentLimit } : {})
      })
    };
  } catch {
    return {
      enabled: false,
      reason: "No git repository with an origin remote found for this workspace."
    };
  }
}
