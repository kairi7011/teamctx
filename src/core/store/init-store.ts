import type { ContextStoreAdapter } from "../../adapters/store/context-store.js";
import { getOriginRemote, getRepoRoot } from "../../adapters/git/local-git.js";
import { normalizeGitHubRepo } from "../../adapters/git/repo-url.js";
import { findBinding } from "../binding/local-bindings.js";
import { createContextStoreForBinding, type ContextStoreFactoryServices } from "./bound-store.js";
import {
  AUDIT_LOG_FILES,
  initStoreLayout,
  NORMALIZED_RECORD_FILES,
  resolveStoreRoot
} from "./layout.js";
import {
  createEmptyPathIndex,
  createEmptySymbolIndex,
  serializePathIndex,
  serializeSymbolIndex
} from "../indexes/record-index.js";
import { createDefaultProjectConfig, serializeProjectConfig } from "../../schemas/project.js";
import type { Binding } from "../../schemas/types.js";

export type InitStoreLayoutResult = {
  createdFiles: string[];
  existingFiles: string[];
};

export type InitBoundStoreResult = InitStoreLayoutResult & {
  store: string;
  localStore: boolean;
  root?: string;
};

export type InitStoreServices = ContextStoreFactoryServices & {
  getRepoRoot: (cwd?: string) => string;
  getOriginRemote: (cwd?: string) => string;
  findBinding: (repo: string) => Binding | undefined;
};

export type InitStoreOptions = {
  cwd?: string;
  overwrite?: boolean;
  services?: InitStoreServices;
};

const defaultServices: InitStoreServices = {
  getRepoRoot,
  getOriginRemote,
  findBinding
};

export async function initBoundStoreAsync(
  options: InitStoreOptions = {}
): Promise<InitBoundStoreResult> {
  const services = options.services ?? defaultServices;
  const root = services.getRepoRoot(options.cwd);
  const repo = normalizeGitHubRepo(services.getOriginRemote(root));
  const binding = services.findBinding(repo);

  if (!binding) {
    throw new Error("No teamctx binding found. Run: teamctx bind <store> --path <path>");
  }

  if (binding.contextStore.repo === repo) {
    const storeRoot = resolveStoreRoot(root, binding.contextStore.path);
    const result = initStoreLayout({
      root: storeRoot,
      projectConfig: createDefaultProjectConfig(repo),
      ...(options.overwrite !== undefined ? { overwrite: options.overwrite } : {})
    });

    return {
      store: `${binding.contextStore.repo}/${binding.contextStore.path}`,
      localStore: true,
      root: result.root,
      createdFiles: result.createdFiles,
      existingFiles: result.existingFiles
    };
  }

  const store =
    services.createContextStore?.({ repo, repoRoot: root, binding }) ??
    createContextStoreForBinding({ repo, repoRoot: root, binding });
  const result = await initContextStoreLayout({
    store,
    projectId: repo,
    ...(options.overwrite !== undefined ? { overwrite: options.overwrite } : {})
  });

  return {
    store: `${binding.contextStore.repo}/${binding.contextStore.path}`,
    localStore: false,
    createdFiles: result.createdFiles,
    existingFiles: result.existingFiles
  };
}

export async function initContextStoreLayout(options: {
  store: ContextStoreAdapter;
  projectId: string;
  overwrite?: boolean;
}): Promise<InitStoreLayoutResult> {
  const overwrite = options.overwrite === true;
  const createdFiles: string[] = [];
  const existingFiles: string[] = [];

  for (const file of storeLayoutFiles(options.projectId)) {
    const existing = await options.store.readText(file.path);

    if (existing && !overwrite) {
      existingFiles.push(file.path);
      continue;
    }

    await options.store.writeText(file.path, file.content, {
      message: `Initialize teamctx ${file.path}`,
      expectedRevision: existing?.revision ?? null
    });
    createdFiles.push(file.path);
  }

  return { createdFiles, existingFiles };
}

function storeLayoutFiles(projectId: string): Array<{ path: string; content: string }> {
  return [
    {
      path: "project.yaml",
      content: serializeProjectConfig(createDefaultProjectConfig(projectId))
    },
    ...NORMALIZED_RECORD_FILES.map((file) => ({
      path: `normalized/${file}`,
      content: ""
    })),
    ...AUDIT_LOG_FILES.map((file) => ({
      path: `audit/${file}`,
      content: ""
    })),
    {
      path: "indexes/path-index.json",
      content: serializePathIndex(createEmptyPathIndex())
    },
    {
      path: "indexes/symbol-index.json",
      content: serializeSymbolIndex(createEmptySymbolIndex())
    }
  ];
}
