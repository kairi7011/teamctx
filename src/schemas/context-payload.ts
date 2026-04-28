import { isRecord, optionalStringArray } from "./validation.js";
import type { EpisodeReference } from "./episode.js";
import type { DocRole, LineRange } from "./evidence.js";

export type CanonicalDocRef = {
  repo: string;
  path: string;
  commit: string;
  item_id: string;
  reason: string;
  fetch_url?: string;
  doc_role?: DocRole;
  lines?: LineRange;
  url?: string;
};

export type GetContextInput = {
  cwd?: string;
  target_files?: string[];
  changed_files?: string[];
  domains?: string[];
  symbols?: string[];
  tags?: string[];
  query?: string;
  since?: string;
  until?: string;
  source_types?: string[];
  evidence_files?: string[];
  branch?: string;
  head_commit?: string;
};

export type DisabledContextPayload = {
  enabled: false;
  reason: string;
};

export type EnabledContextPayload = {
  enabled: true;
  identity: {
    repo: string;
    branch: string;
    head_commit: string;
    context_store: string;
    store_head: string | null;
    normalizer_version: string;
    context_payload_hash: string;
  };
  normalized_context: {
    global: string;
    scoped: Array<{
      id: string;
      kind: string;
      scope: Record<string, unknown>;
      content: string;
      reason: string;
      rank_score: number;
      rank_reasons: string[];
      confidence_level: string;
      confidence_score?: number;
      last_verified_at?: string;
    }>;
    must_follow_rules: string[];
    recent_decisions: string[];
    active_pitfalls: string[];
    applicable_workflows: string[];
    glossary_terms: string[];
  };
  relevant_episodes: EpisodeReference[];
  canonical_doc_refs: CanonicalDocRef[];
  diagnostics: {
    contested_items: string[];
    stale_items: string[];
    dropped_items: string[];
    excluded_items: Array<{ id: string; state: string; reason: string }>;
    budget_rejected: Array<{
      id: string;
      kind: string;
      rank_score: number;
      rank_reasons: string[];
      exclusion_reason: string;
    }>;
    index_warnings: string[];
  };
  write_policy: {
    record_observation_candidate: "allowed";
    record_observation_verified: "allowed_with_evidence";
    invalidate: "human_only";
    docs_evidence: "allowed_with_doc_role";
  };
};

export type ContextPayload = DisabledContextPayload | EnabledContextPayload;

export function validateGetContextInput(value: unknown): GetContextInput {
  if (value === undefined) {
    return {};
  }

  if (!isRecord(value)) {
    throw new Error("get_context input must be an object");
  }

  const input: GetContextInput = {};
  const cwd = optionalString(value.cwd, "cwd");
  const targetFiles = optionalStringArrayWithName(value.target_files, "target_files");
  const changedFiles = optionalStringArrayWithName(value.changed_files, "changed_files");
  const domains = optionalStringArrayWithName(value.domains, "domains");
  const symbols = optionalStringArrayWithName(value.symbols, "symbols");
  const tags = optionalStringArrayWithName(value.tags, "tags");
  const query = optionalString(value.query, "query");
  const since = optionalTimestamp(value.since, "since");
  const until = optionalTimestamp(value.until, "until");
  const sourceTypes = optionalStringArrayWithName(value.source_types, "source_types");
  const evidenceFiles = optionalStringArrayWithName(value.evidence_files, "evidence_files");
  const branch = optionalString(value.branch, "branch");
  const headCommit = optionalString(value.head_commit, "head_commit");

  if (cwd !== undefined) {
    input.cwd = cwd;
  }
  if (targetFiles !== undefined) {
    input.target_files = targetFiles;
  }
  if (changedFiles !== undefined) {
    input.changed_files = changedFiles;
  }
  if (domains !== undefined) {
    input.domains = domains;
  }
  if (symbols !== undefined) {
    input.symbols = symbols;
  }
  if (tags !== undefined) {
    input.tags = tags;
  }
  if (query !== undefined) {
    input.query = query;
  }
  if (since !== undefined) {
    input.since = since;
  }
  if (until !== undefined) {
    input.until = until;
  }
  if (sourceTypes !== undefined) {
    input.source_types = sourceTypes;
  }
  if (evidenceFiles !== undefined) {
    input.evidence_files = evidenceFiles;
  }
  if (branch !== undefined) {
    input.branch = branch;
  }
  if (headCommit !== undefined) {
    input.head_commit = headCommit;
  }

  return input;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`get_context ${name} must be a non-empty string`);
  }

  return value;
}

function optionalStringArrayWithName(value: unknown, name: string): string[] | undefined {
  try {
    return optionalStringArray(value);
  } catch {
    throw new Error(`get_context ${name} must be a string array`);
  }
}

function optionalTimestamp(value: unknown, name: string): string | undefined {
  const timestamp = optionalString(value, name);

  if (timestamp !== undefined && Number.isNaN(Date.parse(timestamp))) {
    throw new Error(`get_context ${name} must be a valid timestamp`);
  }

  return timestamp;
}
