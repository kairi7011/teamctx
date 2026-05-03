import assert from "node:assert/strict";
import test from "node:test";
import { formatCapabilitiesReport, formatToolsReport } from "../../src/cli/index.js";
import type { BindingCapabilities } from "../../src/core/capabilities.js";
import { toolDefinitions } from "../../src/mcp/tools/definitions.js";

test("formatToolsReport renders one human-readable line per MCP tool", () => {
  const formatted = formatToolsReport(toolDefinitions);

  assert.match(
    formatted,
    /teamctx\.get_context: Return task-specific normalized context for the bound repository\./
  );
  assert.match(formatted, /teamctx\.invalidate: Archive or invalidate an obsolete context item\./);
  assert.equal(formatted.split("\n").length, toolDefinitions.length);
  assert.doesNotMatch(formatted, /inputSchema/);
});

test("formatCapabilitiesReport renders stable capability lines", () => {
  const capabilities: BindingCapabilities = {
    bound: true,
    store_kind: "github",
    normalize_supported: true,
    background_jobs: false,
    store: {
      remote_writes: true,
      optimistic_concurrency: true,
      revision_tracking: true,
      append_only_jsonl: true,
      batch_writes: false,
      semantic_features: false
    }
  };

  assert.deepEqual(formatCapabilitiesReport(capabilities).split("\n"), [
    "bound: true",
    "store_kind: github",
    "normalize_supported: true",
    "background_jobs: false",
    "store:",
    "  remote_writes: true",
    "  optimistic_concurrency: true",
    "  revision_tracking: true",
    "  append_only_jsonl: true",
    "  batch_writes: false",
    "  semantic_features: false"
  ]);
});
