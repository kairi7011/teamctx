import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { Binding, BindingsFile, ContextStore } from "./types.js";

const CONFIG_VERSION = 1;

export function getConfigPath(): string {
  return join(homedir(), ".config", "teamctx", "bindings.json");
}

export function loadBindings(): BindingsFile {
  const path = getConfigPath();

  try {
    return JSON.parse(readFileSync(path, "utf8")) as BindingsFile;
  } catch {
    return {
      version: CONFIG_VERSION,
      bindings: {}
    };
  }
}

export function saveBindings(file: BindingsFile): void {
  const path = getConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
}

export function upsertBinding(repo: string, root: string, contextStore: ContextStore): Binding {
  const file = loadBindings();
  const binding: Binding = {
    repo,
    root,
    contextStore,
    createdAt: new Date().toISOString()
  };

  file.bindings[repo] = binding;
  saveBindings(file);

  return binding;
}

export function findBinding(repo: string): Binding | undefined {
  return loadBindings().bindings[repo];
}

