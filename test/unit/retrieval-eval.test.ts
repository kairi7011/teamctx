import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateRetrievalFixture,
  validateRetrievalEvalFixture
} from "../../src/core/eval/retrieval.js";
import {
  fixtureDisabledContextPayload,
  fixtureEnabledContextPayload
} from "../fixtures/context-payload.js";

test("evaluateRetrievalFixture scores gold ids tags negatives and token budgets", async () => {
  const fixture = [
    {
      case: "A",
      level: 1,
      query: "auth request",
      gold_ids: ["rule-auth-order"]
    },
    {
      case: "B",
      level: 2,
      query: "lifecycle",
      gold_tags: ["request-lifecycle"]
    },
    {
      case: "C",
      level: 1,
      query: "typo only",
      gold_tags: [],
      negative: true
    }
  ];
  const result = await evaluateRetrievalFixture(fixture, async (input) => {
    assert.equal(input.call_reason, "session_start");

    if (input.query === "typo only") {
      return fixtureEnabledContextPayload({
        normalized_context: {
          ...fixtureEnabledContextPayload().normalized_context,
          scoped: []
        }
      });
    }

    return fixtureEnabledContextPayload();
  });

  assert.deepEqual(result.summary, {
    total_prompts: 3,
    non_negative: 2,
    negative: 1,
    gold_hits: 2,
    gold_total: 2,
    prompt_full_hit: 2,
    prompt_any_hit: 2,
    false_positive_prompts: 0,
    max_tokens: 8,
    levels: {
      "1": {
        prompts: 2,
        gold_hits: 1,
        gold_total: 1,
        full_hit: 1,
        any_hit: 1,
        false_positive_prompts: 0,
        max_tokens: 8
      },
      "2": {
        prompts: 1,
        gold_hits: 1,
        gold_total: 1,
        full_hit: 1,
        any_hit: 1,
        false_positive_prompts: 0,
        max_tokens: 8
      }
    }
  });
  assert.deepEqual(result.rows[0]?.returned, [
    {
      id: "rule-auth-order",
      kind: "rule",
      tags: ["request-lifecycle"]
    }
  ]);
});

test("evaluateRetrievalFixture reports disabled payloads without throwing", async () => {
  const result = await evaluateRetrievalFixture(
    [
      {
        case: "A",
        level: 1,
        query: "auth request",
        gold_ids: ["rule-auth-order"]
      }
    ],
    async () => fixtureDisabledContextPayload({ reason: "not bound" })
  );

  assert.equal(result.rows[0]?.disabled_reason, "not bound");
  assert.equal(result.summary.gold_hits, 0);
});

test("validateRetrievalEvalFixture rejects missing gold for non-negative cases", () => {
  assert.throws(
    () =>
      validateRetrievalEvalFixture([
        {
          case: "A",
          level: 1,
          query: "auth request"
        }
      ]),
    /gold_ids or gold_tags/
  );
});
