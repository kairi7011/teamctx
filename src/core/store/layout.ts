import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { serializeProjectConfig, type ProjectConfig } from "../../schemas/project.js";
import {
  createEmptyPathIndex,
  createEmptySymbolIndex,
  serializePathIndex,
  serializeSymbolIndex
} from "../indexes/record-index.js";
import { createEmptyEpisodeIndex, serializeEpisodeIndex } from "../indexes/episode-index.js";

export const NORMALIZED_RECORD_FILES = [
  "facts.jsonl",
  "rules.jsonl",
  "pitfalls.jsonl",
  "decisions.jsonl",
  "workflows.jsonl",
  "glossary.jsonl"
] as const;

export const AUDIT_LOG_FILES = ["changes.jsonl", "dropped.jsonl", "contested.jsonl"] as const;

export type StoreLayoutInitOptions = {
  root: string;
  projectConfig: ProjectConfig;
  overwrite?: boolean;
};

export type StoreLayoutInitResult = {
  root: string;
  createdFiles: string[];
  existingFiles: string[];
};

export function resolveStoreRoot(repoRoot: string, storePath: string): string {
  const normalizedRepoRoot = resolve(repoRoot);
  const storeRoot = resolve(normalizedRepoRoot, storePath);
  const relativeStoreRoot = relative(normalizedRepoRoot, storeRoot);

  if (
    relativeStoreRoot === "" ||
    relativeStoreRoot.startsWith("..") ||
    isAbsolute(relativeStoreRoot)
  ) {
    throw new Error("Context store path must stay inside the bound repository.");
  }

  return storeRoot;
}

export function initStoreLayout(options: StoreLayoutInitOptions): StoreLayoutInitResult {
  const root = resolve(options.root);
  const overwrite = options.overwrite === true;
  const createdFiles: string[] = [];
  const existingFiles: string[] = [];

  mkdirSync(join(root, "raw", "events"), { recursive: true });
  mkdirSync(join(root, "normalized"), { recursive: true });
  mkdirSync(join(root, "audit"), { recursive: true });
  mkdirSync(join(root, "indexes"), { recursive: true });

  writeStoreFile({
    path: join(root, "project.yaml"),
    content: serializeProjectConfig(options.projectConfig),
    overwrite,
    createdFiles,
    existingFiles
  });

  for (const file of NORMALIZED_RECORD_FILES) {
    writeStoreFile({
      path: join(root, "normalized", file),
      content: "",
      overwrite,
      createdFiles,
      existingFiles
    });
  }

  for (const file of AUDIT_LOG_FILES) {
    writeStoreFile({
      path: join(root, "audit", file),
      content: "",
      overwrite,
      createdFiles,
      existingFiles
    });
  }

  writeStoreFile({
    path: join(root, "indexes", "path-index.json"),
    content: serializePathIndex(createEmptyPathIndex()),
    overwrite,
    createdFiles,
    existingFiles
  });
  writeStoreFile({
    path: join(root, "indexes", "symbol-index.json"),
    content: serializeSymbolIndex(createEmptySymbolIndex()),
    overwrite,
    createdFiles,
    existingFiles
  });
  writeStoreFile({
    path: join(root, "indexes", "episode-index.json"),
    content: serializeEpisodeIndex(createEmptyEpisodeIndex()),
    overwrite,
    createdFiles,
    existingFiles
  });

  return { root, createdFiles, existingFiles };
}

function writeStoreFile(options: {
  path: string;
  content: string;
  overwrite?: boolean;
  createdFiles: string[];
  existingFiles: string[];
}): void {
  if (existsSync(options.path) && !options.overwrite) {
    options.existingFiles.push(options.path);
    return;
  }

  writeFileSync(options.path, options.content, "utf8");
  options.createdFiles.push(options.path);
}
