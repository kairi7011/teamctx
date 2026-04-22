import { createHash } from "node:crypto";
import {
  getCurrentBranch,
  getHeadCommit,
  getOriginRemote,
  getRepoRoot
} from "../../adapters/git/local-git.js";
import { normalizeGitHubRepo } from "../../adapters/git/repo-url.js";
import { findBinding } from "../../core/binding/local-bindings.js";
import {
  composeContextFromContextStore,
  composeContextFromStore,
  emptyComposedContext
} from "../../core/context/compose-context.js";
import {
  createContextStoreForBinding,
  type ContextStoreFactoryServices
} from "../../core/store/bound-store.js";
import { resolveStoreRoot } from "../../core/store/layout.js";
import {
  type ContextPayload,
  type EnabledContextPayload,
  type GetContextInput,
  validateGetContextInput
} from "../../schemas/context-payload.js";
import type { Binding } from "../../schemas/types.js";

const NORMALIZER_VERSION = "0.1.0";

export type GetContextServices = ContextStoreFactoryServices & {
  getRepoRoot: (cwd?: string) => string;
  getOriginRemote: (cwd?: string) => string;
  getCurrentBranch: (cwd?: string) => string;
  getHeadCommit: (cwd?: string) => string;
  findBinding: (repo: string) => Binding | undefined;
};

const defaultServices: GetContextServices = {
  getRepoRoot,
  getOriginRemote,
  getCurrentBranch,
  getHeadCommit,
  findBinding
};

export function getContextTool(
  rawInput: unknown,
  services: GetContextServices = defaultServices
): ContextPayload {
  const input = validateGetContextInput(rawInput);
  const repoState = readRepoState(input, services);

  if (!repoState) {
    return {
      enabled: false,
      reason: "No git repository with an origin remote found for this workspace."
    };
  }

  const binding = services.findBinding(repoState.repo);

  if (!binding) {
    return {
      enabled: false,
      reason: "No teamctx binding found for this git root."
    };
  }

  const context =
    binding.contextStore.repo === repoState.repo
      ? composeContextFromStore(resolveStoreRoot(repoState.root, binding.contextStore.path), input)
      : emptyComposedContext();
  const body: Omit<EnabledContextPayload, "enabled" | "identity"> = {
    ...context,
    write_policy: {
      record_observation_candidate: "allowed",
      record_observation_verified: "allowed_with_evidence",
      invalidate: "human_only",
      docs_evidence: "allowed_with_doc_role"
    }
  };
  const identityWithoutHash = {
    repo: repoState.repo,
    branch: repoState.branch,
    head_commit: repoState.headCommit,
    context_store: `${binding.contextStore.repo}/${binding.contextStore.path}`,
    store_head: null,
    normalizer_version: NORMALIZER_VERSION
  };

  return {
    enabled: true,
    identity: {
      ...identityWithoutHash,
      context_payload_hash: hashPayload({
        identity: identityWithoutHash,
        ...body
      })
    },
    ...body
  };
}

export async function getContextToolAsync(
  rawInput: unknown,
  services: GetContextServices = defaultServices
): Promise<ContextPayload> {
  const input = validateGetContextInput(rawInput);
  const repoState = readRepoState(input, services);

  if (!repoState) {
    return {
      enabled: false,
      reason: "No git repository with an origin remote found for this workspace."
    };
  }

  const binding = services.findBinding(repoState.repo);

  if (!binding) {
    return {
      enabled: false,
      reason: "No teamctx binding found for this git root."
    };
  }

  const store =
    binding.contextStore.repo === repoState.repo
      ? undefined
      : createContextStoreForBinding({
          repo: repoState.repo,
          repoRoot: repoState.root,
          binding,
          ...(services.createContextStore !== undefined
            ? { createContextStore: services.createContextStore }
            : {})
        });
  const context =
    binding.contextStore.repo === repoState.repo
      ? composeContextFromStore(resolveStoreRoot(repoState.root, binding.contextStore.path), input)
      : store
        ? await composeContextFromContextStore(store, input)
        : emptyComposedContext();
  const storeHead = store ? await store.getRevision() : null;
  const body: Omit<EnabledContextPayload, "enabled" | "identity"> = {
    ...context,
    write_policy: {
      record_observation_candidate: "allowed",
      record_observation_verified: "allowed_with_evidence",
      invalidate: "human_only",
      docs_evidence: "allowed_with_doc_role"
    }
  };
  const identityWithoutHash = {
    repo: repoState.repo,
    branch: repoState.branch,
    head_commit: repoState.headCommit,
    context_store: `${binding.contextStore.repo}/${binding.contextStore.path}`,
    store_head: storeHead,
    normalizer_version: NORMALIZER_VERSION
  };

  return {
    enabled: true,
    identity: {
      ...identityWithoutHash,
      context_payload_hash: hashPayload({
        identity: identityWithoutHash,
        ...body
      })
    },
    ...body
  };
}

function readRepoState(
  input: GetContextInput,
  services: GetContextServices
): { root: string; repo: string; branch: string; headCommit: string } | undefined {
  try {
    const root = services.getRepoRoot(input.cwd);
    const repo = normalizeGitHubRepo(services.getOriginRemote(root));

    return {
      root,
      repo,
      branch: input.branch ?? services.getCurrentBranch(root),
      headCommit: input.head_commit ?? services.getHeadCommit(root)
    };
  } catch {
    return undefined;
  }
}

function hashPayload(value: unknown): string {
  const hash = createHash("sha256").update(JSON.stringify(value)).digest("hex");

  return `sha256:${hash}`;
}
