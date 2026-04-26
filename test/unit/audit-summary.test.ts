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
import { getBoundAuditSummary, type BoundAuditServices } from "../../src/core/audit/summary.js";
import type { AuditLogEntry } from "../../src/schemas/audit.js";
import type { Binding } from "../../src/schemas/types.js";

function tempDirectory(): { directory: string; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "teamctx-audit-"));

  return {
    directory,
    cleanup: () => rmSync(directory, { recursive: true, force: true })
  };
}

test("getBoundAuditSummary filters local audit entries", async (context) => {
  const { directory, cleanup } = tempDirectory();
  context.after(cleanup);
  const storeRoot = join(directory, ".teamctx");
  writeAudit(storeRoot, [
    auditEntry("audit-1", "created", "workflow-list", "2026-04-22T10:00:00.000Z"),
    auditEntry("audit-2", "dropped", undefined, "2026-04-22T10:01:00.000Z", {
      reason: "evidence minimum check failed",
      sourceEventIds: ["event-dropped"]
    })
  ]);

  const result = await getBoundAuditSummary(
    {
      actions: ["created"],
      item_ids: ["workflow-list"],
      query: "workflow"
    },
    servicesForLocal(directory)
  );

  assert.equal(result.enabled, true);

  if (!result.enabled) {
    throw new Error("expected enabled result");
  }

  assert.equal(result.local_store, true);
  assert.equal(result.total_matches, 1);
  assert.equal(result.entries[0]?.id, "audit-1");
});

test("getBoundAuditSummary filters remote audit entries and applies limit", async () => {
  const store = new MemoryContextStore("remote-head");
  await store.writeText(
    "audit/changes.jsonl",
    `${[
      auditEntry("audit-1", "created", "workflow-old", "2026-04-22T10:00:00.000Z"),
      auditEntry("audit-2", "created", "workflow-new", "2026-04-22T10:01:00.000Z")
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`,
    { message: "seed" }
  );

  const result = await getBoundAuditSummary(
    {
      actions: ["created"],
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
  assert.equal(result.entries[0]?.id, "audit-2");
});

test("getBoundAuditSummary paginates with offset and reports next_offset", async () => {
  const store = new MemoryContextStore("remote-head");
  await store.writeText(
    "audit/changes.jsonl",
    `${[
      auditEntry("audit-1", "created", "item-1", "2026-04-22T10:00:00.000Z"),
      auditEntry("audit-2", "created", "item-2", "2026-04-22T10:01:00.000Z"),
      auditEntry("audit-3", "created", "item-3", "2026-04-22T10:02:00.000Z")
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`,
    { message: "seed" }
  );

  const firstPage = await getBoundAuditSummary({ limit: 2, offset: 0 }, servicesForRemote(store));

  assert.equal(firstPage.enabled, true);
  if (!firstPage.enabled) throw new Error("expected enabled result");
  assert.equal(firstPage.total_matches, 3);
  assert.equal(firstPage.returned, 2);
  assert.equal(firstPage.offset, 0);
  assert.equal(firstPage.next_offset, 2);
  assert.equal(firstPage.entries[0]?.id, "audit-3");

  const secondPage = await getBoundAuditSummary({ limit: 2, offset: 2 }, servicesForRemote(store));

  assert.equal(secondPage.enabled, true);
  if (!secondPage.enabled) throw new Error("expected enabled result");
  assert.equal(secondPage.returned, 1);
  assert.equal(secondPage.offset, 2);
  assert.equal(secondPage.next_offset, null);
  assert.equal(secondPage.entries[0]?.id, "audit-1");
});

test("getBoundAuditSummary rejects negative offset", async () => {
  const store = new MemoryContextStore("remote-head");

  await assert.rejects(
    () => getBoundAuditSummary({ offset: -1 }, servicesForRemote(store)),
    /offset must be a non-negative integer/
  );
});

function writeAudit(storeRoot: string, entries: AuditLogEntry[]): void {
  const directory = join(storeRoot, "audit");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "changes.jsonl"),
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8"
  );
}

function auditEntry(
  id: string,
  action: AuditLogEntry["action"],
  itemId: string | undefined,
  at: string,
  options: { reason?: string; sourceEventIds?: string[] } = {}
): AuditLogEntry {
  const entry: AuditLogEntry = {
    schema_version: 1,
    id,
    at,
    action,
    source_event_ids: options.sourceEventIds ?? ["event-1"]
  };

  if (itemId !== undefined) {
    entry.item_id = itemId;
  }
  if (action === "created") {
    entry.after_state = "active";
  }
  if (options.reason !== undefined) {
    entry.reason = options.reason;
  }

  return entry;
}

function servicesForLocal(root: string): BoundAuditServices {
  return {
    getRepoRoot: () => root,
    getOriginRemote: () => "git@github.com:team/service.git",
    getCurrentBranch: () => "main",
    getHeadCommit: () => "abc123",
    findBinding: () => binding(root)
  };
}

function servicesForRemote(store: ContextStoreAdapter): BoundAuditServices {
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
