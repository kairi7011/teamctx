import assert from "node:assert/strict";
import test from "node:test";
import { jsonlLines, parseJsonlValidated } from "../../src/core/store/jsonl.js";

test("jsonlLines trims whitespace and skips blank lines", () => {
  assert.deepEqual(jsonlLines("  a  \n\n  b\n   \nc"), ["a", "b", "c"]);
  assert.deepEqual(jsonlLines(""), []);
  assert.deepEqual(jsonlLines("\n   \n"), []);
});

test("parseJsonlValidated runs the validator on each line", () => {
  const validate = (value: unknown): { id: string } => {
    if (typeof value !== "object" || value === null || !("id" in value)) {
      throw new Error("missing id");
    }

    return value as { id: string };
  };

  const parsed = parseJsonlValidated('{"id":"a"}\n{"id":"b"}\n', validate);
  assert.deepEqual(parsed, [{ id: "a" }, { id: "b" }]);
});

test("parseJsonlValidated returns empty array for blank content", () => {
  assert.deepEqual(
    parseJsonlValidated("", () => {
      throw new Error("should not be called");
    }),
    []
  );
});
