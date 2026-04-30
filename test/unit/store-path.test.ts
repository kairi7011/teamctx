import assert from "node:assert/strict";
import test from "node:test";
import { joinStorePath, normalizeStorePath } from "../../src/adapters/store/store-path.js";

test("normalizeStorePath strips leading and trailing slashes and converts backslashes", () => {
  assert.equal(normalizeStorePath("/normalized/facts.jsonl/"), "normalized/facts.jsonl");
  assert.equal(normalizeStorePath("normalized\\facts.jsonl"), "normalized/facts.jsonl");
  assert.equal(normalizeStorePath("indexes/path-index.json"), "indexes/path-index.json");
});

test("normalizeStorePath rejects empty, current, and parent traversal segments", () => {
  assert.throws(() => normalizeStorePath(""));
  assert.throws(() => normalizeStorePath("."));
  assert.throws(() => normalizeStorePath("a/../b"));
  assert.throws(() => normalizeStorePath("../escape"));
});

test("normalizeStorePath honors a custom error message", () => {
  assert.throws(
    () => normalizeStorePath("..", { errorMessage: "custom message" }),
    (error: unknown) => error instanceof Error && error.message === "custom message"
  );
});

test("joinStorePath joins parts and validates the result", () => {
  assert.equal(joinStorePath("indexes", "path-index.json"), "indexes/path-index.json");
  assert.throws(() => joinStorePath("a", "..", "b"));
});
