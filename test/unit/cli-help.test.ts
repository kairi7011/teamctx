import assert from "node:assert/strict";
import test from "node:test";
import { formatHelp, parseArgs } from "../../src/cli/index.js";

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

test("formatHelp includes stable command usage", () => {
  const help = formatHelp();

  assert.match(help, /^teamctx/);
  assert.match(help, /Usage:/);
  assert.match(help, /teamctx setup <store> \[--path <path>\] \[--json\]/);
  assert.match(help, /teamctx normalize \[--dry-run\] \[--json\]/);
  assert.match(help, /teamctx compact \[--dry-run\] \[--json\]/);
  assert.match(help, /teamctx context-diff <left-json> <right-json>/);
  assert.match(help, /teamctx query-explain \[json-file\]/);
  assert.match(help, /teamctx record-verified <json-file> \[--json\]/);
  assert.match(help, /teamctx auth doctor/);
  assert.match(help, /teamctx tools \[--json\]/);
  assert.match(help, /teamctx capabilities \[--json\]/);
  assert.match(help, /Examples:/);
});
