import { getContextTool, type GetContextServices } from "./get-context.js";

export function statusTool(rawInput: unknown, services?: GetContextServices): unknown {
  const context = getContextTool(rawInput, services);

  if (!context.enabled) {
    return context;
  }

  return {
    enabled: true,
    repo: context.identity.repo,
    branch: context.identity.branch,
    head_commit: context.identity.head_commit,
    context_store: context.identity.context_store,
    store_head: context.identity.store_head,
    normalizer_version: context.identity.normalizer_version
  };
}
