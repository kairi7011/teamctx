import assert from "node:assert/strict";
import test from "node:test";
import { cliCommands } from "../../src/cli/index.js";

test("cliCommands registry exposes every documented command", () => {
  const registered = new Set(Object.keys(cliCommands));
  const required = [
    "bind",
    "setup",
    "bootstrap",
    "init-store",
    "normalize",
    "compact",
    "context",
    "context-diff",
    "query-explain",
    "rank",
    "list",
    "audit",
    "record-candidate",
    "record-verified",
    "first-record",
    "show",
    "explain",
    "explain-episode",
    "invalidate",
    "status",
    "doctor",
    "auth",
    "tools",
    "capabilities",
    "help",
    "--help",
    "-h"
  ];

  for (const command of required) {
    assert.equal(typeof cliCommands[command], "function", `missing handler for ${command}`);
  }

  for (const name of registered) {
    assert.ok(required.includes(name), `unexpected command in registry: ${name}`);
  }
});
