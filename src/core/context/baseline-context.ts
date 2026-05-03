import type {
  BaselineContextDiagnostics,
  GetContextCallReason,
  GetContextInput
} from "../../schemas/context-payload.js";

export const BASELINE_CONTEXT_BUDGET_TOKENS = 800;

export const BASELINE_CONTEXT_SECTIONS = [
  "must_follow_rules",
  "recent_decisions",
  "active_pitfalls",
  "applicable_workflows",
  "glossary_terms",
  "global"
] as const;

export function explainBaselineContext(input: GetContextInput = {}): BaselineContextDiagnostics {
  const callReason = input.call_reason ?? "task_start";
  const selectorCount = countSelectors(input);

  if (callReason === "session_start" && selectorCount === 0) {
    return {
      mode: "session_baseline",
      eligible: true,
      selector_count: selectorCount,
      budget_tokens: BASELINE_CONTEXT_BUDGET_TOKENS,
      included_sections: [...BASELINE_CONTEXT_SECTIONS],
      reasons: ["session_start without task selectors uses baseline continuity only"]
    };
  }

  if (callReason === "session_start") {
    return {
      mode: "task_scoped_with_baseline",
      eligible: true,
      selector_count: selectorCount,
      budget_tokens: BASELINE_CONTEXT_BUDGET_TOKENS,
      included_sections: [...BASELINE_CONTEXT_SECTIONS],
      reasons: ["session_start with selectors composes task-scoped context plus baseline sections"]
    };
  }

  if (selectorCount > 0) {
    return {
      mode: "task_scoped",
      eligible: false,
      selector_count: selectorCount,
      budget_tokens: BASELINE_CONTEXT_BUDGET_TOKENS,
      included_sections: [],
      reasons: [nonSessionReason(callReason)]
    };
  }

  return {
    mode: "not_session_start",
    eligible: false,
    selector_count: selectorCount,
    budget_tokens: BASELINE_CONTEXT_BUDGET_TOKENS,
    included_sections: [],
    reasons: ["baseline applies only to session_start calls"]
  };
}

function countSelectors(input: GetContextInput): number {
  const arraySelectorCount =
    (input.target_files?.length ?? 0) +
    (input.changed_files?.length ?? 0) +
    (input.domains?.length ?? 0) +
    (input.symbols?.length ?? 0) +
    (input.tags?.length ?? 0) +
    (input.source_types?.length ?? 0) +
    (input.evidence_files?.length ?? 0);

  return (
    arraySelectorCount +
    countPresent(input.query) +
    countPresent(input.since) +
    countPresent(input.until)
  );
}

function countPresent(value: string | undefined): number {
  return value === undefined ? 0 : 1;
}

function nonSessionReason(callReason: GetContextCallReason): string {
  switch (callReason) {
    case "task_start":
      return "task_start uses scoped selectors without repeating session baseline";
    case "context_changed":
      return "context_changed refreshes only the changed scoped context";
    case "explicit_user_request":
      return "explicit_user_request returns the requested scoped context without implicit baseline";
    case "session_start":
      return "session_start is baseline eligible";
  }
}
