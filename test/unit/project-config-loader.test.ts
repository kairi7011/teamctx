import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  ContextStoreAdapter,
  ContextStoreFile,
  ContextStoreWriteOptions,
  ContextStoreWriteResult
} from "../../src/adapters/store/context-store.js";
import {
  readProjectConfig,
  readProjectConfigFromContextStore,
  resolveBudgetsFromConfig
} from "../../src/core/store/project-config-loader.js";
import type { ProjectConfig } from "../../src/schemas/project.js";

test("resolveBudgetsFromConfig prefers content_tokens", () => {
  assert.equal(
    resolveBudgetsFromConfig(projectConfig({ content_tokens: 80, content_chars: 200 }))
      .contentTokens,
    80
  );
});

test("resolveBudgetsFromConfig maps legacy content_chars to approximate tokens", () => {
  assert.equal(resolveBudgetsFromConfig(projectConfig({ content_chars: 200 })).contentTokens, 50);
});

test("readProjectConfig returns undefined for missing config and rejects invalid config", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "teamctx-project-config-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));

  assert.equal(readProjectConfig(directory), undefined);

  writeFileSync(
    join(directory, "project.yaml"),
    [
      "format_version: 1",
      'project_id: "test"',
      'normalizer_version: "0.1.0"',
      "retention:",
      "  raw_candidate_days: 30",
      "  audit_days: 180",
      '  archive_path: "archive/"',
      "context_budgets:",
      "  scoped_items: 0",
      ""
    ].join("\n"),
    "utf8"
  );

  assert.throws(() => readProjectConfig(directory), /Invalid teamctx project config/);
});

test("readProjectConfigFromContextStore rejects invalid remote config", async () => {
  const store = new MemoryStore();

  await store.writeText(
    "project.yaml",
    [
      "format_version: 1",
      'project_id: "test"',
      'normalizer_version: "0.1.0"',
      "retention:",
      "  raw_candidate_days: 30",
      "  audit_days: 180",
      '  archive_path: "archive/"',
      "context_budgets:",
      "  content_tokens: -1",
      ""
    ].join("\n"),
    { message: "seed" }
  );

  await assert.rejects(
    readProjectConfigFromContextStore(store),
    /Invalid teamctx project config project.yaml/
  );
});

function projectConfig(contextBudgets: ProjectConfig["context_budgets"]): ProjectConfig {
  const config: ProjectConfig = {
    format_version: 1,
    project_id: "github.com/team/service",
    normalizer_version: "0.1.0",
    retention: {
      raw_candidate_days: 30,
      audit_days: 180,
      archive_path: "archive/"
    }
  };

  if (contextBudgets !== undefined) {
    config.context_budgets = contextBudgets;
  }

  return config;
}

class MemoryStore implements ContextStoreAdapter {
  private readonly files = new Map<string, string>();

  async getRevision(): Promise<string | null> {
    return null;
  }

  async readText(path: string): Promise<ContextStoreFile | undefined> {
    const content = this.files.get(path);

    return content === undefined ? undefined : { path, content, revision: null };
  }

  async writeText(
    path: string,
    content: string,
    _options: ContextStoreWriteOptions
  ): Promise<ContextStoreWriteResult> {
    this.files.set(path, content);

    return { path, revision: null, storeRevision: null };
  }

  async deleteText(
    path: string,
    _options: ContextStoreWriteOptions
  ): Promise<ContextStoreWriteResult> {
    this.files.delete(path);

    return { path, revision: null, storeRevision: null };
  }

  async appendJsonl(
    path: string,
    rows: unknown[],
    options: ContextStoreWriteOptions
  ): Promise<ContextStoreWriteResult> {
    return this.writeText(path, rows.map((row) => JSON.stringify(row)).join("\n"), options);
  }

  async listFiles(path: string): Promise<string[]> {
    return [...this.files.keys()].filter((file) => file.startsWith(path));
  }
}
