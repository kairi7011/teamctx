import assert from "node:assert/strict";
import test from "node:test";
import { parseContextStore } from "../../src/core/binding/context-store.js";

test("parseContextStore normalizes explicit GitHub stores", () => {
  assert.deepEqual(parseContextStore("https://github.com/team/context.git", "contexts/service"), {
    provider: "github",
    repo: "github.com/team/context",
    path: "contexts/service"
  });
});

test("parseContextStore supports using the current repo as the store", () => {
  assert.deepEqual(parseContextStore(".", ".teamctx", "github.com/team/service"), {
    provider: "github",
    repo: "github.com/team/service",
    path: ".teamctx"
  });
});

test("parseContextStore rejects current repo stores without a repo identity", () => {
  assert.throws(
    () => parseContextStore("."),
    /Cannot use '\.' as context store outside a git repository/
  );
});
