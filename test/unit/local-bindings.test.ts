import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  findBinding,
  loadBindings,
  saveBindings,
  upsertBinding
} from "../../src/core/binding/local-bindings.js";
import type { BindingsFile, ContextStore } from "../../src/schemas/types.js";

function createTempConfigPath(): { configPath: string; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "teamctx-bindings-"));

  return {
    configPath: join(directory, "nested", "bindings.json"),
    cleanup: () => rmSync(directory, { recursive: true, force: true })
  };
}

test("loadBindings returns an empty config when the file is missing", (context) => {
  const { configPath, cleanup } = createTempConfigPath();
  context.after(cleanup);

  assert.deepEqual(loadBindings(configPath), {
    version: 1,
    bindings: {}
  });
});

test("saveBindings writes config files that loadBindings can read", (context) => {
  const { configPath, cleanup } = createTempConfigPath();
  context.after(cleanup);

  const file: BindingsFile = {
    version: 1,
    bindings: {}
  };

  saveBindings(file, configPath);

  assert.deepEqual(loadBindings(configPath), file);
});

test("upsertBinding persists and findBinding reads a repo binding", (context) => {
  const { configPath, cleanup } = createTempConfigPath();
  context.after(cleanup);

  const contextStore: ContextStore = {
    provider: "github",
    repo: "github.com/team/context",
    path: "contexts/service"
  };

  const binding = upsertBinding(
    "github.com/team/service",
    "C:/work/service",
    contextStore,
    configPath
  );

  assert.equal(binding.repo, "github.com/team/service");
  assert.equal(binding.root, "C:/work/service");
  assert.deepEqual(binding.contextStore, contextStore);
  assert.match(binding.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(findBinding("github.com/team/service", configPath), binding);
});
