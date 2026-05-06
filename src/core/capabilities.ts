import type { Binding } from "../schemas/types.js";

export type StoreCapabilities = {
  remote_writes: boolean;
  optimistic_concurrency: boolean;
  revision_tracking: boolean;
  append_only_jsonl: boolean;
  batch_writes: boolean;
  semantic_features: boolean;
};

export type BindingCapabilities = {
  bound: boolean;
  store_kind: "local" | "github" | "unbound";
  store: StoreCapabilities;
  normalize_supported: boolean;
  policy_config: boolean;
  background_jobs: boolean;
};

const NO_BINDING: BindingCapabilities = {
  bound: false,
  store_kind: "unbound",
  store: {
    remote_writes: false,
    optimistic_concurrency: false,
    revision_tracking: false,
    append_only_jsonl: false,
    batch_writes: false,
    semantic_features: false
  },
  normalize_supported: false,
  policy_config: false,
  background_jobs: false
};

export function describeBindingCapabilities(
  binding: Binding | undefined,
  repo: string | undefined
): BindingCapabilities {
  if (!binding) {
    return NO_BINDING;
  }

  const isRemoteGitHub = binding.contextStore.repo !== repo;

  return {
    bound: true,
    store_kind: isRemoteGitHub ? "github" : "local",
    store: isRemoteGitHub
      ? {
          remote_writes: true,
          optimistic_concurrency: true,
          revision_tracking: true,
          append_only_jsonl: true,
          batch_writes: false,
          semantic_features: false
        }
      : {
          remote_writes: false,
          optimistic_concurrency: false,
          revision_tracking: false,
          append_only_jsonl: true,
          batch_writes: false,
          semantic_features: false
        },
    normalize_supported: true,
    policy_config: true,
    background_jobs: false
  };
}
