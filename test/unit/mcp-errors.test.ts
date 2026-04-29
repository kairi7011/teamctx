import assert from "node:assert/strict";
import test from "node:test";
import { structuredMcpError } from "../../src/mcp/errors.js";

test("structuredMcpError classifies validation errors", () => {
  assert.deepEqual(structuredMcpError(new Error("tools/call params must include a tool name")), {
    kind: "validation",
    message: "tools/call params must include a tool name"
  });
});

test("structuredMcpError classifies binding errors", () => {
  assert.deepEqual(structuredMcpError(new Error("No teamctx binding found for this git root.")), {
    kind: "binding",
    message: "No teamctx binding found for this git root."
  });
});

test("structuredMcpError classifies auth errors", () => {
  assert.deepEqual(structuredMcpError(new Error("GitHub token is missing")), {
    kind: "auth",
    message: "GitHub token is missing"
  });
});

test("structuredMcpError classifies store errors", () => {
  assert.deepEqual(structuredMcpError(new Error("GitHub store write failed")), {
    kind: "store",
    message: "GitHub store write failed"
  });
});

test("structuredMcpError falls back to internal", () => {
  assert.deepEqual(structuredMcpError(new Error("unexpected failure")), {
    kind: "internal",
    message: "unexpected failure"
  });
});
