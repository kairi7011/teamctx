import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Binding, BindingsFile, ContextStore } from "../../schemas/types.js";

const CONFIG_VERSION = 1;

export function getConfigPath(): string {
  return join(homedir(), ".config", "teamctx", "bindings.json");
}

export function loadBindings(path = getConfigPath()): BindingsFile {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as BindingsFile;
  } catch {
    return {
      version: CONFIG_VERSION,
      bindings: {}
    };
  }
}

export function saveBindings(file: BindingsFile, path = getConfigPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
}

export function upsertBinding(
  repo: string,
  root: string,
  contextStore: ContextStore,
  path = getConfigPath()
): Binding {
  const file = loadBindings(path);
  const binding: Binding = {
    repo,
    root,
    contextStore,
    createdAt: new Date().toISOString()
  };

  file.bindings[repo] = binding;
  saveBindings(file, path);

  return binding;
}

export function findBinding(repo: string, path = getConfigPath()): Binding | undefined {
  return loadBindings(path).bindings[repo];
}
