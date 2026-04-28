import { matchesPath } from "../indexes/record-index.js";
import { selectIndexedEpisodeIds, type EpisodeIndex } from "../indexes/episode-index.js";
import type { GetContextInput } from "../../schemas/context-payload.js";
import type { EpisodeReference } from "../../schemas/episode.js";

const DEFAULT_EPISODE_LIMIT = 10;

export function selectRelevantEpisodes(
  index: EpisodeIndex | undefined,
  input: GetContextInput,
  limit: number = DEFAULT_EPISODE_LIMIT
): EpisodeReference[] {
  if (!index || !hasEpisodeSelectors(input) || typeof index.generated_at !== "string") {
    return [];
  }

  const selectedIds = hasIndexedEpisodeSelectors(input)
    ? selectIndexedEpisodeIds(index, input)
    : new Set(index.episodes.map((episode) => episode.episode_id));
  const episodesById = new Map(index.episodes.map((episode) => [episode.episode_id, episode]));

  return [...selectedIds]
    .flatMap((id) => {
      const episode = episodesById.get(id);

      return episode ? [episode] : [];
    })
    .filter((episode) => matchesEpisodeFilters(episode, input))
    .sort(compareEpisodes)
    .slice(0, limit);
}

function compareEpisodes(left: EpisodeReference, right: EpisodeReference): number {
  return (
    Date.parse(right.observed_to) - Date.parse(left.observed_to) ||
    left.episode_id.localeCompare(right.episode_id)
  );
}

function hasEpisodeSelectors(input: GetContextInput): boolean {
  return hasIndexedEpisodeSelectors(input) || hasTimeFilters(input);
}

function hasIndexedEpisodeSelectors(input: GetContextInput): boolean {
  return (
    selectedFiles(input).length > 0 ||
    (input.domains ?? []).length > 0 ||
    (input.symbols ?? []).length > 0 ||
    (input.tags ?? []).length > 0 ||
    (input.source_types ?? []).length > 0 ||
    (input.evidence_files ?? []).length > 0
  );
}

function selectedFiles(input: GetContextInput): string[] {
  return [...(input.target_files ?? []), ...(input.changed_files ?? [])];
}

function matchesEpisodeFilters(episode: EpisodeReference, input: GetContextInput): boolean {
  const sourceTypes = input.source_types ?? [];
  const evidenceFiles = input.evidence_files ?? [];

  if (sourceTypes.length > 0 && !sourceTypes.includes(episode.source_type)) {
    return false;
  }

  if (
    evidenceFiles.length > 0 &&
    !episode.evidence.some((evidence) => {
      if (evidence.file === undefined) {
        return false;
      }

      const evidenceFile = evidence.file;

      return evidenceFiles.some((file) => matchesEpisodeEvidenceFile(evidenceFile, file));
    })
  ) {
    return false;
  }

  return matchesEpisodeTimeInput(episode, input);
}

function matchesEpisodeEvidenceFile(indexedFile: string, inputFile: string): boolean {
  return matchesPath(indexedFile, inputFile) || matchesPath(inputFile, indexedFile);
}

function matchesEpisodeTimeInput(episode: EpisodeReference, input: GetContextInput): boolean {
  const since = input.since === undefined ? undefined : Date.parse(input.since);
  const until = input.until === undefined ? undefined : Date.parse(input.until);

  if (since === undefined && until === undefined) {
    return true;
  }

  const observedFrom = Date.parse(episode.observed_from);
  const observedTo = Date.parse(episode.observed_to);

  if (Number.isNaN(observedFrom) || Number.isNaN(observedTo)) {
    return false;
  }

  return (
    (since === undefined || observedTo >= since) && (until === undefined || observedFrom <= until)
  );
}

function hasTimeFilters(input: GetContextInput): boolean {
  return input.since !== undefined || input.until !== undefined;
}
