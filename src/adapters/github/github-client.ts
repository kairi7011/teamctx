import { execFileSync } from "node:child_process";
import { normalizeStoreRepo } from "../git/repo-url.js";
import { isRecord } from "../../schemas/validation.js";

export type GitHubFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export type GitHubFetchResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
};

export type GitHubFetch = (url: string, init?: GitHubFetchInit) => Promise<GitHubFetchResponse>;

export type GitHubClientOptions = {
  token?: string;
  apiBaseUrl?: string;
  fetch?: GitHubFetch;
  userAgent?: string;
};

export type GitHubRepository = {
  owner: string;
  name: string;
};

export class GitHubApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, statusText: string, body: string) {
    super(`GitHub API request failed: ${status} ${statusText}`);
    this.status = status;
    this.body = body;
  }
}

export class GitHubClient {
  private readonly apiBaseUrl: string;
  private readonly fetch: GitHubFetch;
  private readonly token: string | undefined;
  private readonly userAgent: string;

  constructor(options: GitHubClientOptions = {}) {
    this.apiBaseUrl = (options.apiBaseUrl ?? "https://api.github.com").replace(/\/+$/, "");
    this.fetch = options.fetch ?? defaultFetch;
    this.token = options.token;
    this.userAgent = options.userAgent ?? "teamctx";
  }

  async requestJson(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await this.fetch(`${this.apiBaseUrl}${path}`, {
      method,
      headers: this.headers(),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });

    if (!response.ok) {
      throw new GitHubApiError(response.status, response.statusText, await response.text());
    }

    return response.json();
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": this.userAgent
    };

    if (this.token !== undefined) {
      headers.Authorization = `Bearer ${this.token}`;
    }

    return headers;
  }
}

export function parseGitHubRepository(value: string): GitHubRepository {
  const normalized = normalizeStoreRepo(value);
  const match = /^github\.com\/([^/]+)\/([^/]+)$/.exec(normalized);

  if (!match) {
    throw new Error(`GitHub repository is invalid: ${value}`);
  }

  return {
    owner: match[1] ?? "",
    name: match[2] ?? ""
  };
}

export function resolveGitHubToken(
  options: { env?: NodeJS.ProcessEnv; allowGh?: boolean; execFile?: typeof execFileSync } = {}
): string | undefined {
  const env = options.env ?? process.env;
  const envToken = firstNonEmpty(env.TEAMCTX_GITHUB_TOKEN, env.GITHUB_TOKEN);

  if (envToken !== undefined) {
    return envToken;
  }

  if (options.allowGh === false) {
    return undefined;
  }

  try {
    const execFile = options.execFile ?? execFileSync;
    const token = execFile("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000
    });

    return firstNonEmpty(token.trim());
  } catch {
    return undefined;
  }
}

export function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }

  return value;
}

export function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  return requiredString(value, name);
}

export function requiredRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${name} must be an object`);
  }

  return value;
}

const defaultFetch: GitHubFetch = async (url, init) => {
  const response = await fetch(url, init);

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    json: () => response.json() as Promise<unknown>,
    text: () => response.text()
  };
};

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined && value.trim().length > 0)?.trim();
}
