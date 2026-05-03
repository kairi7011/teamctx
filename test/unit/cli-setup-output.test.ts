import assert from "node:assert/strict";
import test from "node:test";
import { SETUP_NEXT_STEPS, formatSetupReport } from "../../src/cli/index.js";
import type { Binding } from "../../src/schemas/types.js";

const binding: Binding = {
  repo: "github.com/team/service",
  root: "C:/work/service",
  contextStore: {
    provider: "github",
    repo: "github.com/team/context",
    path: "contexts/service"
  },
  createdAt: "2026-04-21T10:00:00.000Z"
};

test("formatSetupReport renders binding, init counts, and next steps", () => {
  const formatted = formatSetupReport(binding, {
    store: "github.com/team/context/contexts/service",
    localStore: false,
    createdFiles: ["a.json", "b.json"],
    existingFiles: ["c.json"]
  });

  assert.equal(
    formatted,
    [
      "Set up teamctx:",
      "  repo: github.com/team/service",
      "  root: C:/work/service",
      "  store: github.com/team/context/contexts/service",
      "  created_files: 2",
      "  existing_files: 1",
      "  next: teamctx record-verified observations.json",
      "  next: teamctx normalize",
      "  next: teamctx context --target-files <file>"
    ].join("\n")
  );
});

test("formatSetupReport iterates SETUP_NEXT_STEPS in order", () => {
  const formatted = formatSetupReport(binding, {
    store: "github.com/team/context/contexts/service",
    localStore: false,
    createdFiles: [],
    existingFiles: []
  });

  const nextLines = formatted
    .split("\n")
    .filter((line) => line.startsWith("  next: "))
    .map((line) => line.replace("  next: ", ""));

  assert.deepEqual(nextLines, [...SETUP_NEXT_STEPS]);
});

test("SETUP_NEXT_STEPS exposes the documented post-setup commands", () => {
  assert.deepEqual(
    [...SETUP_NEXT_STEPS],
    [
      "teamctx record-verified observations.json",
      "teamctx normalize",
      "teamctx context --target-files <file>"
    ]
  );
});
