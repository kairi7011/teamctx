import assert from "node:assert/strict";
import test from "node:test";
import { formatCapturePlan } from "../../src/cli/index.js";

test("formatCapturePlan renders the session-end capture packet", () => {
  const formatted = formatCapturePlan(
    {
      repo: "github.com/team/service",
      root: "C:/work/service",
      store: "github.com/team/context/contexts/service",
      local_store: false,
      branch: "main",
      head_commit: "abc123",
      recommended_observation_count: "3-10",
      output_file: "teamctx-capture-observations.json",
      sources: {
        changed_files: ["src/index.ts"],
        untracked_files: ["notes/new.md"],
        recent_commits: ["abc123 Add feature"]
      },
      commands: [
        "teamctx record-verified teamctx-capture-observations.json",
        "teamctx normalize --dry-run",
        "teamctx normalize"
      ],
      agent_prompt: [
        "Capture durable teamctx knowledge from the latest work.",
        "",
        "Changed files:",
        "- src/index.ts"
      ].join("\n")
    },
    {
      store: "github.com/team/context/contexts/service",
      localStore: false,
      createdFiles: [],
      existingFiles: ["project.yaml"]
    }
  );

  assert.equal(
    formatted,
    [
      "Capture teamctx knowledge from recent work:",
      "  repo: github.com/team/service",
      "  root: C:/work/service",
      "  store: github.com/team/context/contexts/service",
      "  branch: main",
      "  head_commit: abc123",
      "  changed_files: 1",
      "  untracked_files: 1",
      "  recent_commits: 1",
      "  recommended_observations: 3-10",
      "  output_file: teamctx-capture-observations.json",
      "  created_files: 0",
      "  existing_files: 1",
      "Agent prompt:",
      "  Capture durable teamctx knowledge from the latest work.",
      "",
      "  Changed files:",
      "  - src/index.ts"
    ].join("\n")
  );
});
