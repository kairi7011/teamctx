import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEpisodeIndex,
  selectIndexedEpisodeIds,
  serializeEpisodeIndex,
  validateEpisodeIndex
} from "../../src/core/indexes/episode-index.js";
import type { RawObservation } from "../../src/schemas/observation.js";
import { fixtureObservation } from "../fixtures/observation.js";

test("buildEpisodeIndex creates raw-event-derived episode references", () => {
  const index = buildEpisodeIndex([observation()], "2026-04-22T11:00:00.000Z");
  const episode = index.episodes[0];

  assert.ok(episode);
  assert.equal(index.generated_at, "2026-04-22T11:00:00.000Z");
  assert.equal(episode.source_event_ids[0], "event-1");
  assert.equal(episode.observed_from, "2026-04-22T10:00:00.000Z");
  assert.equal(episode.observed_to, "2026-04-22T10:00:00.000Z");
  assert.equal(episode.summary, "Auth middleware must run before tenant resolution.");
  assert.deepEqual(index.paths["src/auth/**"], [episode.episode_id]);
  assert.deepEqual(index.domains.auth, [episode.episode_id]);
  assert.deepEqual(index.symbols.AuthMiddleware, [episode.episode_id]);
  assert.deepEqual(index.tags["request-lifecycle"], [episode.episode_id]);
  assert.deepEqual(index.evidence_files["src/auth/middleware.ts"], [episode.episode_id]);
  assert.deepEqual(index.source_types.inferred_from_code, [episode.episode_id]);
  assert.deepEqual(index.trusts.verified, [episode.episode_id]);
});

test("selectIndexedEpisodeIds retrieves episodes by path domain symbol tag source and evidence", () => {
  const index = buildEpisodeIndex([observation()], "2026-04-22T11:00:00.000Z");
  const episodeId = index.episodes[0]?.episode_id;

  assert.ok(episodeId);
  assert.deepEqual(
    [...selectIndexedEpisodeIds(index, { target_files: ["src/auth/router.ts"] })],
    [episodeId]
  );
  assert.deepEqual([...selectIndexedEpisodeIds(index, { domains: ["AUTH"] })], [episodeId]);
  assert.deepEqual(
    [...selectIndexedEpisodeIds(index, { symbols: ["AuthMiddleware"] })],
    [episodeId]
  );
  assert.deepEqual(
    [...selectIndexedEpisodeIds(index, { tags: ["request-lifecycle"] })],
    [episodeId]
  );
  assert.deepEqual(
    [...selectIndexedEpisodeIds(index, { source_types: ["inferred_from_code"] })],
    [episodeId]
  );
  assert.deepEqual(
    [...selectIndexedEpisodeIds(index, { evidence_files: ["src/auth/middleware.ts"] })],
    [episodeId]
  );
});

test("validateEpisodeIndex round trips serialized indexes", () => {
  const index = buildEpisodeIndex([observation()], "2026-04-22T11:00:00.000Z");

  assert.deepEqual(validateEpisodeIndex(JSON.parse(serializeEpisodeIndex(index))), index);
});

function observation(overrides: Partial<RawObservation> = {}): RawObservation {
  return fixtureObservation(overrides);
}
