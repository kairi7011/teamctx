export type Provider = "github";

export type ContextStore = {
  provider: Provider;
  repo: string;
  path: string;
};

export type Binding = {
  repo: string;
  root: string;
  contextStore: ContextStore;
  createdAt: string;
};

export type BindingsFile = {
  version: 1;
  bindings: Record<string, Binding>;
};

export type ContextRequest = {
  cwd?: string;
  targetFiles?: string[];
  changedFiles?: string[];
  branch?: string;
  headCommit?: string;
};

export type ContextIdentity = {
  repo: string;
  branch?: string;
  headCommit?: string;
  dirtyWorktree?: boolean;
  contextStore: string;
  storeHead?: string;
  normalizerVersion?: string;
  contextPayloadHash?: string;
};

export type ToolDefinition = {
  name: string;
  description: string;
};

