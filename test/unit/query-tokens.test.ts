import assert from "node:assert/strict";
import test from "node:test";
import { expandQueryTokens, queryAliasSelectors } from "../../src/core/indexes/query-tokens.js";

test("expandQueryTokens builds overlap windows for detailed prose queries", () => {
  const expansion = expandQueryTokens(
    "Python agent_service and Rust custom_objects_service verification with pytest cargo clippy"
  );

  assert.ok(expansion.tokenGroups.some((group) => group.includes("agent_service")));
  assert.ok(expansion.tokenGroups.some((group) => group.includes("custom_objects_service")));
  assert.ok(
    expansion.tokenGroups.some(
      (group) => group.includes("cargo") && group.includes("clippy") && group.length === 2
    )
  );
});

test("expandQueryTokens keeps broad single-token queries guarded", () => {
  assert.deepEqual(expandQueryTokens("context"), {
    tokenGroups: [],
    matchedAliasIds: []
  });
});

test("expandQueryTokens matches project alias patterns case-insensitively", () => {
  const expansion = expandQueryTokens("DB周りの実装修正", [
    {
      id: "project:database-work",
      patterns: ["DB周り"],
      tokenGroups: [["sqlmodel", "prisma"]]
    }
  ]);

  assert.deepEqual(expansion, {
    tokenGroups: [["prisma", "sqlmodel"]],
    matchedAliasIds: ["project:database-work"]
  });
});

test("expandQueryTokens honors explicit context opt-out phrases", () => {
  const expansion = expandQueryTokens("READMEのtypoだけ直す。設計調査は不要", [
    {
      id: "project:steering",
      patterns: ["設計調査"],
      tokenGroups: [["steering", "first"]]
    }
  ]);

  assert.deepEqual(expansion, {
    tokenGroups: [],
    matchedAliasIds: []
  });
});

test("expandQueryTokens does not treat evaluation arm labels as opt-out", () => {
  const alias = {
    id: "project:output-quality-runpack",
    allPatternGroups: [
      ["output quality"],
      [
        "runpack",
        "no context",
        "explicit handoff",
        "scoring",
        "a_no_context",
        "b_teamctx_context",
        "c_explicit_handoff"
      ]
    ],
    tokenGroups: [["runpack"]]
  };
  const armLabelQuery =
    "output quality A_no_context / B_teamctx_context / C_explicit_handoff scoring";

  assert.deepEqual(expandQueryTokens(armLabelQuery, [alias]), {
    tokenGroups: [["runpack"]],
    matchedAliasIds: ["project:output-quality-runpack"]
  });
  assert.deepEqual(
    queryAliasSelectors(armLabelQuery, [
      {
        ...alias,
        domains: ["validation"],
        tags: ["output-quality-runpack"],
        symbols: ["create-output-quality-run"]
      }
    ]),
    {
      domains: ["validation"],
      tags: ["output-quality-runpack"],
      symbols: ["create-output-quality-run"]
    }
  );
});

test("expandQueryTokens keeps scoring queries opted out when context is explicitly unwanted", () => {
  const query = "no context, just fix the teamctx explicit handoff scoring bug";
  const alias = {
    id: "project:scoring",
    patterns: ["scoring"],
    tokenGroups: [["scoring"]],
    domains: ["validation"],
    tags: ["quality-proof"],
    symbols: ["scoreRun"]
  };

  assert.deepEqual(expandQueryTokens(query, [alias]), {
    tokenGroups: [],
    matchedAliasIds: []
  });
  assert.deepEqual(queryAliasSelectors(query, [alias]), {
    domains: [],
    tags: [],
    symbols: []
  });
});
