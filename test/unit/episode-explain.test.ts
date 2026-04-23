import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { explainEpisode } from "../../src/core/episodes/explain.js";
import { buildEpisodeIndex, serializeEpisodeIndex } from "../../src/core/indexes/episode-index.js";
import type { RawObservation } from "../../src/schemas/observation.js";

function tempDirectory(): { directory: string; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "teamctx-episode-explain-"));

  return {
    directory,
    cleanup: () => rmSync(directory, { recursive: true, force: true })
  };
}

test("explainEpisode returns an indexed episode reference", (context) => {
  const { directory, cleanup } = tempDirectory();
  context.after(cleanup);
  const storeRoot = join(directory, ".teamctx");
  const index = buildEpisodeIndex([observation()], "2026-04-22T11:00:00.000Z");
  const episodeId = index.episodes[0]?.episode_id;

  if (!episodeId) {
    throw new Error("expected episode id");
  }

  mkdirSync(join(storeRoot, "indexes"), { recursive: true });
  writeFileSync(join(storeRoot, "indexes", "episode-index.json"), serializeEpisodeIndex(index));

  const result = explainEpisode({ storeRoot, episodeId });

  assert.equal(result.found, true);

  if (!result.found) {
    throw new Error("expected episode");
  }

  assert.equal(result.episode.episode_id, episodeId);
  assert.deepEqual(result.episode.source_event_ids, ["event-1"]);
});

function observation(): RawObservation {
  return {
    schema_version: 1,
    event_id: "event-1",
    session_id: "session-1",
    observed_at: "2026-04-22T10:00:00.000Z",
    recorded_by: "codex",
    trust: "verified",
    kind: "pitfall",
    text: "Auth middleware must run before tenant resolution.",
    source_type: "inferred_from_code",
    evidence: [
      {
        kind: "code",
        repo: "github.com/team/service",
        commit: "abc123",
        file: "src/auth/middleware.ts"
      }
    ],
    scope: {
      paths: ["src/auth/**"],
      domains: ["auth"],
      symbols: ["AuthMiddleware"],
      tags: ["request-lifecycle"]
    },
    supersedes: []
  };
}
