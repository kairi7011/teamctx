import { sha256Hex } from "../store/hash.js";
import type {
  ObservationSourceType,
  RawObservation,
  RawObservationTrust
} from "../../schemas/observation.js";
import { OBSERVATION_SOURCE_TYPES, validateRawObservation } from "../../schemas/observation.js";
import { validateScope, type Scope } from "../../schemas/normalized-record.js";
import { isRecord, isStringArray } from "../../schemas/validation.js";
import type { GetContextInput } from "../../schemas/context-payload.js";
import type { EpisodeReference } from "../../schemas/episode.js";
import { matchesPath } from "./record-index.js";

export type EpisodeIndex = {
  schema_version: 1;
  generated_at: string | null;
  episodes: EpisodeReference[];
  paths: Record<string, string[]>;
  domains: Record<string, string[]>;
  symbols: Record<string, string[]>;
  tags: Record<string, string[]>;
  evidence_files: Record<string, string[]>;
  source_types: Record<string, string[]>;
  trusts: Record<string, string[]>;
};

export function createEmptyEpisodeIndex(generatedAt: string | null = null): EpisodeIndex {
  return {
    schema_version: 1,
    generated_at: generatedAt,
    episodes: [],
    paths: {},
    domains: {},
    symbols: {},
    tags: {},
    evidence_files: {},
    source_types: {},
    trusts: {}
  };
}

export function buildEpisodeIndex(
  observations: RawObservation[],
  generatedAt: string | null
): EpisodeIndex {
  const index = createEmptyEpisodeIndex(generatedAt);

  for (const observation of observations) {
    const episode = episodeReference(observation);
    index.episodes.push(episode);

    for (const path of episode.scope.paths) {
      addIndexedId(index.paths, normalizePath(path), episode.episode_id);
    }
    for (const domain of episode.scope.domains) {
      addIndexedId(index.domains, normalizeTextKey(domain), episode.episode_id);
    }
    for (const symbol of episode.scope.symbols) {
      addIndexedId(index.symbols, normalizeSymbolKey(symbol), episode.episode_id);
    }
    for (const tag of episode.scope.tags) {
      addIndexedId(index.tags, normalizeTextKey(tag), episode.episode_id);
    }
    for (const evidence of episode.evidence) {
      if (evidence.file !== undefined) {
        addIndexedId(index.evidence_files, normalizePath(evidence.file), episode.episode_id);
      }
    }

    addIndexedId(index.source_types, episode.source_type, episode.episode_id);
    addIndexedId(index.trusts, episode.trust, episode.episode_id);
  }

  return sortEpisodeIndex(index);
}

export function serializeEpisodeIndex(index: EpisodeIndex): string {
  return `${JSON.stringify(index, null, 2)}\n`;
}

export function validateEpisodeIndex(value: unknown): EpisodeIndex {
  if (!isRecord(value)) {
    throw new Error("episode index must be an object");
  }

  if (value.schema_version !== 1) {
    throw new Error("episode index schema_version must be 1");
  }

  if (!Array.isArray(value.episodes)) {
    throw new Error("episode index episodes must be an array");
  }

  return sortEpisodeIndex({
    schema_version: 1,
    generated_at: validateGeneratedAt(value.generated_at),
    episodes: value.episodes.map(validateEpisodeReference),
    paths: validateIdMap(value.paths, "episode index paths"),
    domains: validateIdMap(value.domains, "episode index domains"),
    symbols: validateIdMap(value.symbols, "episode index symbols"),
    tags: validateIdMap(value.tags, "episode index tags"),
    evidence_files: validateIdMap(value.evidence_files, "episode index evidence_files"),
    source_types: validateIdMap(value.source_types, "episode index source_types"),
    trusts: validateIdMap(value.trusts, "episode index trusts")
  });
}

export function selectIndexedEpisodeIds(
  index: EpisodeIndex | undefined,
  input: GetContextInput
): Set<string> {
  const selected = new Set<string>();

  if (!index) {
    return selected;
  }

  for (const file of selectedFiles(input)) {
    for (const [pattern, ids] of Object.entries(index.paths)) {
      if (matchesPath(pattern, file)) {
        addAll(selected, ids);
      }
    }
  }

  for (const domain of input.domains ?? []) {
    addAll(selected, index.domains[normalizeTextKey(domain)] ?? []);
  }

  for (const symbol of input.symbols ?? []) {
    addAll(selected, index.symbols[normalizeSymbolKey(symbol)] ?? []);
  }

  for (const tag of input.tags ?? []) {
    addAll(selected, index.tags[normalizeTextKey(tag)] ?? []);
  }

  for (const [indexedFile, ids] of Object.entries(index.evidence_files)) {
    if (
      (input.evidence_files ?? []).some(
        (file) => matchesPath(indexedFile, file) || matchesPath(file, indexedFile)
      )
    ) {
      addAll(selected, ids);
    }
  }

  for (const sourceType of input.source_types ?? []) {
    addAll(selected, index.source_types[sourceType] ?? []);
  }

  return selected;
}

function episodeReference(observation: RawObservation): EpisodeReference {
  return {
    schema_version: 1,
    episode_id: episodeId(observation.event_id),
    source_event_ids: [observation.event_id],
    observed_from: observation.observed_at,
    observed_to: observation.observed_at,
    scope: observation.scope ?? emptyScope(),
    evidence: observation.evidence,
    summary: summarize(observation.text),
    trust: observation.trust,
    source_type: observation.source_type
  };
}

function validateEpisodeReference(value: unknown): EpisodeReference {
  if (!isRecord(value)) {
    throw new Error("episode reference must be an object");
  }

  if (value.schema_version !== 1) {
    throw new Error("episode reference schema_version must be 1");
  }

  const rawObservation = validateRawObservation({
    schema_version: 1,
    event_id: firstString(value.source_event_ids, "episode reference source_event_ids"),
    session_id: "episode-index-validation",
    observed_at: requiredString(value.observed_from, "episode reference observed_from"),
    recorded_by: "episode-index-validation",
    trust: validateTrust(value.trust),
    kind: "fact",
    text: requiredString(value.summary, "episode reference summary"),
    source_type: validateSourceType(value.source_type),
    evidence: Array.isArray(value.evidence) ? value.evidence : [],
    scope: value.scope,
    supersedes: []
  });

  return {
    schema_version: 1,
    episode_id: requiredString(value.episode_id, "episode reference episode_id"),
    source_event_ids: validateStringArray(
      value.source_event_ids,
      "episode reference source_event_ids"
    ),
    observed_from: rawObservation.observed_at,
    observed_to: requiredString(value.observed_to, "episode reference observed_to"),
    scope: validateScope(value.scope),
    evidence: rawObservation.evidence,
    summary: rawObservation.text,
    trust: rawObservation.trust,
    source_type: rawObservation.source_type
  };
}

function episodeId(eventId: string): string {
  return `episode-${sha256Hex(eventId).slice(0, 16)}`;
}

function summarize(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();

  if (normalized.length <= 240) {
    return normalized;
  }

  return `${normalized.slice(0, 237).trimEnd()}...`;
}

function validateGeneratedAt(value: unknown): string | null {
  if (value === null) {
    return null;
  }

  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  throw new Error("episode index generated_at must be a string or null");
}

function validateIdMap(value: unknown, name: string): Record<string, string[]> {
  if (!isRecord(value)) {
    throw new Error(`${name} must be an object`);
  }

  const output: Record<string, string[]> = {};

  for (const [key, ids] of Object.entries(value)) {
    if (key.length === 0 || !isStringArray(ids)) {
      throw new Error(`${name} must map non-empty keys to string arrays`);
    }

    output[key] = uniqueSorted(ids.filter((id) => id.length > 0));
  }

  return sortRecord(output);
}

function validateStringArray(value: unknown, name: string): string[] {
  if (!isStringArray(value) || value.length === 0) {
    throw new Error(`${name} must be a non-empty string array`);
  }

  return uniqueSorted(value);
}

function firstString(value: unknown, name: string): string {
  const values = validateStringArray(value, name);

  return values[0] ?? "";
}

function validateTrust(value: unknown): RawObservationTrust {
  if (value === "candidate" || value === "verified") {
    return value;
  }

  throw new Error("episode reference trust is invalid");
}

function validateSourceType(value: unknown): ObservationSourceType {
  if (
    typeof value === "string" &&
    OBSERVATION_SOURCE_TYPES.includes(value as ObservationSourceType)
  ) {
    return value as ObservationSourceType;
  }

  throw new Error("episode reference source_type is invalid");
}

function addIndexedId<T extends string>(index: Record<T, string[]>, rawKey: T, id: string): void {
  const key = rawKey.trim() as T;

  if (key.length === 0) {
    return;
  }

  const ids = index[key] ?? [];
  ids.push(id);
  index[key] = ids;
}

function addAll(target: Set<string>, ids: string[]): void {
  for (const id of ids) {
    target.add(id);
  }
}

function sortEpisodeIndex(index: EpisodeIndex): EpisodeIndex {
  return {
    schema_version: 1,
    generated_at: index.generated_at,
    episodes: [...index.episodes].sort((left, right) =>
      left.episode_id.localeCompare(right.episode_id)
    ),
    paths: sortRecordIds(index.paths),
    domains: sortRecordIds(index.domains),
    symbols: sortRecordIds(index.symbols),
    tags: sortRecordIds(index.tags),
    evidence_files: sortRecordIds(index.evidence_files),
    source_types: sortRecordIds(index.source_types),
    trusts: sortRecordIds(index.trusts)
  };
}

function sortRecordIds<T extends string>(record: Record<T, string[]>): Record<T, string[]> {
  const output: Record<string, string[]> = {};

  for (const key of Object.keys(record) as T[]) {
    output[key] = uniqueSorted(record[key] ?? []);
  }

  return sortRecord(output) as Record<T, string[]>;
}

function sortRecord(record: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right))
  );
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function selectedFiles(input: GetContextInput): string[] {
  return [...(input.target_files ?? []), ...(input.changed_files ?? [])];
}

function emptyScope(): Scope {
  return {
    paths: [],
    domains: [],
    symbols: [],
    tags: []
  };
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

function normalizeTextKey(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeSymbolKey(value: string): string {
  return value.trim();
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }

  return value;
}
