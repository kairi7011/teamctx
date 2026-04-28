import assert from "node:assert/strict";
import test from "node:test";
import {
  approximateTokenCount,
  rankedTexts,
  scopedContextItem,
  type RankedRecord
} from "../../src/core/context/context-ranking.js";
import type { NormalizedRecord } from "../../src/schemas/normalized-record.js";

test("approximateTokenCount counts words and punctuation as tokens", () => {
  assert.equal(approximateTokenCount("Use auth middleware, then resolve tenant."), 8);
});

test("rankedTexts truncates by approximate token count", () => {
  assert.deepEqual(rankedTexts([ranked("one two three four five")], 3), ["one two three..."]);
});

test("scopedContextItem truncates content by approximate token count", () => {
  assert.equal(scopedContextItem(ranked("alpha beta gamma delta"), 2).content, "alpha beta...");
});

function ranked(text: string): RankedRecord {
  return {
    record: record(text),
    score: 1,
    reasons: ["test"],
    recency: 0
  };
}

function record(text: string): NormalizedRecord {
  return {
    id: "record-token-budget",
    schema_version: 1,
    normalizer_version: "0.1.0",
    kind: "rule",
    state: "active",
    text,
    scope: {
      paths: ["src/**"],
      domains: [],
      symbols: [],
      tags: []
    },
    evidence: [
      {
        kind: "code",
        repo: "github.com/team/service",
        commit: "abc123",
        file: "src/index.ts"
      }
    ],
    provenance: {
      recorded_by: "codex",
      session_id: "session-1",
      observed_at: "2026-04-22T10:00:00.000Z"
    },
    confidence_level: "medium",
    supersedes: [],
    conflicts_with: []
  };
}
