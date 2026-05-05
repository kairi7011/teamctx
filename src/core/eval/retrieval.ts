import type {
  ContextPayload,
  EnabledContextPayload,
  GetContextInput
} from "../../schemas/context-payload.js";
import { approximateTokenCount } from "../context/context-ranking.js";

export type RetrievalEvalFixtureCase = {
  case: string;
  level: number;
  query: string;
  gold_ids?: string[];
  gold_tags?: string[];
  negative?: boolean;
};

export type RetrievalEvalRow = {
  case: string;
  level: number;
  negative: boolean;
  query: string;
  returned: Array<{
    id: string;
    kind: string;
    tags: string[];
  }>;
  gold_hit: number;
  gold_total: number;
  false_positive_ids: string[];
  tokens: number;
  disabled_reason?: string;
};

type RetrievedRecord = RetrievalEvalRow["returned"][number] & {
  content: string;
};

export type RetrievalEvalLevelSummary = {
  prompts: number;
  gold_hits: number;
  gold_total: number;
  full_hit: number;
  any_hit: number;
  false_positive_prompts: number;
  max_tokens: number;
};

export type RetrievalEvalSummary = {
  total_prompts: number;
  non_negative: number;
  negative: number;
  gold_hits: number;
  gold_total: number;
  prompt_full_hit: number;
  prompt_any_hit: number;
  false_positive_prompts: number;
  max_tokens: number;
  levels: Record<string, RetrievalEvalLevelSummary>;
};

export type RetrievalEvalResult = {
  summary: RetrievalEvalSummary;
  rows: RetrievalEvalRow[];
};

export type RetrievalEvalOptions = {
  callReason?: GetContextInput["call_reason"];
};

export async function evaluateRetrievalFixture(
  fixture: unknown,
  getContext: (input: GetContextInput) => Promise<ContextPayload>,
  options: RetrievalEvalOptions = {}
): Promise<RetrievalEvalResult> {
  const cases = validateRetrievalEvalFixture(fixture);
  const rows: RetrievalEvalRow[] = [];
  const summary: RetrievalEvalSummary = {
    total_prompts: cases.length,
    non_negative: 0,
    negative: 0,
    gold_hits: 0,
    gold_total: 0,
    prompt_full_hit: 0,
    prompt_any_hit: 0,
    false_positive_prompts: 0,
    max_tokens: 0,
    levels: {}
  };

  for (const item of cases) {
    const payload = await getContext({
      query: item.query,
      call_reason: options.callReason ?? "session_start"
    });
    const row = evaluateRetrievalCase(item, payload);

    rows.push(row);
    updateSummary(summary, row);
  }

  return { summary, rows };
}

export function validateRetrievalEvalFixture(value: unknown): RetrievalEvalFixtureCase[] {
  if (!Array.isArray(value)) {
    throw new Error("retrieval eval fixture must be an array");
  }

  if (value.length === 0) {
    throw new Error("retrieval eval fixture must not be empty");
  }

  return value.map(validateRetrievalEvalCase);
}

function validateRetrievalEvalCase(value: unknown, index: number): RetrievalEvalFixtureCase {
  if (!isRecord(value)) {
    throw new Error(`retrieval eval case ${index + 1} must be an object`);
  }

  const caseId = nonEmptyString(value.case, `retrieval eval case ${index + 1} case`);
  const level = positiveInteger(value.level, `retrieval eval case ${caseId} level`);
  const query = nonEmptyString(value.query, `retrieval eval case ${caseId} query`);
  const goldIds = optionalStringArray(value.gold_ids, `retrieval eval case ${caseId} gold_ids`);
  const goldTags = optionalStringArray(value.gold_tags, `retrieval eval case ${caseId} gold_tags`);
  const negative = value.negative === true;

  if (!negative && (goldIds?.length ?? 0) === 0 && (goldTags?.length ?? 0) === 0) {
    throw new Error(`retrieval eval case ${caseId} must define gold_ids or gold_tags`);
  }

  return {
    case: caseId,
    level,
    query,
    ...(goldIds !== undefined ? { gold_ids: goldIds } : {}),
    ...(goldTags !== undefined ? { gold_tags: goldTags } : {}),
    ...(negative ? { negative: true } : {})
  };
}

function evaluateRetrievalCase(
  item: RetrievalEvalFixtureCase,
  payload: ContextPayload
): RetrievalEvalRow {
  if (!payload.enabled) {
    return {
      case: item.case,
      level: item.level,
      negative: item.negative === true,
      query: item.query,
      returned: [],
      gold_hit: 0,
      gold_total: goldTotal(item),
      false_positive_ids: [],
      tokens: 0,
      disabled_reason: payload.reason
    };
  }

  const scoped = scopedRecords(payload);
  const goldIds = new Set(item.gold_ids ?? []);
  const goldTags = new Set(item.gold_tags ?? []);
  const goldHitIds = new Set<string>();
  const goldHitTags = new Set<string>();
  const falsePositiveIds: string[] = [];

  for (const record of scoped) {
    const matchedId = goldIds.has(record.id);
    const matchedTags = record.tags.filter((tag) => goldTags.has(tag));

    if (matchedId) {
      goldHitIds.add(record.id);
    }
    for (const tag of matchedTags) {
      goldHitTags.add(tag);
    }
    if (!matchedId && matchedTags.length === 0) {
      falsePositiveIds.push(record.id);
    }
  }

  return {
    case: item.case,
    level: item.level,
    negative: item.negative === true,
    query: item.query,
    returned: scoped.map(({ id, kind, tags }) => ({ id, kind, tags })),
    gold_hit: goldHitIds.size + goldHitTags.size,
    gold_total: goldTotal(item),
    false_positive_ids: falsePositiveIds,
    tokens: approximateTokenCount(scoped.map((record) => record.content).join("\n"))
  };
}

function scopedRecords(payload: EnabledContextPayload): RetrievedRecord[] {
  return payload.normalized_context.scoped.map((record) => ({
    id: record.id,
    kind: record.kind,
    tags: tagsFromScope(record.scope),
    content: record.content
  }));
}

function updateSummary(summary: RetrievalEvalSummary, row: RetrievalEvalRow): void {
  const level = String(row.level);
  let levelSummary = summary.levels[level];

  if (levelSummary === undefined) {
    levelSummary = {
      prompts: 0,
      gold_hits: 0,
      gold_total: 0,
      full_hit: 0,
      any_hit: 0,
      false_positive_prompts: 0,
      max_tokens: 0
    };
    summary.levels[level] = levelSummary;
  }

  levelSummary.prompts += 1;
  levelSummary.gold_hits += row.gold_hit;
  levelSummary.gold_total += row.gold_total;
  levelSummary.max_tokens = Math.max(levelSummary.max_tokens, row.tokens);

  if (row.negative) {
    summary.negative += 1;
  } else {
    summary.non_negative += 1;
    summary.gold_hits += row.gold_hit;
    summary.gold_total += row.gold_total;
    summary.max_tokens = Math.max(summary.max_tokens, row.tokens);

    if (row.gold_total > 0 && row.gold_hit === row.gold_total) {
      summary.prompt_full_hit += 1;
      levelSummary.full_hit += 1;
    }
    if (row.gold_hit > 0) {
      summary.prompt_any_hit += 1;
      levelSummary.any_hit += 1;
    }
  }

  if (row.false_positive_ids.length > 0) {
    summary.false_positive_prompts += 1;
    levelSummary.false_positive_prompts += 1;
  }
}

function goldTotal(item: RetrievalEvalFixtureCase): number {
  return (item.gold_ids?.length ?? 0) + (item.gold_tags?.length ?? 0);
}

function tagsFromScope(scope: Record<string, unknown>): string[] {
  return Array.isArray(scope.tags)
    ? [...new Set(scope.tags.filter((tag): tag is string => typeof tag === "string"))].sort(
        (left, right) => left.localeCompare(right)
      )
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }

  return value.trim();
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || typeof value !== "number" || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return value;
}

function optionalStringArray(value: unknown, name: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be a string array`);
  }

  const output = [...new Set(value.map((item) => nonEmptyString(item, name)))];

  return output;
}
