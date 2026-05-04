import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ContextStoreAdapter } from "../../adapters/store/context-store.js";
import {
  getCurrentBranch,
  getHeadCommit,
  getOriginRemote,
  getRepoRoot
} from "../../adapters/git/local-git.js";
import { normalizeGitHubRepo } from "../../adapters/git/repo-url.js";
import { findBinding } from "../binding/local-bindings.js";
import { NORMALIZED_FILE_BY_KIND } from "../normalize/normalize.js";
import {
  createContextStoreForBinding,
  type ContextStoreFactoryServices
} from "../store/bound-store.js";
import { parseJsonlValidated } from "../store/jsonl.js";
import { resolveStoreRoot } from "../store/layout.js";
import { approximateTokenCount } from "../context/context-ranking.js";
import {
  validateNormalizedRecord,
  type KnowledgeKind,
  type NormalizedRecord
} from "../../schemas/normalized-record.js";
import type { Binding } from "../../schemas/types.js";

export type HygieneRiskKind =
  | "expired_active"
  | "not_yet_valid_active"
  | "old_active"
  | "unverified_active"
  | "duplicate_active_text"
  | "crowded_active_scope"
  | "large_active_record";

export type HygieneSeverity = "action" | "warning" | "info";

export type HygieneRiskItem = {
  risk: HygieneRiskKind;
  severity: HygieneSeverity;
  id: string;
  kind: KnowledgeKind;
  text: string;
  scope_summary: string;
  age_days?: number;
  token_count?: number;
  related_ids: string[];
  detail: string;
  suggested_action: string;
};

export type ContextHygieneReport = {
  checked_at: string;
  older_than_days: number;
  large_record_tokens: number;
  counts: {
    total_records: number;
    active_records: number;
    inactive_records: number;
    expired_active_records: number;
    not_yet_valid_active_records: number;
    old_active_records: number;
    unverified_active_records: number;
    duplicate_active_text_records: number;
    crowded_active_scope_records: number;
    large_active_records: number;
  };
  risk_items: HygieneRiskItem[];
  recovery_suggestions: string[];
};

export type HygieneReportOptions = {
  storeRoot: string;
  olderThanDays?: number;
  largeRecordTokens?: number;
  limit?: number;
  now?: () => Date;
};

export type HygieneSummaryOptions = Omit<HygieneReportOptions, "storeRoot">;

export type EnabledBoundHygieneReport = ContextHygieneReport & {
  enabled: true;
  repo: string;
  root: string;
  branch: string;
  head_commit: string;
  context_store: string;
  store_head: string | null;
  local_store: boolean;
};

export type DisabledBoundHygieneReport = {
  enabled: false;
  reason: string;
  repo?: string;
  root?: string;
  branch?: string;
  head_commit?: string;
};

export type BoundHygieneReport = EnabledBoundHygieneReport | DisabledBoundHygieneReport;

export type BoundHygieneServices = ContextStoreFactoryServices & {
  getRepoRoot: (cwd?: string) => string;
  getOriginRemote: (cwd?: string) => string;
  getCurrentBranch: (cwd?: string) => string;
  getHeadCommit: (cwd?: string) => string;
  findBinding: (repo: string) => Binding | undefined;
};

export type BoundHygieneOptions = HygieneSummaryOptions & {
  cwd?: string;
  services?: BoundHygieneServices;
};

const DEFAULT_OLDER_THAN_DAYS = 90;
const DEFAULT_LARGE_RECORD_TOKENS = 250;
const DEFAULT_LIMIT = 20;
const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;

const defaultServices: BoundHygieneServices = {
  getRepoRoot,
  getOriginRemote,
  getCurrentBranch,
  getHeadCommit,
  findBinding
};

export function summarizeContextStoreHygiene(options: HygieneReportOptions): ContextHygieneReport {
  return summarizeRecordsHygiene(readLocalRecords(options.storeRoot), options);
}

export async function summarizeContextStoreAdapterHygiene(options: {
  store: ContextStoreAdapter;
  olderThanDays?: number;
  largeRecordTokens?: number;
  limit?: number;
  now?: () => Date;
}): Promise<ContextHygieneReport> {
  return summarizeRecordsHygiene(await readAdapterRecords(options.store), options);
}

export async function getBoundHygieneReport(
  options: BoundHygieneOptions = {}
): Promise<BoundHygieneReport> {
  const services = options.services ?? defaultServices;
  let root: string;
  let repo: string;
  let branch: string;
  let headCommit: string;

  try {
    root = services.getRepoRoot(options.cwd);
    repo = normalizeGitHubRepo(services.getOriginRemote(root));
    branch = services.getCurrentBranch(root);
    headCommit = services.getHeadCommit(root);
  } catch {
    return {
      enabled: false,
      reason: "No git repository with an origin remote found for this workspace."
    };
  }

  const binding = services.findBinding(repo);

  if (!binding) {
    return {
      enabled: false,
      repo,
      root,
      branch,
      head_commit: headCommit,
      reason: "No teamctx binding found for this git root."
    };
  }

  const base = {
    repo,
    root,
    branch,
    head_commit: headCommit,
    context_store: `${binding.contextStore.repo}/${binding.contextStore.path}`
  };

  if (binding.contextStore.repo === repo) {
    return {
      enabled: true,
      ...base,
      store_head: null,
      local_store: true,
      ...summarizeContextStoreHygiene({
        storeRoot: resolveStoreRoot(root, binding.contextStore.path),
        ...hygieneOptions(options)
      })
    };
  }

  const store = createContextStoreForBinding({
    repo,
    repoRoot: root,
    binding,
    ...(services.createContextStore !== undefined
      ? { createContextStore: services.createContextStore }
      : {})
  });

  return {
    enabled: true,
    ...base,
    store_head: await store.getRevision(),
    local_store: false,
    ...(await summarizeContextStoreAdapterHygiene({
      store,
      ...hygieneOptions(options)
    }))
  };
}

export function summarizeRecordsHygiene(
  records: NormalizedRecord[],
  options: HygieneSummaryOptions = {}
): ContextHygieneReport {
  const checkedAt = (options.now ?? (() => new Date()))();
  const olderThanDays = options.olderThanDays ?? DEFAULT_OLDER_THAN_DAYS;
  const largeRecordTokens = options.largeRecordTokens ?? DEFAULT_LARGE_RECORD_TOKENS;
  const limit = options.limit ?? DEFAULT_LIMIT;
  const activeRecords = records.filter((record) => record.state === "active");
  const riskItems = [
    ...validityRisks(activeRecords, checkedAt),
    ...oldActiveRisks(activeRecords, checkedAt, olderThanDays),
    ...unverifiedActiveRisks(activeRecords),
    ...duplicateTextRisks(activeRecords),
    ...crowdedScopeRisks(activeRecords),
    ...largeRecordRisks(activeRecords, largeRecordTokens)
  ].sort(compareRiskItems);

  const limitedRiskItems = riskItems.slice(0, limit);

  return {
    checked_at: checkedAt.toISOString(),
    older_than_days: olderThanDays,
    large_record_tokens: largeRecordTokens,
    counts: {
      total_records: records.length,
      active_records: activeRecords.length,
      inactive_records: records.length - activeRecords.length,
      expired_active_records: countRisk(riskItems, "expired_active"),
      not_yet_valid_active_records: countRisk(riskItems, "not_yet_valid_active"),
      old_active_records: countRisk(riskItems, "old_active"),
      unverified_active_records: countRisk(riskItems, "unverified_active"),
      duplicate_active_text_records: countRisk(riskItems, "duplicate_active_text"),
      crowded_active_scope_records: countRisk(riskItems, "crowded_active_scope"),
      large_active_records: countRisk(riskItems, "large_active_record")
    },
    risk_items: limitedRiskItems,
    recovery_suggestions: recoverySuggestions(riskItems, limitedRiskItems.length, riskItems.length)
  };
}

function hygieneOptions(options: BoundHygieneOptions): HygieneSummaryOptions {
  return {
    ...(options.olderThanDays !== undefined ? { olderThanDays: options.olderThanDays } : {}),
    ...(options.largeRecordTokens !== undefined
      ? { largeRecordTokens: options.largeRecordTokens }
      : {}),
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
    ...(options.now !== undefined ? { now: options.now } : {})
  };
}

function validityRisks(records: NormalizedRecord[], now: Date): HygieneRiskItem[] {
  return records.flatMap((record) => {
    const risks: HygieneRiskItem[] = [];
    const validUntil = parseTime(record.valid_until);
    const validFrom = parseTime(record.valid_from);

    if (validUntil !== undefined && validUntil < now.getTime()) {
      risks.push(
        riskItem(record, "expired_active", "action", {
          detail: `valid_until ${record.valid_until} is before ${now.toISOString()}`,
          suggestedAction:
            'Run `teamctx invalidate <id> --reason "validity window expired"` or record a superseding observation.'
        })
      );
    }

    if (validFrom !== undefined && validFrom > now.getTime()) {
      risks.push(
        riskItem(record, "not_yet_valid_active", "warning", {
          detail: `valid_from ${record.valid_from} is after ${now.toISOString()}`,
          suggestedAction:
            "Review the observation date or keep it out of active context until the validity window starts."
        })
      );
    }

    return risks;
  });
}

function oldActiveRisks(
  records: NormalizedRecord[],
  now: Date,
  olderThanDays: number
): HygieneRiskItem[] {
  return records.flatMap((record) => {
    const lastSeen = parseTime(lastSeenAt(record));

    if (lastSeen === undefined) {
      return [];
    }

    const ageDays = Math.floor((now.getTime() - lastSeen) / MILLIS_PER_DAY);

    if (ageDays < olderThanDays) {
      return [];
    }

    return [
      riskItem(record, "old_active", "warning", {
        ageDays,
        detail: `last verified or observed ${ageDays} days ago`,
        suggestedAction:
          "Re-read the evidence and record a fresh verified observation, or invalidate it if the context is no longer true."
      })
    ];
  });
}

function unverifiedActiveRisks(records: NormalizedRecord[]): HygieneRiskItem[] {
  return records
    .filter((record) => record.last_verified_at === undefined)
    .map((record) =>
      riskItem(record, "unverified_active", "info", {
        detail: "active record has no last_verified_at timestamp",
        suggestedAction:
          "Re-record the item with verified evidence when it matters for recurring decisions."
      })
    );
}

function duplicateTextRisks(records: NormalizedRecord[]): HygieneRiskItem[] {
  return groupedRisks(
    records,
    duplicateTextKey,
    "duplicate_active_text",
    "warning",
    (record, ids) => ({
      detail: `same kind and normalized text also appears in ${ids.filter((id) => id !== record.id).join(", ")}`,
      suggestedAction:
        "Use `teamctx show` / `teamctx explain` to compare evidence, then invalidate or supersede duplicate records."
    })
  );
}

function crowdedScopeRisks(records: NormalizedRecord[]): HygieneRiskItem[] {
  return groupedRisks(records, crowdedScopeKey, "crowded_active_scope", "info", (record, ids) => ({
    detail: `${ids.length} active ${record.kind} records share the same scope`,
    suggestedAction:
      "Review whether the records should be merged, narrowed by tag/symbol, or promoted into a canonical workflow/rule."
  })).filter((risk) => risk.related_ids.length >= 4);
}

function largeRecordRisks(
  records: NormalizedRecord[],
  largeRecordTokens: number
): HygieneRiskItem[] {
  return records.flatMap((record) => {
    const tokenCount = approximateTokenCount(record.text);

    if (tokenCount < largeRecordTokens) {
      return [];
    }

    return [
      riskItem(record, "large_active_record", "info", {
        tokenCount,
        detail: `record text is about ${tokenCount} tokens before context truncation`,
        suggestedAction:
          "Split the record into smaller scoped facts/rules, or move detailed prose into a canonical doc reference."
      })
    ];
  });
}

function groupedRisks(
  records: NormalizedRecord[],
  keyFor: (record: NormalizedRecord) => string,
  risk: HygieneRiskKind,
  severity: HygieneSeverity,
  detailFor: (
    record: NormalizedRecord,
    relatedIds: string[]
  ) => { detail: string; suggestedAction: string }
): HygieneRiskItem[] {
  const groups = new Map<string, NormalizedRecord[]>();

  for (const record of records) {
    const key = keyFor(record);
    const group = groups.get(key);

    if (group) {
      group.push(record);
    } else {
      groups.set(key, [record]);
    }
  }

  const risks: HygieneRiskItem[] = [];

  for (const group of groups.values()) {
    if (group.length < 2) {
      continue;
    }

    const ids = group.map((record) => record.id).sort((left, right) => left.localeCompare(right));

    for (const record of group) {
      const detail = detailFor(record, ids);

      risks.push(
        riskItem(record, risk, severity, {
          relatedIds: ids,
          detail: detail.detail,
          suggestedAction: detail.suggestedAction
        })
      );
    }
  }

  return risks;
}

function riskItem(
  record: NormalizedRecord,
  risk: HygieneRiskKind,
  severity: HygieneSeverity,
  detail: {
    detail: string;
    suggestedAction: string;
    ageDays?: number;
    tokenCount?: number;
    relatedIds?: string[];
  }
): HygieneRiskItem {
  const item: HygieneRiskItem = {
    risk,
    severity,
    id: record.id,
    kind: record.kind,
    text: record.text,
    scope_summary: scopeSummary(record),
    related_ids: detail.relatedIds ?? [],
    detail: detail.detail,
    suggested_action: detail.suggestedAction
  };

  if (detail.ageDays !== undefined) {
    item.age_days = detail.ageDays;
  }
  if (detail.tokenCount !== undefined) {
    item.token_count = detail.tokenCount;
  }

  return item;
}

function compareRiskItems(left: HygieneRiskItem, right: HygieneRiskItem): number {
  return (
    severityRank(right.severity) - severityRank(left.severity) ||
    riskRank(left.risk) - riskRank(right.risk) ||
    (right.age_days ?? 0) - (left.age_days ?? 0) ||
    (right.token_count ?? 0) - (left.token_count ?? 0) ||
    left.id.localeCompare(right.id)
  );
}

function severityRank(severity: HygieneSeverity): number {
  switch (severity) {
    case "action":
      return 3;
    case "warning":
      return 2;
    case "info":
      return 1;
  }
}

function riskRank(risk: HygieneRiskKind): number {
  return [
    "expired_active",
    "not_yet_valid_active",
    "old_active",
    "duplicate_active_text",
    "crowded_active_scope",
    "large_active_record",
    "unverified_active"
  ].indexOf(risk);
}

function countRisk(items: HygieneRiskItem[], risk: HygieneRiskKind): number {
  return items.filter((item) => item.risk === risk).length;
}

function recoverySuggestions(
  riskItems: HygieneRiskItem[],
  shownCount: number,
  totalCount: number
): string[] {
  const suggestions: string[] = [];
  const risks = new Set(riskItems.map((item) => item.risk));

  if (risks.has("expired_active") || risks.has("not_yet_valid_active")) {
    suggestions.push(
      "Fix validity-window risks first; active records outside their valid window can mislead default context retrieval."
    );
  }
  if (risks.has("old_active")) {
    suggestions.push(
      "Review old active records during maintenance; teamctx does not auto-expire old knowledge without evidence."
    );
  }
  if (risks.has("duplicate_active_text") || risks.has("crowded_active_scope")) {
    suggestions.push(
      "Use `teamctx show`, `teamctx explain`, and `teamctx invalidate` to merge, supersede, or narrow noisy active records."
    );
  }
  if (risks.has("large_active_record")) {
    suggestions.push(
      "Split oversized active records or move detail into canonical docs so context budgets carry decisions instead of prose."
    );
  }
  if (shownCount < totalCount) {
    suggestions.push(
      `Only ${shownCount} of ${totalCount} risk items are shown; rerun with a larger --limit to inspect all.`
    );
  }

  return suggestions;
}

function readLocalRecords(storeRoot: string): NormalizedRecord[] {
  return Object.values(NORMALIZED_FILE_BY_KIND).flatMap((file) => {
    const path = join(storeRoot, "normalized", file);

    if (!existsSync(path)) {
      return [];
    }

    return parseJsonl(readFileSync(path, "utf8"));
  });
}

async function readAdapterRecords(store: ContextStoreAdapter): Promise<NormalizedRecord[]> {
  const groups = await Promise.all(
    Object.values(NORMALIZED_FILE_BY_KIND).map(async (file) => {
      const storeFile = await store.readText(`normalized/${file}`);

      return parseJsonl(storeFile?.content ?? "");
    })
  );

  return groups.flat();
}

function parseJsonl(content: string): NormalizedRecord[] {
  return parseJsonlValidated(content, validateNormalizedRecord);
}

function lastSeenAt(record: NormalizedRecord): string {
  return record.last_verified_at ?? record.provenance.observed_at;
}

function parseTime(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Date.parse(value);

  return Number.isFinite(parsed) ? parsed : undefined;
}

function duplicateTextKey(record: NormalizedRecord): string {
  return `${record.kind}:${normalizeText(record.text)}`;
}

function crowdedScopeKey(record: NormalizedRecord): string {
  return JSON.stringify({
    kind: record.kind,
    paths: sorted(record.scope.paths),
    domains: sortedLower(record.scope.domains),
    symbols: sorted(record.scope.symbols),
    tags: sortedLower(record.scope.tags)
  });
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}_]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function sorted(values: string[]): string[] {
  return [...values].map((value) => value.trim()).sort((left, right) => left.localeCompare(right));
}

function sortedLower(values: string[]): string[] {
  return sorted(values.map((value) => value.toLowerCase()));
}

function scopeSummary(record: NormalizedRecord): string {
  const parts: string[] = [];

  if (record.scope.paths.length > 0) {
    parts.push(`paths=${record.scope.paths.slice(0, 2).join(",")}`);
  }
  if (record.scope.domains.length > 0) {
    parts.push(`domains=${record.scope.domains.join(",")}`);
  }
  if (record.scope.symbols.length > 0) {
    parts.push(`symbols=${record.scope.symbols.slice(0, 2).join(",")}`);
  }
  if (record.scope.tags.length > 0) {
    parts.push(`tags=${record.scope.tags.join(",")}`);
  }

  return parts.length > 0 ? parts.join("; ") : "global";
}
