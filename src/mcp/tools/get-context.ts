import { sha256Hex } from "../../core/store/hash.js";
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
import { WRITE_POLICY } from "../../core/policy/write-policy.js";
import {
  createContextStoreForBinding,
  type ContextStoreFactoryServices
} from "../../core/store/bound-store.js";
import { resolveStoreRoot } from "../../core/store/layout.js";
import {
  type ContextPayload,
  type EnabledContextPayload,
  type GetContextCallReason,
  type GetContextInput,
  validateGetContextInput
} from "../../schemas/context-payload.js";
import type { Binding } from "../../schemas/types.js";

const NORMALIZER_VERSION = "0.1.0";

type ContextPayloadBody = Omit<
  EnabledContextPayload,
  "enabled" | "identity" | "context_unchanged" | "delivery_policy"
>;

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
  const body: ContextPayloadBody = {
    ...context,
    write_policy: { ...WRITE_POLICY }
  };
  const identityWithoutHash = {
    repo: repoState.repo,
    branch: repoState.branch,
    head_commit: repoState.headCommit,
    context_store: `${binding.contextStore.repo}/${binding.contextStore.path}`,
    store_head: null,
    normalizer_version: NORMALIZER_VERSION
  };

  return enabledPayload(input, identityWithoutHash, body);
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
  const body: ContextPayloadBody = {
    ...context,
    write_policy: { ...WRITE_POLICY }
  };
  const identityWithoutHash = {
    repo: repoState.repo,
    branch: repoState.branch,
    head_commit: repoState.headCommit,
    context_store: `${binding.contextStore.repo}/${binding.contextStore.path}`,
    store_head: storeHead,
    normalizer_version: NORMALIZER_VERSION
  };

  return enabledPayload(input, identityWithoutHash, body);
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
  return `sha256:${sha256Hex(JSON.stringify(value))}`;
}

function enabledPayload(
  input: GetContextInput,
  identityWithoutHash: Omit<EnabledContextPayload["identity"], "context_payload_hash">,
  body: ContextPayloadBody
): EnabledContextPayload {
  const contextPayloadHash = hashPayload({
    identity: identityWithoutHash,
    ...body
  });
  const policy = deliveryPolicy(input, contextPayloadHash);

  if (!policy.should_inject) {
    return {
      enabled: true,
      context_unchanged: true,
      identity: {
        ...identityWithoutHash,
        context_payload_hash: contextPayloadHash
      },
      delivery_policy: policy,
      ...emptyComposedContext(),
      write_policy: { ...WRITE_POLICY }
    };
  }

  return {
    enabled: true,
    context_unchanged: false,
    identity: {
      ...identityWithoutHash,
      context_payload_hash: contextPayloadHash
    },
    delivery_policy: policy,
    ...body
  };
}

function deliveryPolicy(
  input: GetContextInput,
  contextPayloadHash: string
): EnabledContextPayload["delivery_policy"] {
  const callReason = input.call_reason ?? "task_start";
  const forceRefresh = input.force_refresh === true;
  const unchangedFromPrevious =
    input.previous_context_payload_hash !== undefined &&
    input.previous_context_payload_hash === contextPayloadHash;
  const shouldInject = shouldInjectContext(callReason, forceRefresh, unchangedFromPrevious);

  return {
    default_policy: "call_at_session_start_then_refresh_only_on_explicit_request_or_context_change",
    call_reason: callReason,
    session_start_required: true,
    explicit_refresh_allowed: true,
    force_refresh: forceRefresh,
    ...(input.previous_context_payload_hash !== undefined
      ? { previous_context_payload_hash: input.previous_context_payload_hash }
      : {}),
    unchanged_from_previous: unchangedFromPrevious,
    should_inject: shouldInject,
    reason: deliveryReason(callReason, forceRefresh, unchangedFromPrevious, shouldInject),
    refresh_triggers: [
      "new_session_start",
      "explicit_user_request",
      "target_files_changed",
      "changed_files_changed",
      "branch_or_head_commit_changed",
      "context_store_head_changed"
    ]
  };
}

function shouldInjectContext(
  callReason: GetContextCallReason,
  forceRefresh: boolean,
  unchangedFromPrevious: boolean
): boolean {
  if (forceRefresh || callReason === "session_start" || callReason === "explicit_user_request") {
    return true;
  }

  return !unchangedFromPrevious;
}

function deliveryReason(
  callReason: GetContextCallReason,
  forceRefresh: boolean,
  unchangedFromPrevious: boolean,
  shouldInject: boolean
): string {
  if (forceRefresh) {
    return "force_refresh requested; return full context.";
  }

  if (callReason === "session_start") {
    return "session_start calls must inject full context for the new agent session.";
  }

  if (callReason === "explicit_user_request") {
    return "explicit user request; return full context even if the hash is unchanged.";
  }

  if (!shouldInject && unchangedFromPrevious) {
    return "previous_context_payload_hash matches; skip reinjecting unchanged context.";
  }

  return "context hash changed or no previous hash was provided; return context.";
}
