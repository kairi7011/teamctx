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
    .slice(0, limit)
    .map((episode) => episodeWithSelectionReasons(episode, input));
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

function episodeWithSelectionReasons(
  episode: EpisodeReference,
  input: GetContextInput
): EpisodeReference {
  const selectionReasons = episodeSelectionReasons(episode, input);

  return {
    ...episode,
    reason: selectionReasons.join("; "),
    selection_reasons: selectionReasons
  };
}

function episodeSelectionReasons(episode: EpisodeReference, input: GetContextInput): string[] {
  return uniqueReasons([
    ...pathSelectionReasons("target file", episode, input.target_files ?? []),
    ...pathSelectionReasons("changed file", episode, input.changed_files ?? []),
    ...textSelectionReasons("domain", episode.scope.domains, input.domains ?? []),
    ...symbolSelectionReasons(episode.scope.symbols, input.symbols ?? []),
    ...textSelectionReasons("tag", episode.scope.tags, input.tags ?? []),
    ...sourceTypeSelectionReasons(episode, input.source_types ?? []),
    ...evidenceFileSelectionReasons(episode, input.evidence_files ?? []),
    ...timeSelectionReasons(input)
  ]);
}

function pathSelectionReasons(label: string, episode: EpisodeReference, files: string[]): string[] {
  return files
    .filter((file) =>
      episode.scope.paths.some((path) => matchesPath(path, file) || matchesPath(file, path))
    )
    .map((file) => `${label} match: ${file}`);
}

function textSelectionReasons(
  label: string,
  episodeValues: string[],
  inputValues: string[]
): string[] {
  const values = new Set(episodeValues.map((value) => value.toLowerCase()));

  return inputValues
    .filter((value) => values.has(value.toLowerCase()))
    .map((value) => `${label} match: ${value}`);
}

function symbolSelectionReasons(episodeSymbols: string[], inputSymbols: string[]): string[] {
  const values = new Set(episodeSymbols);

  return inputSymbols.filter((value) => values.has(value)).map((value) => `symbol match: ${value}`);
}

function sourceTypeSelectionReasons(episode: EpisodeReference, sourceTypes: string[]): string[] {
  return sourceTypes
    .filter((sourceType) => episode.source_type === sourceType)
    .map((sourceType) => `source_type match: ${sourceType}`);
}

function evidenceFileSelectionReasons(
  episode: EpisodeReference,
  evidenceFiles: string[]
): string[] {
  return evidenceFiles
    .filter((file) =>
      episode.evidence.some(
        (evidence) => evidence.file !== undefined && matchesEpisodeEvidenceFile(evidence.file, file)
      )
    )
    .map((file) => `evidence file match: ${file}`);
}

function timeSelectionReasons(input: GetContextInput): string[] {
  if (input.since !== undefined && input.until !== undefined) {
    return [`time window match: ${input.since}..${input.until}`];
  }

  if (input.since !== undefined) {
    return [`time window match: since ${input.since}`];
  }

  if (input.until !== undefined) {
    return [`time window match: until ${input.until}`];
  }

  return [];
}

function uniqueReasons(reasons: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const reason of reasons) {
    if (seen.has(reason)) {
      continue;
    }

    seen.add(reason);
    unique.push(reason);
  }

  return unique.length > 0 ? unique : ["episode selector match"];
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
