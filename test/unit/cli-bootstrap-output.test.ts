import assert from "node:assert/strict";
import test from "node:test";
import { formatBootstrapPlan } from "../../src/cli/index.js";

test("formatBootstrapPlan renders the initial context bootstrap packet", () => {
  const formatted = formatBootstrapPlan(
    {
      repo: "github.com/team/service",
      root: "C:/work/service",
      store: "github.com/team/context/contexts/service",
      local_store: false,
      recommended_observation_count: "8-15",
      recommended_alias_count: "3-8",
      output_file: "teamctx-bootstrap-observations.json",
      alias_file: "aliases/query-aliases.json",
      eval_fixture_file: "teamctx-bootstrap-retrieval-fixture.json",
      source_files: [
        {
          path: "README.md",
          reason: "project README",
          evidence_kind: "docs",
          doc_role: "readme",
          priority: 20
        }
      ],
      commands: [
        "teamctx record-verified teamctx-bootstrap-observations.json",
        "teamctx normalize --dry-run",
        "teamctx normalize",
        "teamctx eval-retrieval teamctx-bootstrap-retrieval-fixture.json"
      ],
      agent_prompt: [
        "Create initial teamctx context for this repository.",
        "",
        "Read these source files first:",
        "- README.md: project README"
      ].join("\n")
    },
    {
      store: "github.com/team/context/contexts/service",
      localStore: false,
      createdFiles: ["project.yaml"],
      existingFiles: ["normalized/facts.jsonl"]
    }
  );

  assert.equal(
    formatted,
    [
      "Bootstrap teamctx initial context:",
      "  repo: github.com/team/service",
      "  root: C:/work/service",
      "  store: github.com/team/context/contexts/service",
      "  local_store: false",
      "  source_files: 1",
      "  recommended_observations: 8-15",
      "  recommended_aliases: 3-8",
      "  output_file: teamctx-bootstrap-observations.json",
      "  alias_file: aliases/query-aliases.json",
      "  eval_fixture_file: teamctx-bootstrap-retrieval-fixture.json",
      "  created_files: 1",
      "  existing_files: 1",
      "Source files to inspect:",
      "  - README.md (project README)",
      "Agent prompt:",
      "  Create initial teamctx context for this repository.",
      "",
      "  Read these source files first:",
      "  - README.md: project README"
    ].join("\n")
  );
});
