import assert from "node:assert/strict";
import test from "node:test";
import { expandQueryTokens } from "../../src/core/indexes/query-tokens.js";

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
