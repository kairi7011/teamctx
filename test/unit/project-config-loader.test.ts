import assert from "node:assert/strict";
import test from "node:test";
import { resolveBudgetsFromConfig } from "../../src/core/store/project-config-loader.js";
import type { ProjectConfig } from "../../src/schemas/project.js";

test("resolveBudgetsFromConfig prefers content_tokens", () => {
  assert.equal(
    resolveBudgetsFromConfig(projectConfig({ content_tokens: 80, content_chars: 200 }))
      .contentTokens,
    80
  );
});

test("resolveBudgetsFromConfig maps legacy content_chars to approximate tokens", () => {
  assert.equal(resolveBudgetsFromConfig(projectConfig({ content_chars: 200 })).contentTokens, 50);
});

function projectConfig(contextBudgets: ProjectConfig["context_budgets"]): ProjectConfig {
  const config: ProjectConfig = {
    format_version: 1,
    project_id: "github.com/team/service",
    normalizer_version: "0.1.0",
    retention: {
      raw_candidate_days: 30,
      audit_days: 180,
      archive_path: "archive/"
    }
  };

  if (contextBudgets !== undefined) {
    config.context_budgets = contextBudgets;
  }

  return config;
}
