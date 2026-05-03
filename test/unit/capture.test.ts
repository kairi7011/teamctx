import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCapturePlan,
  discoverCaptureSources,
  type CaptureDiscoveryServices
} from "../../src/core/capture/capture.js";

test("discoverCaptureSources reads working tree changes and excludes context store", () => {
  const services = fakeGit({
    "diff --name-only": "src/index.ts\n.teamctx/raw/events/a.json\n",
    "diff --cached --name-only": "README.md\nsrc/index.ts\n",
    "ls-files --others --exclude-standard": "notes/new.md\n.teamctx/tmp.json\n",
    "log --oneline --max-count=8": "abc123 Add feature\ndef456 Fix tests\n"
  });

  const sources = discoverCaptureSources("C:/work/service", {
    excludePaths: [".teamctx"],
    services
  });

  assert.deepEqual(sources.changed_files, ["README.md", "src/index.ts"]);
  assert.deepEqual(sources.untracked_files, ["notes/new.md"]);
  assert.deepEqual(sources.recent_commits, ["abc123 Add feature", "def456 Fix tests"]);
});

test("discoverCaptureSources supports since-ref ranges", () => {
  const services = fakeGit({
    "diff --name-only origin/main..HEAD": "src/capture.ts\n",
    "log --oneline --max-count=8 origin/main..HEAD": "abc123 Capture work\n"
  });

  const sources = discoverCaptureSources("C:/work/service", {
    sinceRef: "origin/main",
    services
  });

  assert.equal(sources.since_ref, "origin/main");
  assert.deepEqual(sources.changed_files, ["src/capture.ts"]);
  assert.deepEqual(sources.untracked_files, []);
  assert.deepEqual(sources.recent_commits, ["abc123 Capture work"]);
});

test("buildCapturePlan emits a session-end capture prompt", () => {
  const plan = buildCapturePlan({
    repo: "github.com/team/service",
    root: "C:/work/service",
    store: "github.com/team/context/contexts/service",
    localStore: false,
    branch: "main",
    headCommit: "abc123",
    sources: {
      changed_files: ["src/index.ts"],
      untracked_files: [],
      recent_commits: ["abc123 Add feature"]
    }
  });

  assert.equal(plan.output_file, "teamctx-capture-observations.json");
  assert.equal(plan.recommended_observation_count, "3-10");
  assert.deepEqual(plan.commands, [
    "teamctx record-verified teamctx-capture-observations.json",
    "teamctx normalize --dry-run",
    "teamctx normalize"
  ]);
  assert.match(plan.agent_prompt, /Capture durable teamctx knowledge/);
  assert.match(plan.agent_prompt, /src\/index\.ts/);
  assert.match(plan.agent_prompt, /Skip temporary progress notes/);
});

function fakeGit(outputs: Record<string, string>): CaptureDiscoveryServices {
  return {
    git: (args) => outputs[args.join(" ")] ?? ""
  };
}
