// Public library surface for `teamctx`. The CLI and MCP server do not depend
// on this barrel; it is intended for consumers that want to embed teamctx
// modules directly. The exported name set is asserted by
// `test/unit/public-api.test.ts` so that adding or removing an export is an
// intentional, reviewed change.

export * from "./adapters/git/local-git.js";
export * from "./adapters/git/repo-url.js";
export * from "./adapters/github/github-client.js";
export * from "./adapters/github/contents-store.js";
export * from "./adapters/store/context-store.js";
export * from "./adapters/store/local-store.js";
export * from "./core/binding/context-store.js";
export * from "./core/binding/local-bindings.js";
export * from "./core/capabilities.js";
export * from "./core/audit/control.js";
export * from "./core/context/compose-context.js";
export * from "./core/context/context-ranking.js";
export * from "./core/episodes/explain.js";
export * from "./core/errors.js";
export * from "./core/indexes/episode-index.js";
export * from "./core/indexes/record-index.js";
export * from "./core/normalize/confidence.js";
export * from "./core/normalize/normalize.js";
export * from "./core/observation/record.js";
export * from "./core/policy/redaction-policy.js";
export * from "./core/retention/compact.js";
export * from "./core/status/status.js";
export * from "./core/status/summary.js";
export * from "./core/store/bound-store.js";
export * from "./core/store/init-store.js";
export * from "./core/store/layout.js";
export * from "./core/store/raw-event-path.js";
export * from "./mcp/tools/get-context.js";
export * from "./mcp/tools/explain-episode.js";
export * from "./mcp/tools/explain-item.js";
export * from "./mcp/tools/invalidate.js";
export * from "./mcp/tools/normalize.js";
export * from "./mcp/tools/record-observation.js";
export * from "./mcp/tools/status.js";
export * from "./mcp/tools/definitions.js";
export * from "./schemas/audit.js";
export * from "./schemas/context-payload.js";
export * from "./schemas/episode.js";
export * from "./schemas/evidence.js";
export * from "./schemas/normalized-record.js";
export * from "./schemas/observation.js";
export * from "./schemas/project.js";
export * from "./schemas/types.js";
export * from "./schemas/validation.js";
