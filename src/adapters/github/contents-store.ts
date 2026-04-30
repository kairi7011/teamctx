import {
  GitHubApiError,
  GitHubClient,
  parseGitHubRepository,
  requiredRecord,
  requiredString,
  resolveGitHubToken,
  type GitHubClientOptions,
  type GitHubFetch
} from "./github-client.js";
import {
  serializeJsonl,
  type ContextStoreAdapter,
  type ContextStoreFile,
  type ContextStoreWriteOptions,
  type ContextStoreWriteResult
} from "../store/context-store.js";
import { normalizeStorePath } from "../store/store-path.js";

export type GitHubContentsStoreOptions = GitHubClientOptions & {
  repository: string;
  storePath: string;
  branch?: string;
  maxRetries?: number;
};

export type GitHubContentEntry = {
  path: string;
  type: "file" | "dir";
  sha: string;
};

export class GitHubContentsStore implements ContextStoreAdapter {
  private readonly client: GitHubClient;
  private readonly owner: string;
  private readonly repo: string;
  private readonly storePath: string;
  private readonly branch: string | undefined;
  private readonly maxRetries: number;

  constructor(options: GitHubContentsStoreOptions) {
    const repository = parseGitHubRepository(options.repository);

    this.client =
      options.fetch || options.apiBaseUrl || options.token
        ? new GitHubClient({
            ...(options.token !== undefined ? { token: options.token } : {}),
            ...(options.apiBaseUrl !== undefined ? { apiBaseUrl: options.apiBaseUrl } : {}),
            ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
            ...(options.userAgent !== undefined ? { userAgent: options.userAgent } : {})
          })
        : new GitHubClient(clientOptionsFromResolvedToken());
    this.owner = repository.owner;
    this.repo = repository.name;
    this.storePath = normalizeStorePath(options.storePath);
    this.branch = options.branch;
    this.maxRetries = options.maxRetries ?? 3;
  }

  static withFetch(options: {
    repository: string;
    storePath: string;
    fetch: GitHubFetch;
    branch?: string;
    token?: string;
  }): GitHubContentsStore {
    return new GitHubContentsStore({
      repository: options.repository,
      storePath: options.storePath,
      fetch: options.fetch,
      ...(options.branch !== undefined ? { branch: options.branch } : {}),
      ...(options.token !== undefined ? { token: options.token } : {})
    });
  }

  async getRevision(): Promise<string | null> {
    const repo = requiredRecord(
      await this.client.requestJson("GET", `/repos/${this.owner}/${this.repo}`),
      "GitHub repository response"
    );
    const ref = this.branch ?? requiredString(repo.default_branch, "repository default_branch");
    const commit = requiredRecord(
      await this.client.requestJson(
        "GET",
        `/repos/${this.owner}/${this.repo}/commits/${encodeURIComponent(ref)}`
      ),
      "GitHub commit response"
    );

    return requiredString(commit.sha, "commit sha");
  }

  async readText(path: string): Promise<ContextStoreFile | undefined> {
    try {
      const content = validateFileContent(
        await this.client.requestJson("GET", this.contentPath(path))
      );

      return {
        path: normalizeStorePath(path),
        content: decodeBase64(content.content),
        revision: content.sha
      };
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }

      throw error;
    }
  }

  async writeText(
    path: string,
    content: string,
    options: ContextStoreWriteOptions
  ): Promise<ContextStoreWriteResult> {
    const body = {
      message: options.message,
      content: encodeBase64(content),
      ...(options.expectedRevision !== undefined && options.expectedRevision !== null
        ? { sha: options.expectedRevision }
        : {}),
      ...(this.branch !== undefined ? { branch: this.branch } : {})
    };
    const response = validateWriteResponse(
      await this.client.requestJson("PUT", this.contentPath(path, false), body)
    );

    return {
      path: normalizeStorePath(path),
      revision: response.contentSha,
      storeRevision: response.commitSha
    };
  }

  async appendJsonl(
    path: string,
    rows: unknown[],
    options: ContextStoreWriteOptions
  ): Promise<ContextStoreWriteResult> {
    let attempts = 0;

    while (true) {
      attempts += 1;
      const existing = await this.readText(path);
      const nextContent = `${existing?.content ?? ""}${serializeJsonl(rows)}`;

      try {
        return await this.writeText(path, nextContent, {
          message: options.message,
          expectedRevision: existing?.revision ?? null
        });
      } catch (error) {
        if (!isConflict(error) || attempts >= this.maxRetries) {
          throw error;
        }
      }
    }
  }

  async deleteText(
    path: string,
    options: ContextStoreWriteOptions
  ): Promise<ContextStoreWriteResult> {
    const revision = options.expectedRevision ?? (await this.readText(path))?.revision;

    if (!revision) {
      return {
        path: normalizeStorePath(path),
        revision: null,
        storeRevision: await this.getRevision()
      };
    }

    const response = validateDeleteResponse(
      await this.client.requestJson("DELETE", this.contentPath(path, false), {
        message: options.message,
        sha: revision,
        ...(this.branch !== undefined ? { branch: this.branch } : {})
      })
    );

    return {
      path: normalizeStorePath(path),
      revision: null,
      storeRevision: response.commitSha
    };
  }

  async listFiles(path: string): Promise<string[]> {
    const entries = await this.listEntries(path);
    const files: string[] = [];

    for (const entry of entries) {
      if (entry.type === "file") {
        files.push(this.toStoreRelativePath(entry.path));
      } else {
        files.push(...(await this.listFiles(this.toStoreRelativePath(entry.path))));
      }
    }

    return files.sort();
  }

  private async listEntries(path: string): Promise<GitHubContentEntry[]> {
    try {
      const value = await this.client.requestJson("GET", this.contentPath(path));

      if (!Array.isArray(value)) {
        const file = validateFileContent(value);
        return [{ path: file.path, type: "file", sha: file.sha }];
      }

      return value.map(validateContentEntry);
    } catch (error) {
      if (isNotFound(error)) {
        return [];
      }

      throw error;
    }
  }

  private contentPath(path: string, includeRef = true): string {
    const fullPath = joinGitHubPath(this.storePath, normalizeStorePath(path));
    const query = includeRef && this.branch ? `?ref=${encodeURIComponent(this.branch)}` : "";

    return `/repos/${this.owner}/${this.repo}/contents/${encodeGitHubPath(fullPath)}${query}`;
  }

  private toStoreRelativePath(path: string): string {
    const prefix = `${this.storePath}/`;

    if (!path.startsWith(prefix)) {
      throw new Error(`GitHub content path is outside the context store: ${path}`);
    }

    return normalizeStorePath(path.slice(prefix.length));
  }
}

function validateFileContent(value: unknown): {
  path: string;
  sha: string;
  content: string;
} {
  const record = requiredRecord(value, "GitHub content response");

  if (record.type !== "file") {
    throw new Error("GitHub content response must be a file");
  }

  return {
    path: requiredString(record.path, "content path"),
    sha: requiredString(record.sha, "content sha"),
    content: requiredContentString(record.content)
  };
}

function requiredContentString(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("content body must be a string");
  }

  return value;
}

function clientOptionsFromResolvedToken(): GitHubClientOptions {
  const token = resolveGitHubToken();

  return token !== undefined ? { token } : {};
}

function validateContentEntry(value: unknown): GitHubContentEntry {
  const record = requiredRecord(value, "GitHub content entry");
  const type = requiredString(record.type, "content type");

  if (type !== "file" && type !== "dir") {
    throw new Error("GitHub content entry type must be file or dir");
  }

  return {
    path: requiredString(record.path, "content path"),
    type,
    sha: requiredString(record.sha, "content sha")
  };
}

function validateWriteResponse(value: unknown): { contentSha: string; commitSha: string } {
  const record = requiredRecord(value, "GitHub write response");
  const content = requiredRecord(record.content, "GitHub write content");
  const commit = requiredRecord(record.commit, "GitHub write commit");

  return {
    contentSha: requiredString(content.sha, "content sha"),
    commitSha: requiredString(commit.sha, "commit sha")
  };
}

function validateDeleteResponse(value: unknown): { commitSha: string } {
  const record = requiredRecord(value, "GitHub delete response");
  const commit = requiredRecord(record.commit, "GitHub delete commit");

  return {
    commitSha: requiredString(commit.sha, "commit sha")
  };
}

function joinGitHubPath(left: string, right: string): string {
  return `${left.replace(/\/+$/, "")}/${right.replace(/^\/+/, "")}`;
}

function encodeGitHubPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function encodeBase64(content: string): string {
  return Buffer.from(content, "utf8").toString("base64");
}

function decodeBase64(content: string): string {
  return Buffer.from(content.replace(/\s/g, ""), "base64").toString("utf8");
}

function isNotFound(error: unknown): boolean {
  return error instanceof GitHubApiError && error.status === 404;
}

function isConflict(error: unknown): boolean {
  return error instanceof GitHubApiError && (error.status === 409 || error.status === 422);
}
