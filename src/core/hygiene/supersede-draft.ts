import {
  explainBoundItemAsync,
  type ControlServices,
  type ExplainItemResult
} from "../audit/control.js";
import { CoreError, itemNotFoundError } from "../errors.js";
import type { NormalizedRecord, Scope } from "../../schemas/normalized-record.js";
import type { HygieneObservationDraft } from "./report.js";

export type SupersedeDraftRecordSummary = {
  id: string;
  kind: NormalizedRecord["kind"];
  state: NormalizedRecord["state"];
  text: string;
  scope: Scope;
};

export type SupersedeDraftResult = {
  mode: "review_only";
  record_ids: string[];
  record_count: number;
  records: SupersedeDraftRecordSummary[];
  warnings: string[];
  review_commands: string[];
  candidate_write_commands: string[];
  draft_observation: HygieneObservationDraft;
};

export type BoundSupersedeDraftOptions = {
  cwd?: string;
  itemIds: string[];
  services?: ControlServices;
};

export async function getBoundSupersedeDraft(
  options: BoundSupersedeDraftOptions
): Promise<SupersedeDraftResult> {
  const records: NormalizedRecord[] = [];

  for (const itemId of options.itemIds) {
    const result = await explainBoundItemAsync({
      itemId,
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.services !== undefined ? { services: options.services } : {})
    });

    records.push(recordFromExplainResult(result, itemId));
  }

  return buildSupersedeDraft(records);
}

export function buildSupersedeDraft(records: NormalizedRecord[]): SupersedeDraftResult {
  if (records.length === 0) {
    throw new CoreError("validation", "supersede draft requires at least one item id");
  }

  const kind = assertSameKinds(records);

  const recordIds = records.map((record) => record.id);
  const warnings = inactiveStateWarnings(records);
  const mergedScope = mergeScopes(records.map((record) => record.scope));

  if (!records.every((record) => sameScope(record.scope, mergedScope))) {
    warnings.push(
      "Records do not share identical scope; the draft uses the union scope. Narrow it before record-verified."
    );
  }

  return {
    mode: "review_only",
    record_ids: recordIds,
    record_count: records.length,
    records: records.map(recordSummary),
    warnings,
    review_commands: reviewCommands(recordIds),
    candidate_write_commands: [
      "teamctx record-verified superseding-observation.json",
      "teamctx normalize --dry-run",
      "teamctx normalize"
    ],
    draft_observation: {
      draft_status: "incomplete_requires_evidence_review",
      kind,
      text: draftText(recordIds),
      source_type: "inferred_from_docs",
      scope: mergedScope,
      supersedes: recordIds,
      evidence: [],
      instructions: [
        "Replace this TODO text with one evidence-backed statement that fully covers the superseded records.",
        "Add concrete code, test, docs, diff, PR, or issue evidence before running record-verified.",
        "Keep the scope narrow; do not supersede records that the new statement does not fully replace.",
        "`evidence` is intentionally empty so record-verified rejects the draft until reviewed."
      ]
    }
  };
}

function recordFromExplainResult(result: ExplainItemResult, itemId: string): NormalizedRecord {
  if (!result.found) {
    throw itemNotFoundError(itemId);
  }

  return result.record;
}

function assertSameKinds(records: NormalizedRecord[]): NormalizedRecord["kind"] {
  const kind = records[0]?.kind;

  if (kind === undefined) {
    throw new CoreError("validation", "supersede draft requires at least one item id");
  }

  const mixedKinds = records.filter((record) => record.kind !== kind);

  if (mixedKinds.length > 0) {
    throw new CoreError(
      "validation",
      `supersede draft requires records with the same kind; got ${[
        kind,
        ...mixedKinds.map((record) => record.kind)
      ].join(", ")}`
    );
  }

  return kind;
}

function inactiveStateWarnings(records: NormalizedRecord[]): string[] {
  return records
    .filter((record) => record.state !== "active")
    .map(
      (record) =>
        `${record.id} is ${record.state}; confirm this state before creating a superseding observation.`
    );
}

function mergeScopes(scopes: Scope[]): Scope {
  const firstScope = scopes[0];

  if (firstScope !== undefined && scopes.every((scope) => sameScope(scope, firstScope))) {
    return cloneScope(firstScope);
  }

  return {
    paths: uniqueSorted(scopes.flatMap((scope) => scope.paths)),
    domains: uniqueSorted(scopes.flatMap((scope) => scope.domains)),
    symbols: uniqueSorted(scopes.flatMap((scope) => scope.symbols)),
    tags: uniqueSorted(scopes.flatMap((scope) => scope.tags))
  };
}

function cloneScope(scope: Scope): Scope {
  return {
    paths: [...scope.paths],
    domains: [...scope.domains],
    symbols: [...scope.symbols],
    tags: [...scope.tags]
  };
}

function sameScope(left: Scope, right: Scope): boolean {
  return (
    sameStringSet(left.paths, right.paths) &&
    sameStringSet(left.domains, right.domains) &&
    sameStringSet(left.symbols, right.symbols) &&
    sameStringSet(left.tags, right.tags)
  );
}

function sameStringSet(left: string[], right: string[]): boolean {
  const normalizedLeft = uniqueSorted(left);
  const normalizedRight = uniqueSorted(right);

  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index])
  );
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function recordSummary(record: NormalizedRecord): SupersedeDraftRecordSummary {
  return {
    id: record.id,
    kind: record.kind,
    state: record.state,
    text: record.text,
    scope: record.scope
  };
}

function draftText(recordIds: string[]): string {
  if (recordIds.length === 1) {
    return `TODO: Write the current evidence-backed replacement statement for ${recordIds[0]}.`;
  }

  return `TODO: Write one evidence-backed statement that replaces: ${recordIds.join(", ")}.`;
}

function reviewCommands(recordIds: string[]): string[] {
  return recordIds.flatMap((id) => [
    `teamctx show ${commandArg(id)}`,
    `teamctx explain ${commandArg(id)}`
  ]);
}

function commandArg(value: string): string {
  if (/^[A-Za-z0-9._:@/+~-]+$/.test(value)) {
    return value;
  }

  return JSON.stringify(value);
}
