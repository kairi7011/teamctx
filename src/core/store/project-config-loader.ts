import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ContextStoreAdapter } from "../../adapters/store/context-store.js";
import {
  parseProjectConfig,
  type ContextBudgetsConfig,
  type ProjectConfig
} from "../../schemas/project.js";
import {
  resolveContextBudgets,
  type ContextBudgets,
  type ContextBudgetsOverride
} from "../context/context-ranking.js";

const PROJECT_CONFIG_FILE = "project.yaml";

export function readProjectConfig(storeRoot: string): ProjectConfig | undefined {
  try {
    const content = readFileSync(join(storeRoot, PROJECT_CONFIG_FILE), "utf8");
    return parseProjectConfig(content);
  } catch {
    return undefined;
  }
}

export async function readProjectConfigFromContextStore(
  store: ContextStoreAdapter
): Promise<ProjectConfig | undefined> {
  try {
    const file = await store.readText(PROJECT_CONFIG_FILE);
    if (!file) {
      return undefined;
    }
    return parseProjectConfig(file.content);
  } catch {
    return undefined;
  }
}

export function resolveBudgetsFromConfig(config: ProjectConfig | undefined): ContextBudgets {
  return resolveContextBudgets(toBudgetsOverride(config?.context_budgets));
}

function toBudgetsOverride(config: ContextBudgetsConfig | undefined): ContextBudgetsOverride {
  if (!config) {
    return {};
  }

  const override: ContextBudgetsOverride = {};

  if (config.scoped_items !== undefined) override.scopedItems = config.scoped_items;
  if (config.global_items !== undefined) override.globalItems = config.global_items;
  if (config.rules !== undefined) override.rules = config.rules;
  if (config.decisions !== undefined) override.decisions = config.decisions;
  if (config.pitfalls !== undefined) override.pitfalls = config.pitfalls;
  if (config.workflows !== undefined) override.workflows = config.workflows;
  if (config.glossary !== undefined) override.glossary = config.glossary;
  if (config.episodes !== undefined) override.episodes = config.episodes;
  if (config.content_tokens !== undefined) {
    override.contentTokens = config.content_tokens;
  } else if (config.content_chars !== undefined) {
    override.contentTokens = Math.max(1, Math.ceil(config.content_chars / 4));
  }

  return override;
}
