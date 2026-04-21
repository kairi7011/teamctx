import type { ToolDefinition } from "../../schemas/types.js";

export const toolDefinitions: ToolDefinition[] = [
  {
    name: "teamctx.get_context",
    description: "Return task-specific normalized context for the bound repository."
  },
  {
    name: "teamctx.record_observation_candidate",
    description: "Record a weak session-derived observation as a raw candidate event."
  },
  {
    name: "teamctx.record_observation_verified",
    description: "Record an observation with verifiable evidence as a raw event."
  },
  {
    name: "teamctx.normalize",
    description: "Normalize raw events into evidence-aware context records."
  },
  {
    name: "teamctx.status",
    description: "Show binding, store, and normalization status for the current repository."
  },
  {
    name: "teamctx.explain_item",
    description: "Explain the evidence, provenance, and state of a normalized context item."
  },
  {
    name: "teamctx.invalidate",
    description: "Archive or invalidate an obsolete context item."
  }
];
