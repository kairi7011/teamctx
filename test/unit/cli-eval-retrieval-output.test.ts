import assert from "node:assert/strict";
import test from "node:test";
import { formatRetrievalEvalResult } from "../../src/cli/index.js";

test("formatRetrievalEvalResult renders a compact terminal summary", () => {
  const formatted = formatRetrievalEvalResult({
    summary: {
      total_prompts: 2,
      non_negative: 1,
      negative: 1,
      gold_hits: 1,
      gold_total: 1,
      prompt_full_hit: 1,
      prompt_any_hit: 1,
      false_positive_prompts: 0,
      max_tokens: 42,
      levels: {
        "1": {
          prompts: 2,
          gold_hits: 1,
          gold_total: 1,
          full_hit: 1,
          any_hit: 1,
          false_positive_prompts: 0,
          max_tokens: 42
        }
      }
    },
    rows: []
  });

  assert.equal(
    formatted,
    [
      "Retrieval eval:",
      "  prompts: 2",
      "  gold_hits: 1/1",
      "  full_hit_prompts: 1/1",
      "  any_hit_prompts: 1/1",
      "  false_positive_prompts: 0/2",
      "  negative_prompts: 1",
      "  max_tokens: 42",
      "  levels:",
      "    - 1: gold=1/1 full=1 any=1 fp=0 max_tokens=42"
    ].join("\n")
  );
});
