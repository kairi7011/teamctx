import assert from "node:assert/strict";
import test from "node:test";
import { formatHelp, parseArgs, shouldPrintHelp } from "../../src/cli/index.js";

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
});

test("formatHelp includes stable command usage", () => {
  const help = formatHelp();

  assert.match(help, /^teamctx/);
  assert.match(help, /Usage:/);
  assert.match(help, /teamctx setup <store> \[--path <path>\] \[--json\]/);
  assert.match(help, /teamctx normalize \[--dry-run\] \[--lease\] \[--json\]/);
  assert.match(help, /teamctx compact \[--dry-run\] \[--json\]/);
  assert.match(help, /teamctx context-diff <left-json> <right-json>/);
  assert.match(help, /teamctx query-explain \[json-file\]/);
  assert.match(help, /teamctx record-verified <json-file> \[--json\]/);
  assert.match(help, /teamctx auth doctor/);
  assert.match(help, /teamctx tools \[--json\]/);
  assert.match(help, /teamctx capabilities \[--json\]/);
  assert.match(help, /Examples:/);
});
