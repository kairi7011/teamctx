import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildBootstrapPlan,
  discoverBootstrapSources
} from "../../src/core/bootstrap/bootstrap.js";

function tempDirectory(): { directory: string; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "teamctx-bootstrap-"));

  return {
    directory,
    cleanup: () => rmSync(directory, { recursive: true, force: true })
  };
}

test("discoverBootstrapSources finds high-signal project files and skips context store", (context) => {
  const { directory, cleanup } = tempDirectory();
  context.after(cleanup);

  mkdirSync(join(directory, "docs"), { recursive: true });
  mkdirSync(join(directory, ".github", "workflows"), { recursive: true });
  mkdirSync(join(directory, ".teamctx"), { recursive: true });
  writeFileSync(join(directory, "AGENTS.md"), "instructions\n", "utf8");
  writeFileSync(join(directory, "README.md"), "readme\n", "utf8");
  writeFileSync(join(directory, "package.json"), "{}\n", "utf8");
  writeFileSync(join(directory, "docs", "operations.md"), "ops\n", "utf8");
  writeFileSync(join(directory, ".github", "workflows", "ci.yml"), "name: ci\n", "utf8");
  writeFileSync(join(directory, ".teamctx", "README.md"), "store\n", "utf8");

  const sources = discoverBootstrapSources(directory, { excludePaths: [".teamctx"] });

  assert.deepEqual(
    sources.map((source) => source.path),
    ["AGENTS.md", "README.md", "package.json", "docs/operations.md", ".github/workflows/ci.yml"]
  );
  assert.equal(sources[0]?.doc_role, "runbook");
  assert.equal(sources[1]?.doc_role, "readme");
  assert.equal(sources[2]?.evidence_kind, "config");
});

test("buildBootstrapPlan includes reviewable commands and agent prompt", () => {
  const plan = buildBootstrapPlan({
    repo: "github.com/team/service",
    root: "C:/work/service",
    store: "github.com/team/context/contexts/service",
    localStore: false,
    sourceFiles: [
      {
        path: "README.md",
        reason: "project README",
        evidence_kind: "docs",
        doc_role: "readme",
        priority: 20
      }
    ]
  });

  assert.equal(plan.output_file, "teamctx-bootstrap-observations.json");
  assert.equal(plan.recommended_observation_count, "8-15");
  assert.deepEqual(plan.commands, [
    "teamctx record-verified teamctx-bootstrap-observations.json",
    "teamctx normalize --dry-run",
    "teamctx normalize",
    'teamctx context --call-reason session_start --query "initial project context"'
  ]);
  assert.match(plan.agent_prompt, /Read these source files first:/);
  assert.match(plan.agent_prompt, /README.md: project README/);
  assert.match(plan.agent_prompt, /Do not dump documentation/);
});
