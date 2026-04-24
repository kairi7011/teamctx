import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  ContextStoreAdapter,
  ContextStoreFile,
  ContextStoreWriteOptions,
  ContextStoreWriteResult
} from "../../src/adapters/store/context-store.js";
import { listBoundRecords, type BoundListRecordsServices } from "../../src/core/list/records.js";
import type { NormalizedRecord } from "../../src/schemas/normalized-record.js";
import type { Binding } from "../../src/schemas/types.js";

function tempDirectory(): { directory: string; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "teamctx-list-"));

  return {
    directory,
    cleanup: () => rmSync(directory, { recursive: true, force: true })
  };
}

test("listBoundRecords filters local records by kind state scope and query", async (context) => {
  const { directory, cleanup } = tempDirectory();
  context.after(cleanup);
  const storeRoot = join(directory, ".teamctx");

  writeRecord(storeRoot, "workflows.jsonl", record("workflow-cli-preview", "workflow"));
  writeRecord(storeRoot, "pitfalls.jsonl", record("pitfall-old-preview", "pitfall", "superseded"));
  writeRecord(
    storeRoot,
    "workflows.jsonl",
    record("workflow-billing", "workflow", "active", {
      paths: ["src/billing/**"],
      domains: ["billing"],
      symbols: ["BillingWorkflow"],
      tags: ["billing"]
    })
  );

  const result = await listBoundRecords(
    {
      kinds: ["workflow"],
      states: ["active"],
      paths: ["src/cli/index.ts"],
      domains: ["cli"],
      tags: ["preview-cli"],
      query: "context preview"
    },
    servicesForLocal(directory)
  );

  assert.equal(result.enabled, true);

  if (!result.enabled) {
    throw new Error("expected enabled result");
  }

  assert.equal(result.local_store, true);
  assert.equal(result.total_matches, 1);
  assert.deepEqual(
    result.records.map((item) => item.id),
    ["workflow-cli-preview"]
  );
});

test("listBoundRecords filters remote context store records and applies limit", async () => {
  const store = new MemoryContextStore("remote-head");
  await store.appendJsonl(
    "normalized/workflows.jsonl",
    [
      record("workflow-cli-preview", "workflow"),
      record("workflow-cli-second", "workflow", "active", {
        paths: ["src/cli/**"],
        domains: ["cli"],
        symbols: ["contextInput"],
        tags: ["preview-cli"]
      })
    ],
    { message: "seed" }
  );

  const result = await listBoundRecords(
    {
      kinds: ["workflow"],
      states: ["active"],
      domains: ["cli"],
      limit: 1
    },
    servicesForRemote(store)
  );

  assert.equal(result.enabled, true);

  if (!result.enabled) {
    throw new Error("expected enabled result");
  }

  assert.equal(result.local_store, false);
  assert.equal(result.store_head, "remote-head");
  assert.equal(result.total_matches, 2);
  assert.equal(result.returned, 1);
  assert.equal(result.records[0]?.id, "workflow-cli-preview");
});

function writeRecord(storeRoot: string, file: string, normalizedRecord: NormalizedRecord): void {
  const directory = join(storeRoot, "normalized");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, file), `${JSON.stringify(normalizedRecord)}\n`, {
    flag: "a",
    encoding: "utf8"
  });
}

function record(
  id: string,
  kind: NormalizedRecord["kind"],
  state: NormalizedRecord["state"] = "active",
  scope: NormalizedRecord["scope"] = {
    paths: ["src/cli/index.ts", "README.md"],
    domains: ["cli", "context-preview"],
    symbols: ["context"],
    tags: ["preview-cli"]
  }
): NormalizedRecord {
  return {
    id,
    schema_version: 1,
    normalizer_version: "0.1.0",
    kind,
    state,
    text: `${id} context preview text`,
    scope,
    evidence: [
      {
        kind: "code",
        repo: "github.com/team/service",
        commit: "abc123",
        file: "src/cli/index.ts"
      }
    ],
    provenance: {
      recorded_by: "codex",
      session_id: "session-1",
      observed_at: "2026-04-22T10:00:00.000Z"
    },
    confidence_level: "medium",
    confidence_score: 0.65,
    valid_from:
      id === "workflow-cli-second" ? "2026-04-22T10:01:00.000Z" : "2026-04-22T10:02:00.000Z",
    last_verified_at: "2026-04-22T11:00:00.000Z",
    supersedes: [],
    conflicts_with: []
  };
}

function servicesForLocal(root: string): BoundListRecordsServices {
  return {
    getRepoRoot: () => root,
    getOriginRemote: () => "git@github.com:team/service.git",
    getCurrentBranch: () => "main",
    getHeadCommit: () => "abc123",
    findBinding: () => binding(root)
  };
}

function servicesForRemote(store: ContextStoreAdapter): BoundListRecordsServices {
  return {
    getRepoRoot: () => "C:/work/service",
    getOriginRemote: () => "git@github.com:team/service.git",
    getCurrentBranch: () => "main",
    getHeadCommit: () => "abc123",
    findBinding: () => ({
      ...binding("C:/work/service"),
      contextStore: {
        provider: "github",
        repo: "github.com/team/context",
        path: "contexts/service"
      }
    }),
    createContextStore: () => store
  };
}

function binding(root: string): Binding {
  return {
    repo: "github.com/team/service",
    root,
    contextStore: {
      provider: "github",
      repo: "github.com/team/service",
      path: ".teamctx"
    },
    createdAt: "2026-04-22T10:00:00.000Z"
  };
}

class MemoryContextStore implements ContextStoreAdapter {
  private readonly files = new Map<string, string>();

  constructor(private readonly revision: string | null) {}

  async getRevision(): Promise<string | null> {
    return this.revision;
  }

  async readText(path: string): Promise<ContextStoreFile | undefined> {
    const content = this.files.get(path);

    if (content === undefined) {
      return undefined;
    }

    return { path, content, revision: null };
  }

  async writeText(
    path: string,
    content: string,
    _options: ContextStoreWriteOptions
  ): Promise<ContextStoreWriteResult> {
    this.files.set(path, content);

    return { path, revision: null, storeRevision: this.revision };
  }

  async deleteText(
    path: string,
    _options: ContextStoreWriteOptions
  ): Promise<ContextStoreWriteResult> {
    this.files.delete(path);

    return { path, revision: null, storeRevision: this.revision };
  }

  async appendJsonl(
    path: string,
    rows: unknown[],
    options: ContextStoreWriteOptions
  ): Promise<ContextStoreWriteResult> {
    const current = this.files.get(path) ?? "";
    return this.writeText(
      path,
      `${current}${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
      options
    );
  }

  async listFiles(): Promise<string[]> {
    return [...this.files.keys()].sort();
  }
}
