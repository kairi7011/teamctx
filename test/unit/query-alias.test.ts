import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  readQueryAliases,
  readQueryAliasesFromContextStore
} from "../../src/core/store/query-alias-loader.js";
import { parseQueryAliasConfig } from "../../src/schemas/query-alias.js";
import type {
  ContextStoreAdapter,
  ContextStoreFile,
  ContextStoreWriteOptions,
  ContextStoreWriteResult
} from "../../src/adapters/store/context-store.js";

test("parseQueryAliasConfig validates compound project aliases", () => {
  const config = parseQueryAliasConfig(
    JSON.stringify({
      schema_version: 1,
      aliases: [
        {
          id: "github-conflict",
          match: {
            all_pattern_groups: [["github"], ["conflict", "concurrency"]]
          },
          expand: {
            token_groups: [["commit", "github", "reduction", "store"], ["writeIfChanged"]]
          }
        }
      ]
    })
  );

  assert.deepEqual(config.aliases[0], {
    id: "github-conflict",
    enabled: true,
    match: {
      all_pattern_groups: [["github"], ["conflict", "concurrency"]]
    },
    expand: {
      token_groups: [["commit", "github", "reduction", "store"], ["writeifchanged"]]
    }
  });
});

test("parseQueryAliasConfig rejects overbroad single-pattern aliases", () => {
  assert.throws(
    () =>
      parseQueryAliasConfig(
        JSON.stringify({
          schema_version: 1,
          aliases: [
            {
              id: "too-broad",
              match: { patterns: ["github"] },
              expand: { token_groups: [["commit", "reduction"]] }
            }
          ]
        })
      ),
    /too broad/
  );
});

test("readQueryAliases loads local and remote project aliases", async (context) => {
  const { directory, cleanup } = tempDirectory();
  context.after(cleanup);
  const storeRoot = join(directory, ".teamctx");
  const content = JSON.stringify(
    {
      schema_version: 1,
      aliases: [
        {
          id: "release-handoff",
          match: { patterns: ["ship it"] },
          expand: {
            token_groups: [["release", "handoff"]],
            domains: ["release"],
            tags: ["handoff"],
            symbols: ["releaseHandoff"]
          }
        }
      ]
    },
    null,
    2
  );

  mkdirSync(join(storeRoot, "aliases"), { recursive: true });
  writeFileSync(join(storeRoot, "aliases", "query-aliases.json"), `${content}\n`);

  assert.deepEqual(readQueryAliases(storeRoot), [
    {
      id: "project:release-handoff",
      patterns: ["ship it"],
      tokenGroups: [["handoff", "release"]],
      domains: ["release"],
      tags: ["handoff"],
      symbols: ["releaseHandoff"]
    }
  ]);

  const store = new MemoryStore({
    "aliases/query-aliases.json": content
  });

  assert.deepEqual(await readQueryAliasesFromContextStore(store), [
    {
      id: "project:release-handoff",
      patterns: ["ship it"],
      tokenGroups: [["handoff", "release"]],
      domains: ["release"],
      tags: ["handoff"],
      symbols: ["releaseHandoff"]
    }
  ]);
});

function tempDirectory(): { directory: string; cleanup: () => void } {
  const directory = join(tmpdir(), `teamctx-query-alias-${Date.now()}-${Math.random()}`);
  mkdirSync(directory, { recursive: true });

  return {
    directory,
    cleanup: () => rmSync(directory, { recursive: true, force: true })
  };
}

class MemoryStore implements ContextStoreAdapter {
  readonly kind = "github" as const;

  constructor(private readonly files: Record<string, string>) {}

  async readText(path: string): Promise<ContextStoreFile | undefined> {
    const content = this.files[path];

    return content === undefined ? undefined : { path, content, revision: `${path}-rev` };
  }

  async writeText(
    _path: string,
    _content: string,
    _options?: ContextStoreWriteOptions
  ): Promise<ContextStoreWriteResult> {
    throw new Error("not implemented");
  }

  async deleteText(
    _path: string,
    _options?: ContextStoreWriteOptions
  ): Promise<ContextStoreWriteResult> {
    throw new Error("not implemented");
  }

  async appendJsonl(
    _path: string,
    _rows: unknown[],
    _options?: ContextStoreWriteOptions
  ): Promise<ContextStoreWriteResult> {
    throw new Error("not implemented");
  }

  async listFiles(_prefix: string): Promise<string[]> {
    return [];
  }

  async getRevision(): Promise<string | null> {
    return "remote-head";
  }
}
