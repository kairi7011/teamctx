import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contextInput, formatHelp, parseArgs, shouldPrintHelp } from "../../src/cli/index.js";
import { CliError, CLI_EXIT } from "../../src/cli/cli-error.js";

test("parseArgs defaults to help without arguments", () => {
  assert.deepEqual(parseArgs([]), {
    command: "help",
    positional: [],
    flags: {}
  });
});

test("parseArgs separates positional values and flags", () => {
  assert.deepEqual(
    parseArgs([
      "rank",
      "--target-files",
      "src/index.ts,README.md",
      "--domains",
      "cli",
      "extra",
      "--json"
    ]),
    {
      command: "rank",
      positional: ["extra"],
      flags: {
        "target-files": "src/index.ts,README.md",
        domains: "cli",
        json: true
      }
    }
  );
});

test("parseArgs accumulates repeatable selector flags", () => {
  assert.deepEqual(
    parseArgs([
      "context",
      "--target-files",
      "src/index.ts",
      "--target-files",
      "README.md",
      "--domains",
      "cli",
      "--domains",
      "mcp",
      "--symbols",
      "main",
      "--symbols",
      "getContextToolAsync",
      "--tags",
      "preview-cli",
      "--tags",
      "call-policy",
      "--query",
      "context preview"
    ]),
    {
      command: "context",
      positional: [],
      flags: {
        "target-files": ["src/index.ts", "README.md"],
        domains: ["cli", "mcp"],
        symbols: ["main", "getContextToolAsync"],
        tags: ["preview-cli", "call-policy"],
        query: "context preview"
      }
    }
  );
});

test("parseArgs only treats path as repeatable for list selectors", () => {
  assert.deepEqual(parseArgs(["setup", ".", "--path", "first", "--path", "second"]), {
    command: "setup",
    positional: ["."],
    flags: { path: "second" }
  });

  assert.deepEqual(parseArgs(["list", "--path", "src/index.ts", "--path", "README.md"]), {
    command: "list",
    positional: [],
    flags: { path: ["src/index.ts", "README.md"] }
  });
});

test("parseArgs treats command-level help flags as boolean help requests", () => {
  assert.deepEqual(parseArgs(["normalize", "--help"]), {
    command: "normalize",
    positional: [],
    flags: { help: true }
  });
  assert.equal(shouldPrintHelp(parseArgs(["normalize", "--help"])), true);
  assert.equal(shouldPrintHelp(parseArgs(["normalize", "-h"])), true);
  assert.deepEqual(parseArgs(["normalize", "--dry-run", "-h"]), {
    command: "normalize",
    positional: [],
    flags: {
      "dry-run": true,
      h: true
    }
  });
  assert.equal(shouldPrintHelp(parseArgs(["normalize", "--dry-run", "-h"])), true);
});

test("parseArgs treats known boolean flags as value-less before positional args", () => {
  assert.deepEqual(parseArgs(["context-diff", "--json", "before.json", "after.json"]), {
    command: "context-diff",
    positional: ["before.json", "after.json"],
    flags: { json: true }
  });

  assert.deepEqual(parseArgs(["context-diff", "before.json", "--json", "after.json"]), {
    command: "context-diff",
    positional: ["before.json", "after.json"],
    flags: { json: true }
  });

  assert.deepEqual(parseArgs(["hygiene", "--plan", "--json"]), {
    command: "hygiene",
    positional: [],
    flags: { plan: true, json: true }
  });
});

test("parseArgs rejects missing values for value flags", () => {
  assert.throws(
    () => parseArgs(["context", "--target-files", "--domains", "cli"]),
    (error: unknown) => error instanceof CliError && error.code === CLI_EXIT.USAGE
  );
});

test("contextInput merges aliases and lets CLI flags override json input", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "teamctx-cli-input-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const inputPath = join(directory, "input.json");

  writeFileSync(
    inputPath,
    `${JSON.stringify({
      domains: ["json-domain"],
      query: "from file",
      call_reason: "task_start"
    })}\n`,
    "utf8"
  );

  assert.deepEqual(
    contextInput(
      parseArgs([
        "context",
        inputPath,
        "--target-files",
        "src/cli/index.ts",
        "--target-files",
        "README.md",
        "--changed-files",
        "src/cli/cli-args.ts",
        "--domain",
        "cli",
        "--domains",
        "mcp,context-preview",
        "--symbol",
        "parseArgs",
        "--symbols",
        "contextInput",
        "--tag",
        "cli",
        "--tags",
        "preview",
        "--source-types",
        "inferred_from_code,inferred_from_docs",
        "--evidence-files",
        "src/cli/index.ts",
        "--query",
        "from flags",
        "--since",
        "2026-04-22T00:00:00.000Z",
        "--until",
        "2026-04-23T00:00:00.000Z",
        "--branch",
        "main",
        "--head-commit",
        "abc123",
        "--call-reason",
        "session_start",
        "--previous-context-payload-hash",
        "abc123",
        "--force-refresh"
      ])
    ),
    {
      target_files: ["src/cli/index.ts", "README.md"],
      changed_files: ["src/cli/cli-args.ts"],
      domains: ["cli", "mcp", "context-preview"],
      symbols: ["parseArgs", "contextInput"],
      tags: ["cli", "preview"],
      source_types: ["inferred_from_code", "inferred_from_docs"],
      evidence_files: ["src/cli/index.ts"],
      query: "from flags",
      since: "2026-04-22T00:00:00.000Z",
      until: "2026-04-23T00:00:00.000Z",
      branch: "main",
      head_commit: "abc123",
      call_reason: "session_start",
      previous_context_payload_hash: "abc123",
      force_refresh: true
    }
  );
});

test("formatHelp includes stable command usage", () => {
  const help = formatHelp();

  assert.match(help, /^teamctx/);
  assert.match(help, /Usage:/);
  assert.match(help, /teamctx setup <store> \[--path <path>\] \[--json\]/);
  assert.match(help, /teamctx bootstrap \[<store>\] \[--path <path>\] \[--json\]/);
  assert.match(help, /teamctx capture \[--since-ref <ref>\] \[--json\]/);
  assert.match(help, /teamctx normalize \[--dry-run\] \[--lease\] \[--json\]/);
  assert.match(help, /teamctx compact \[--dry-run\] \[--json\]/);
  assert.match(help, /teamctx context \[json-file\] \[--target-files <files>\]/);
  assert.match(help, /teamctx context-diff <left-json> <right-json>/);
  assert.match(help, /teamctx query-explain \[json-file\]/);
  assert.match(
    help,
    /teamctx hygiene \[--older-than-days <n>\] \[--large-record-tokens <n>\].*\[--plan\]/
  );
  assert.match(help, /teamctx record-verified <json-file> \[--json\]/);
  assert.match(help, /teamctx auth doctor/);
  assert.match(help, /teamctx tools \[--json\]/);
  assert.match(help, /teamctx capabilities \[--json\]/);
  assert.match(help, /Examples:/);
});
