import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalContextStore } from "../../src/adapters/store/local-store.js";
import {
  explainBoundItemAsync,
  explainItem,
  invalidateBoundItemAsync,
  invalidateItem,
  type ControlServices
} from "../../src/core/audit/control.js";
import { explainItemTool } from "../../src/mcp/tools/explain-item.js";
import { invalidateTool } from "../../src/mcp/tools/invalidate.js";
import { fixtureNormalizedRecord } from "../fixtures/normalized-record.js";
import type { AuditLogEntry } from "../../src/schemas/audit.js";
import type { NormalizedRecord } from "../../src/schemas/normalized-record.js";
import type { Binding } from "../../src/schemas/types.js";

function tempDirectory(): { directory: string; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "teamctx-audit-"));

  return {
    directory,
    cleanup: () => rmSync(directory, { recursive: true, force: true })
  };
}

test("explainItem returns the record and matching audit entries", (context) => {
  const { directory, cleanup } = tempDirectory();
  context.after(cleanup);
  const storeRoot = join(directory, ".teamctx");
  writeRecord(storeRoot, record());
  writeAudit(storeRoot, auditEntry("created"));

  const result = explainItem({ storeRoot, itemId: "pitfall-auth-order" });

  assert.equal(result.found, true);

  if (!result.found) {
    throw new Error("expected item to be found");
  }

  assert.equal(result.record.id, "pitfall-auth-order");
  assert.equal(result.audit_entries.length, 1);
  assert.equal(result.audit_entries[0]?.action, "created");
});

test("invalidateItem archives a normalized record and writes an audit entry", (context) => {
  const { directory, cleanup } = tempDirectory();
  context.after(cleanup);
  const storeRoot = join(directory, ".teamctx");
  writeRecord(storeRoot, record());

  const result = invalidateItem({
    storeRoot,
    itemId: "pitfall-auth-order",
    reason: "obsolete",
    now: () => new Date("2026-04-22T12:00:00.000Z")
  });

  assert.equal(result.invalidated, true);
  assert.equal(result.before_state, "active");
  assert.equal(result.after_state, "archived");

  const records = readJsonl(join(storeRoot, "normalized", "pitfalls.jsonl"));
  assert.equal(records[0]?.state, "archived");
  assert.equal(records[0]?.valid_until, "2026-04-22T12:00:00.000Z");
  assert.equal(records[0]?.invalidated_by, "obsolete");

  const audit = readJsonl(join(storeRoot, "audit", "changes.jsonl"));
  assert.equal(audit[0]?.action, "invalidated");
  assert.equal(audit[0]?.before_state, "active");
  assert.equal(audit[0]?.after_state, "archived");
  assert.equal(audit[0]?.reason, "obsolete");
});

test("explainItemTool and invalidateTool resolve the bound local store", (context) => {
  const { directory, cleanup } = tempDirectory();
  context.after(cleanup);
  const storeRoot = join(directory, ".teamctx");
  writeRecord(storeRoot, record());
  const services = servicesFor(directory);

  const explainResult = explainItemTool({ item_id: "pitfall-auth-order" }, services) as {
    found: boolean;
  };
  assert.equal(explainResult.found, true);

  const invalidateResult = invalidateTool(
    { item_id: "pitfall-auth-order", reason: "manual cleanup" },
    services
  ) as { invalidated: boolean };
  assert.equal(invalidateResult.invalidated, true);
});

function writeRecord(storeRoot: string, normalizedRecord: NormalizedRecord): void {
  const directory = join(storeRoot, "normalized");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "pitfalls.jsonl"), `${JSON.stringify(normalizedRecord)}\n`, "utf8");
}

function writeAudit(storeRoot: string, entry: AuditLogEntry): void {
  const directory = join(storeRoot, "audit");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "changes.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
}

function record(): NormalizedRecord {
  return fixtureNormalizedRecord({
    scope: {
      paths: ["src/auth/**"],
      domains: ["auth"],
      symbols: ["AuthMiddleware"],
      tags: []
    }
  });
}

function auditEntry(action: AuditLogEntry["action"]): AuditLogEntry {
  return {
    schema_version: 1,
    id: "audit-1",
    at: "2026-04-22T11:00:00.000Z",
    action,
    item_id: "pitfall-auth-order",
    after_state: "active",
    reason: "evidence minimum check passed",
    source_event_ids: ["event-1"]
  };
}

function servicesFor(root: string): ControlServices {
  return localServicesFor(root);
}

test("async audit controls resolve remote context store adapters", async (context) => {
  const { directory, cleanup } = tempDirectory();
  context.after(cleanup);
  const remoteRoot = join(directory, "remote-store");
  writeRecord(remoteRoot, record());
  writeAudit(remoteRoot, auditEntry("created"));
  const services = remoteServicesFor(directory, remoteRoot);

  const explainResult = await explainBoundItemAsync({
    itemId: "pitfall-auth-order",
    services
  });
  assert.equal(explainResult.found, true);

  const invalidateResult = await invalidateBoundItemAsync({
    itemId: "pitfall-auth-order",
    reason: "obsolete remotely",
    now: () => new Date("2026-04-22T12:00:00.000Z"),
    services
  });

  assert.equal(invalidateResult.invalidated, true);
  assert.equal(invalidateResult.before_state, "active");

  const records = readJsonl(join(remoteRoot, "normalized", "pitfalls.jsonl"));
  assert.equal(records[0]?.state, "archived");
  assert.equal(records[0]?.valid_until, "2026-04-22T12:00:00.000Z");
  assert.equal(records[0]?.invalidated_by, "obsolete remotely");

  const audit = readJsonl(join(remoteRoot, "audit", "changes.jsonl"));
  assert.equal(audit[1]?.action, "invalidated");
  assert.equal(audit[1]?.reason, "obsolete remotely");
});

function localServicesFor(root: string): ControlServices {
  const binding: Binding = {
    repo: "github.com/team/service",
    root,
    contextStore: {
      provider: "github",
      repo: "github.com/team/service",
      path: ".teamctx"
    },
    createdAt: "2026-04-22T10:00:00.000Z"
  };

  return {
    getRepoRoot: () => root,
    getOriginRemote: () => "git@github.com:team/service.git",
    findBinding: () => binding
  };
}

function remoteServicesFor(root: string, remoteStoreRoot: string): ControlServices {
  const binding: Binding = {
    repo: "github.com/team/service",
    root,
    contextStore: {
      provider: "github",
      repo: "github.com/team/context",
      path: "contexts/service"
    },
    createdAt: "2026-04-22T10:00:00.000Z"
  };

  return {
    getRepoRoot: () => root,
    getOriginRemote: () => "git@github.com:team/service.git",
    findBinding: () => binding,
    createContextStore: () => new LocalContextStore(remoteStoreRoot)
  };
}

function readJsonl(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
