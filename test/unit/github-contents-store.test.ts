import assert from "node:assert/strict";
import test from "node:test";
import { GitHubContentsStore } from "../../src/adapters/github/contents-store.js";
import {
  describeGitHubAuth,
  resolveGitHubToken,
  type GitHubFetch
} from "../../src/adapters/github/github-client.js";

test("GitHubContentsStore reads, writes, appends, lists files, and reports revision", async () => {
  const fake = new FakeGitHubApi();
  fake.putFile("contexts/service/normalized/empty.jsonl", "", "sha-empty");
  fake.putFile("contexts/service/normalized/facts.jsonl", "fact-1\n", "sha-1");
  fake.putFile("contexts/service/normalized/rules.jsonl", "rule-1\n", "sha-2");

  const store = new GitHubContentsStore({
    repository: "github.com/team/context",
    storePath: "contexts/service",
    branch: "main",
    fetch: fake.fetch,
    token: "token-1"
  });

  assert.equal(await store.getRevision(), "store-head-1");
  assert.deepEqual(await store.readText("normalized/facts.jsonl"), {
    path: "normalized/facts.jsonl",
    content: "fact-1\n",
    revision: "sha-1"
  });
  assert.deepEqual(await store.readText("normalized/empty.jsonl"), {
    path: "normalized/empty.jsonl",
    content: "",
    revision: "sha-empty"
  });

  const writeResult = await store.writeText("normalized/facts.jsonl", "fact-2\n", {
    message: "Update facts",
    expectedRevision: "sha-1"
  });
  assert.equal(writeResult.revision, "sha-3");
  assert.equal(writeResult.storeRevision, "commit-1");
  assert.equal(fake.fileContent("contexts/service/normalized/facts.jsonl"), "fact-2\n");

  await store.appendJsonl("audit/changes.jsonl", [{ id: "audit-1" }], {
    message: "Append audit"
  });
  assert.equal(fake.fileContent("contexts/service/audit/changes.jsonl"), '{"id":"audit-1"}\n');

  await store.deleteText("normalized/rules.jsonl", {
    message: "Delete rules",
    expectedRevision: "sha-2"
  });
  assert.equal(fake.fileContent("contexts/service/normalized/rules.jsonl"), undefined);

  assert.deepEqual(await store.listFiles("normalized"), [
    "normalized/empty.jsonl",
    "normalized/facts.jsonl"
  ]);
  assert.equal(
    fake.requests.some((request) => request.authorization === "Bearer token-1"),
    true
  );
});

test("GitHubContentsStore retries append writes on optimistic conflicts", async () => {
  const fake = new FakeGitHubApi();
  fake.putFile("contexts/service/audit/changes.jsonl", "old\n", "sha-1");
  fake.failNextPutWithConflict();

  const store = new GitHubContentsStore({
    repository: "team/context",
    storePath: "contexts/service",
    fetch: fake.fetch,
    maxRetries: 2
  });

  await store.appendJsonl("audit/changes.jsonl", [{ id: "audit-1" }], {
    message: "Append audit"
  });

  assert.equal(fake.fileContent("contexts/service/audit/changes.jsonl"), 'old\n{"id":"audit-1"}\n');
  assert.equal(fake.putAttempts, 2);
});

test("resolveGitHubToken prefers TEAMCTX_GITHUB_TOKEN and then GITHUB_TOKEN", () => {
  assert.equal(
    resolveGitHubToken({
      env: {
        TEAMCTX_GITHUB_TOKEN: " teamctx-token ",
        GITHUB_TOKEN: "github-token"
      },
      allowGh: false
    }),
    "teamctx-token"
  );
  assert.equal(
    resolveGitHubToken({
      env: {
        GITHUB_TOKEN: " github-token "
      },
      allowGh: false
    }),
    "github-token"
  );
});

test("describeGitHubAuth reports the resolved token source", () => {
  assert.deepEqual(
    describeGitHubAuth({
      env: { TEAMCTX_GITHUB_TOKEN: "teamctx-token", GITHUB_TOKEN: "github-token" },
      allowGh: false
    }),
    { source: "env:TEAMCTX_GITHUB_TOKEN", token: "teamctx-token" }
  );
  assert.deepEqual(describeGitHubAuth({ env: { GITHUB_TOKEN: "github-token" }, allowGh: false }), {
    source: "env:GITHUB_TOKEN",
    token: "github-token"
  });
  assert.deepEqual(describeGitHubAuth({ env: {}, allowGh: false }), { source: "none" });
});

type FakeFile = {
  content: string;
  sha: string;
};

type FakeRequest = {
  method: string;
  path: string;
  authorization?: string;
};

class FakeGitHubApi {
  readonly requests: FakeRequest[] = [];
  putAttempts = 0;
  private readonly files = new Map<string, FakeFile>();
  private nextSha = 3;
  private failConflict = false;

  readonly fetch: GitHubFetch = async (url, init) => {
    const requestUrl = new URL(url);
    const method = init?.method ?? "GET";
    const authorization = init?.headers?.Authorization;
    this.requests.push({
      method,
      path: requestUrl.pathname,
      ...(authorization !== undefined ? { authorization } : {})
    });

    if (requestUrl.pathname === "/repos/team/context") {
      return jsonResponse(200, { default_branch: "main" });
    }

    if (requestUrl.pathname === "/repos/team/context/commits/main") {
      return jsonResponse(200, { sha: "store-head-1" });
    }

    if (requestUrl.pathname.startsWith("/repos/team/context/contents/")) {
      const path = decodeGitHubPath(
        requestUrl.pathname.slice("/repos/team/context/contents/".length)
      );

      if (method === "GET") {
        return this.getContent(path);
      }

      if (method === "PUT") {
        this.putAttempts += 1;
        return this.putContent(path, init?.body);
      }

      if (method === "DELETE") {
        return this.deleteContent(path, init?.body);
      }
    }

    return textResponse(404, "not found");
  };

  putFile(path: string, content: string, sha: string): void {
    this.files.set(path, { content, sha });
  }

  fileContent(path: string): string | undefined {
    return this.files.get(path)?.content;
  }

  failNextPutWithConflict(): void {
    this.failConflict = true;
  }

  private getContent(path: string): ReturnType<GitHubFetch> {
    const file = this.files.get(path);

    if (file) {
      return Promise.resolve(
        jsonResponse(200, {
          type: "file",
          path,
          sha: file.sha,
          content: Buffer.from(file.content, "utf8").toString("base64")
        })
      );
    }

    const entries = this.directoryEntries(path);

    if (entries.length > 0) {
      return Promise.resolve(jsonResponse(200, entries));
    }

    return Promise.resolve(textResponse(404, "not found"));
  }

  private putContent(path: string, body: string | undefined): ReturnType<GitHubFetch> {
    if (this.failConflict) {
      this.failConflict = false;
      return Promise.resolve(textResponse(409, "conflict"));
    }

    const request = parseJsonObject(body ?? "{}");
    const expectedSha = optionalString(request.sha);
    const encodedContent = requiredString(request.content);
    const existing = this.files.get(path);

    if (existing && existing.sha !== expectedSha) {
      return Promise.resolve(textResponse(409, "conflict"));
    }

    if (!existing && expectedSha !== undefined) {
      return Promise.resolve(textResponse(409, "conflict"));
    }

    const sha = `sha-${this.nextSha}`;
    this.nextSha += 1;
    this.files.set(path, {
      content: Buffer.from(encodedContent, "base64").toString("utf8"),
      sha
    });

    return Promise.resolve(
      jsonResponse(200, {
        content: { sha },
        commit: { sha: `commit-${this.putAttempts}` }
      })
    );
  }

  private deleteContent(path: string, body: string | undefined): ReturnType<GitHubFetch> {
    const request = parseJsonObject(body ?? "{}");
    const expectedSha = requiredString(request.sha);
    const existing = this.files.get(path);

    if (!existing || existing.sha !== expectedSha) {
      return Promise.resolve(textResponse(409, "conflict"));
    }

    this.files.delete(path);

    return Promise.resolve(
      jsonResponse(200, {
        commit: { sha: "commit-delete-1" }
      })
    );
  }

  private directoryEntries(
    path: string
  ): Array<{ type: "file" | "dir"; path: string; sha: string }> {
    const prefix = path.replace(/\/+$/, "");
    const directoryPrefix = `${prefix}/`;
    const entries = new Map<string, { type: "file" | "dir"; path: string; sha: string }>();

    for (const [filePath, file] of this.files) {
      if (!filePath.startsWith(directoryPrefix)) {
        continue;
      }

      const remainder = filePath.slice(directoryPrefix.length);
      const [firstSegment] = remainder.split("/");

      if (!firstSegment) {
        continue;
      }

      const entryPath = `${directoryPrefix}${firstSegment}`;
      entries.set(entryPath, {
        type: remainder.includes("/") ? "dir" : "file",
        path: entryPath,
        sha: remainder.includes("/") ? `dir-${firstSegment}` : file.sha
      });
    }

    return [...entries.values()];
  }
}

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

function textResponse(status: number, body: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => ({ message: body }),
    text: async () => body
  };
}

function decodeGitHubPath(path: string): string {
  return path.split("/").map(decodeURIComponent).join("/");
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("expected JSON object");
  }

  return parsed as Record<string, unknown>;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("expected string");
  }

  return value;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return requiredString(value);
}
