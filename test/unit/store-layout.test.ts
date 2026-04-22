import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalContextStore } from "../../src/adapters/store/local-store.js";
import {
  initBoundStoreAsync,
  initContextStoreLayout,
  type InitStoreServices
} from "../../src/core/store/init-store.js";
import {
  AUDIT_LOG_FILES,
  initStoreLayout,
  NORMALIZED_RECORD_FILES,
  resolveStoreRoot
} from "../../src/core/store/layout.js";
import { createDefaultProjectConfig } from "../../src/schemas/project.js";
import type { Binding } from "../../src/schemas/types.js";

function createTempDirectory(): { directory: string; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "teamctx-store-"));

  return {
    directory,
    cleanup: () => rmSync(directory, { recursive: true, force: true })
  };
}

test("resolveStoreRoot keeps context stores inside the repo root", (context) => {
  const { directory, cleanup } = createTempDirectory();
  context.after(cleanup);

  assert.equal(resolveStoreRoot(directory, ".teamctx"), join(directory, ".teamctx"));
  assert.throws(() => resolveStoreRoot(directory, "../outside"), /must stay inside/);
  assert.throws(() => resolveStoreRoot(directory, "."), /must stay inside/);
});

test("initStoreLayout creates the MVP context store files", (context) => {
  const { directory, cleanup } = createTempDirectory();
  context.after(cleanup);

  const result = initStoreLayout({
    root: join(directory, ".teamctx"),
    projectConfig: createDefaultProjectConfig("github.com/team/service")
  });

  assert.equal(result.existingFiles.length, 0);
  assert.equal(result.createdFiles.length, 14);
  assert.ok(existsSync(join(result.root, "raw", "events")));

  for (const file of NORMALIZED_RECORD_FILES) {
    assert.ok(existsSync(join(result.root, "normalized", file)));
  }

  for (const file of AUDIT_LOG_FILES) {
    assert.ok(existsSync(join(result.root, "audit", file)));
  }

  assert.equal(
    readFileSync(join(result.root, "project.yaml"), "utf8"),
    [
      "format_version: 1",
      'project_id: "github.com/team/service"',
      'normalizer_version: "0.1.0"',
      "retention:",
      "  raw_candidate_days: 30",
      "  audit_days: 180",
      '  archive_path: "archive/"',
      ""
    ].join("\n")
  );
  assert.equal(
    readFileSync(join(result.root, "indexes", "path-index.json"), "utf8"),
    [
      "{",
      '  "schema_version": 1,',
      '  "generated_at": null,',
      '  "paths": {},',
      '  "domains": {},',
      '  "tags": {},',
      '  "kinds": {},',
      '  "states": {}',
      "}",
      ""
    ].join("\n")
  );
  assert.equal(
    readFileSync(join(result.root, "indexes", "symbol-index.json"), "utf8"),
    ["{", '  "schema_version": 1,', '  "generated_at": null,', '  "symbols": {}', "}", ""].join(
      "\n"
    )
  );
  assert.equal(
    readFileSync(join(result.root, "indexes", "text-index.json"), "utf8"),
    ["{", '  "schema_version": 1,', '  "generated_at": null,', '  "tokens": {}', "}", ""].join("\n")
  );
  assert.equal(
    readFileSync(join(result.root, "indexes", "episode-index.json"), "utf8"),
    [
      "{",
      '  "schema_version": 1,',
      '  "generated_at": null,',
      '  "episodes": [],',
      '  "paths": {},',
      '  "domains": {},',
      '  "symbols": {},',
      '  "tags": {},',
      '  "source_types": {},',
      '  "trusts": {}',
      "}",
      ""
    ].join("\n")
  );
});

test("initStoreLayout does not overwrite existing files by default", (context) => {
  const { directory, cleanup } = createTempDirectory();
  context.after(cleanup);
  const root = join(directory, ".teamctx");

  initStoreLayout({
    root,
    projectConfig: createDefaultProjectConfig("github.com/team/service")
  });
  writeFileSync(join(root, "normalized", "facts.jsonl"), "keep\n", "utf8");

  const result = initStoreLayout({
    root,
    projectConfig: createDefaultProjectConfig("github.com/team/service")
  });

  assert.ok(result.existingFiles.includes(join(root, "normalized", "facts.jsonl")));
  assert.equal(readFileSync(join(root, "normalized", "facts.jsonl"), "utf8"), "keep\n");
});

test("initContextStoreLayout initializes an adapter-backed store idempotently", async (context) => {
  const { directory, cleanup } = createTempDirectory();
  context.after(cleanup);
  const root = join(directory, "remote-store");
  const store = new LocalContextStore(root);

  const first = await initContextStoreLayout({
    store,
    projectId: "github.com/team/service"
  });
  const second = await initContextStoreLayout({
    store,
    projectId: "github.com/team/service"
  });

  assert.equal(first.createdFiles.length, 14);
  assert.equal(first.existingFiles.length, 0);
  assert.equal(second.createdFiles.length, 0);
  assert.equal(second.existingFiles.length, 14);
  assert.ok(existsSync(join(root, "project.yaml")));
  assert.ok(existsSync(join(root, "indexes", "path-index.json")));
});

test("initBoundStoreAsync initializes remote context store adapters", async (context) => {
  const { directory, cleanup } = createTempDirectory();
  context.after(cleanup);
  const remoteRoot = join(directory, "remote-store");
  const services = servicesFor(directory, remoteRoot);

  const result = await initBoundStoreAsync({ services });

  assert.equal(result.localStore, false);
  assert.equal(result.store, "github.com/team/context/contexts/service");
  assert.equal(result.createdFiles.length, 14);
  assert.equal(result.existingFiles.length, 0);
  assert.ok(existsSync(join(remoteRoot, "normalized", "facts.jsonl")));
});

function servicesFor(root: string, remoteStoreRoot: string): InitStoreServices {
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
