import type { ToolDefinition } from "../../schemas/types.js";

const stringArraySchema = { type: "array", items: { type: "string" } };
const cwdSchema = { cwd: { type: "string" } };
const observationProperties = {
  ...cwdSchema,
  event_id: { type: "string" },
  session_id: { type: "string" },
  observed_at: { type: "string" },
  recorded_by: { type: "string" },
  kind: { type: "string" },
  text: { type: "string" },
  source_type: { type: "string" },
  evidence: { type: "array" },
  scope: { type: "object" },
  supersedes: stringArraySchema
};

function objectSchema(
  properties: Record<string, unknown>,
  required?: string[]
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    ...(required !== undefined ? { required } : {}),
    additionalProperties: false
  };
}

export const toolDefinitions: ToolDefinition[] = [
  {
    name: "teamctx.get_context",
    description: "Return task-specific normalized context for the bound repository.",
    inputSchema: objectSchema({
      ...cwdSchema,
      target_files: stringArraySchema,
      changed_files: stringArraySchema,
      domains: stringArraySchema,
      symbols: stringArraySchema,
      tags: stringArraySchema,
      query: { type: "string" },
      since: { type: "string" },
      until: { type: "string" },
      source_types: stringArraySchema,
      evidence_files: stringArraySchema,
      branch: { type: "string" },
      head_commit: { type: "string" }
    })
  },
  {
    name: "teamctx.record_observation_candidate",
    description: "Record a weak session-derived observation as a raw candidate event.",
    inputSchema: objectSchema(observationProperties, ["kind", "text", "source_type"])
  },
  {
    name: "teamctx.record_observation_verified",
    description: "Record an observation with verifiable evidence as a raw event.",
    inputSchema: objectSchema(observationProperties, ["kind", "text", "source_type", "evidence"])
  },
  {
    name: "teamctx.normalize",
    description: "Normalize raw events into evidence-aware context records.",
    inputSchema: objectSchema({ ...cwdSchema, use_lease: { type: "boolean" } })
  },
  {
    name: "teamctx.status",
    description: "Show binding, store, and normalization status for the current repository.",
    inputSchema: objectSchema(cwdSchema)
  },
  {
    name: "teamctx.explain_item",
    description: "Explain the evidence, provenance, and state of a normalized context item.",
    inputSchema: objectSchema({ ...cwdSchema, item_id: { type: "string" } }, ["item_id"])
  },
  {
    name: "teamctx.explain_episode",
    description: "Explain an episode reference from the generated episode index.",
    inputSchema: objectSchema({ ...cwdSchema, episode_id: { type: "string" } }, ["episode_id"])
  },
  {
    name: "teamctx.invalidate",
    description: "Archive or invalidate an obsolete context item.",
    inputSchema: objectSchema(
      {
        ...cwdSchema,
        item_id: { type: "string" },
        reason: { type: "string" },
        human_confirmed: { type: "boolean" }
      },
      ["item_id", "human_confirmed"]
    )
  }
];
