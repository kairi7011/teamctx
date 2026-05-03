import assert from "node:assert/strict";
import test from "node:test";
import {
  inferSelectorsFromQuery,
  resolveContextInputSelectors
} from "../../src/core/context/selector-inference.js";

test("inferSelectorsFromQuery extracts repository paths and code symbols conservatively", () => {
  const inferred = inferSelectorsFromQuery(
    [
      "Inspect src/cli/index.ts parseArgs/shouldPrintHelp handling",
      "and src/core/normalize/normalize.ts writeIfChanged behavior."
    ].join(" ")
  );

  assert.deepEqual(inferred.target_files, ["src/cli/index.ts", "src/core/normalize/normalize.ts"]);
  assert.deepEqual(inferred.symbols, ["parseArgs", "shouldPrintHelp", "writeIfChanged"]);
  assert.deepEqual(inferred.domains, []);
  assert.deepEqual(inferred.tags, []);
});

test("resolveContextInputSelectors preserves explicit selectors and reports only added inferred selectors", () => {
  const resolved = resolveContextInputSelectors({
    target_files: ["src/cli/index.ts"],
    symbols: ["parseArgs"],
    query: "src/cli/index.ts and src/cli/cli-args.ts parseArgs/parseCsvFlag"
  });

  assert.deepEqual(resolved.input.target_files, ["src/cli/index.ts", "src/cli/cli-args.ts"]);
  assert.deepEqual(resolved.input.symbols, ["parseArgs", "parseCsvFlag"]);
  assert.deepEqual(resolved.inferred_selectors.target_files, ["src/cli/cli-args.ts"]);
  assert.deepEqual(resolved.inferred_selectors.symbols, ["parseCsvFlag"]);
});

test("inferSelectorsFromQuery ignores prose-only prompts", () => {
  const inferred = inferSelectorsFromQuery("fix the usual CLI flow and reduce noisy context");

  assert.deepEqual(inferred.target_files, []);
  assert.deepEqual(inferred.symbols, []);
});
