import assert from "node:assert/strict";
import test from "node:test";
import { formatBindReport } from "../../src/cli/index.js";
import type { Binding } from "../../src/schemas/types.js";

test("formatBindReport renders repo root and context store", () => {
  const binding: Binding = {
    repo: "github.com/team/service",
    root: "C:/repo/service",
    createdAt: "2026-05-03T00:00:00.000Z",
    contextStore: {
      provider: "github",
      repo: "github.com/team/context",
      path: "contexts/service"
    }
  };

  assert.equal(
    formatBindReport(binding),
    [
      "Bound repository:",
      "  repo: github.com/team/service",
      "  root: C:/repo/service",
      "  store: github.com/team/context/contexts/service"
    ].join("\n")
  );
});
