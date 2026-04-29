import type {
  ContextPayload,
  EnabledContextPayload,
  GetContextInput
} from "../../schemas/context-payload.js";

export type ContextDiff = DisabledContextDiff | EnabledContextDiff;

export type DisabledContextDiff = {
  enabled: false;
  left: DisabledSide;
  right: DisabledSide;
};

export type EnabledContextDiff = {
  enabled: true;
  left: EnabledSide;
  right: EnabledSide;
  scoped: IdSetDiff;
  categories: Record<ContextCategory, ValueSetDiff>;
  relevant_episodes: IdSetDiff;
  canonical_doc_refs: ValueSetDiff;
  diagnostics: Record<DiagnosticCategory, ValueSetDiff>;
};

export type DisabledSide = {
  input: GetContextInput;
  enabled: boolean;
  reason?: string;
  context_payload_hash?: string;
};

export type EnabledSide = {
  input: GetContextInput;
  enabled: true;
  context_payload_hash: string;
  store_head: string | null;
};

export type IdSetDiff = {
  added: string[];
  removed: string[];
  unchanged: string[];
};

export type ValueSetDiff = IdSetDiff & {
  added_count: number;
  removed_count: number;
  unchanged_count: number;
};

export type ContextCategory =
  | "global"
  | "must_follow_rules"
  | "recent_decisions"
  | "active_pitfalls"
  | "applicable_workflows"
  | "glossary_terms";

export type DiagnosticCategory =
  | "contested_items"
  | "stale_items"
  | "dropped_items"
  | "excluded_items"
  | "budget_rejected"
  | "index_warnings";

export function diffContextPayloads(
  left: ContextPayload,
  right: ContextPayload,
  leftInput: GetContextInput,
  rightInput: GetContextInput
): ContextDiff {
  if (!left.enabled || !right.enabled) {
    return {
      enabled: false,
      left: disabledSide(left, leftInput),
      right: disabledSide(right, rightInput)
    };
  }

  return {
    enabled: true,
    left: enabledSide(left, leftInput),
    right: enabledSide(right, rightInput),
    scoped: diffValues(scopedIds(left), scopedIds(right)),
    categories: {
      global: diffCountedValues(globalValues(left), globalValues(right)),
      must_follow_rules: diffCountedValues(
        left.normalized_context.must_follow_rules,
        right.normalized_context.must_follow_rules
      ),
      recent_decisions: diffCountedValues(
        left.normalized_context.recent_decisions,
        right.normalized_context.recent_decisions
      ),
      active_pitfalls: diffCountedValues(
        left.normalized_context.active_pitfalls,
        right.normalized_context.active_pitfalls
      ),
      applicable_workflows: diffCountedValues(
        left.normalized_context.applicable_workflows,
        right.normalized_context.applicable_workflows
      ),
      glossary_terms: diffCountedValues(
        left.normalized_context.glossary_terms,
        right.normalized_context.glossary_terms
      )
    },
    relevant_episodes: diffValues(episodeIds(left), episodeIds(right)),
    canonical_doc_refs: diffCountedValues(docRefKeys(left), docRefKeys(right)),
    diagnostics: {
      contested_items: diffCountedValues(
        left.diagnostics.contested_items,
        right.diagnostics.contested_items
      ),
      stale_items: diffCountedValues(left.diagnostics.stale_items, right.diagnostics.stale_items),
      dropped_items: diffCountedValues(
        left.diagnostics.dropped_items,
        right.diagnostics.dropped_items
      ),
      excluded_items: diffCountedValues(excludedItemIds(left), excludedItemIds(right)),
      budget_rejected: diffCountedValues(budgetRejectedIds(left), budgetRejectedIds(right)),
      index_warnings: diffCountedValues(
        left.diagnostics.index_warnings,
        right.diagnostics.index_warnings
      )
    }
  };
}

function disabledSide(payload: ContextPayload, input: GetContextInput): DisabledSide {
  if (!payload.enabled) {
    return { input, enabled: false, reason: payload.reason };
  }

  return {
    input,
    enabled: true,
    context_payload_hash: payload.identity.context_payload_hash
  };
}

function enabledSide(payload: EnabledContextPayload, input: GetContextInput): EnabledSide {
  return {
    input,
    enabled: true,
    context_payload_hash: payload.identity.context_payload_hash,
    store_head: payload.identity.store_head
  };
}

function scopedIds(payload: EnabledContextPayload): string[] {
  return payload.normalized_context.scoped.map((item) => item.id);
}

function globalValues(payload: EnabledContextPayload): string[] {
  return payload.normalized_context.global.length > 0 ? [payload.normalized_context.global] : [];
}

function episodeIds(payload: EnabledContextPayload): string[] {
  return payload.relevant_episodes.map((episode) => episode.episode_id);
}

function docRefKeys(payload: EnabledContextPayload): string[] {
  return payload.canonical_doc_refs.map((ref) =>
    [ref.repo, ref.path, ref.commit, ref.item_id, ref.lines?.[0] ?? "", ref.lines?.[1] ?? ""].join(
      "#"
    )
  );
}

function excludedItemIds(payload: EnabledContextPayload): string[] {
  return payload.diagnostics.excluded_items.map((item) => item.id);
}

function budgetRejectedIds(payload: EnabledContextPayload): string[] {
  return payload.diagnostics.budget_rejected.map((item) => item.id);
}

function diffCountedValues(left: string[], right: string[]): ValueSetDiff {
  const diff = diffValues(left, right);

  return {
    ...diff,
    added_count: diff.added.length,
    removed_count: diff.removed.length,
    unchanged_count: diff.unchanged.length
  };
}

function diffValues(left: string[], right: string[]): IdSetDiff {
  const leftSet = new Set(left);
  const rightSet = new Set(right);

  return {
    added: sorted([...rightSet].filter((value) => !leftSet.has(value))),
    removed: sorted([...leftSet].filter((value) => !rightSet.has(value))),
    unchanged: sorted([...leftSet].filter((value) => rightSet.has(value)))
  };
}

function sorted(values: string[]): string[] {
  return values.sort((left, right) => left.localeCompare(right));
}
