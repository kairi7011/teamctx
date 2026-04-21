import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Binding, BindingsFile, ContextStore } from "../../schemas/types.js";

const CONFIG_VERSION = 1;

export function getConfigPath(): string {
  return join(homedir(), ".config", "teamctx", "bindings.json");
}

export function loadBindings(path = getConfigPath()): BindingsFile {
  let raw: string;

  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return createEmptyBindingsFile();
    }

    throw error;
  }

  try {
    const parsed: unknown = JSON.parse(raw);

    if (isBindingsFile(parsed)) {
      return parsed;
    }

    throw new Error("expected version 1 with a bindings object");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid teamctx bindings config at ${path}: ${message}`, { cause: error });
  }
}

function createEmptyBindingsFile(): BindingsFile {
  return {
    version: CONFIG_VERSION,
    bindings: {}
  };
}

function isBindingsFile(value: unknown): value is BindingsFile {
  if (!isRecord(value) || value.version !== CONFIG_VERSION || !isRecord(value.bindings)) {
    return false;
  }

  return Object.values(value.bindings).every(isBinding);
}

function isBinding(value: unknown): value is Binding {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.repo === "string" &&
    typeof value.root === "string" &&
    typeof value.createdAt === "string" &&
    isContextStore(value.contextStore)
  );
}

function isContextStore(value: unknown): value is ContextStore {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.provider === "github" && typeof value.repo === "string" && typeof value.path === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return isRecord(error) && typeof error.code === "string";
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
