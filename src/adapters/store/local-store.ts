import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  serializeJsonl,
  type ContextStoreAdapter,
  type ContextStoreFile,
  type ContextStoreWriteOptions,
  type ContextStoreWriteResult
} from "./context-store.js";

export class LocalContextStore implements ContextStoreAdapter {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async getRevision(): Promise<string | null> {
    return null;
  }

  async readText(path: string): Promise<ContextStoreFile | undefined> {
    const absolutePath = this.resolvePath(path);

    if (!existsSync(absolutePath)) {
      return undefined;
    }

    return {
      path: normalizeStorePath(path),
      content: readFileSync(absolutePath, "utf8"),
      revision: null
    };
  }

  async writeText(
    path: string,
    content: string,
    _options: ContextStoreWriteOptions
  ): Promise<ContextStoreWriteResult> {
    const absolutePath = this.resolvePath(path);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content, "utf8");

    return {
      path: normalizeStorePath(path),
      revision: null,
      storeRevision: null
    };
  }

  async appendJsonl(
    path: string,
    rows: unknown[],
    _options: ContextStoreWriteOptions
  ): Promise<ContextStoreWriteResult> {
    const absolutePath = this.resolvePath(path);
    mkdirSync(dirname(absolutePath), { recursive: true });
    appendFileSync(absolutePath, serializeJsonl(rows), "utf8");

    return {
      path: normalizeStorePath(path),
      revision: null,
      storeRevision: null
    };
  }

  async deleteText(
    path: string,
    _options: ContextStoreWriteOptions
  ): Promise<ContextStoreWriteResult> {
    const absolutePath = this.resolvePath(path);

    if (existsSync(absolutePath)) {
      rmSync(absolutePath);
    }

    return {
      path: normalizeStorePath(path),
      revision: null,
      storeRevision: null
    };
  }

  async listFiles(path: string): Promise<string[]> {
    const root = this.resolvePath(path);

    return listFiles(root).map((file) => normalizeStorePath(relative(this.root, file)));
  }

  private resolvePath(path: string): string {
    const normalizedPath = normalizeStorePath(path);
    const absolutePath = resolve(this.root, ...normalizedPath.split("/"));
    const relativePath = relative(this.root, absolutePath);

    if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
      throw new Error("Context store path must stay inside the store root.");
    }

    return absolutePath;
  }
}

function listFiles(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
      const path = join(root, entry.name);

      if (entry.isDirectory()) {
        return listFiles(path);
      }

      return entry.isFile() ? [path] : [];
    });
  } catch {
    return [];
  }
}

function normalizeStorePath(path: string): string {
  const normalizedPath = path.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");

  if (
    normalizedPath.length === 0 ||
    normalizedPath === "." ||
    normalizedPath.split("/").includes("..")
  ) {
    throw new Error("Context store path must be a relative path inside the store.");
  }

  return normalizedPath;
}
