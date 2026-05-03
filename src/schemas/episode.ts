import type { Evidence } from "./evidence.js";
import type { Scope } from "./normalized-record.js";
import type { ObservationSourceType, RawObservationTrust } from "./observation.js";

export type EpisodeReference = {
  schema_version: 1;
  episode_id: string;
  source_event_ids: string[];
  observed_from: string;
  observed_to: string;
  scope: Scope;
  evidence: Evidence[];
  summary: string;
  trust: RawObservationTrust;
  source_type: ObservationSourceType;
  reason?: string;
  selection_reasons?: string[];
};
