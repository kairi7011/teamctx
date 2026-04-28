export type RetentionConfig = {
  raw_candidate_days: number;
  audit_days: number;
  archive_path: string;
};

export type ContextBudgetsConfig = {
  scoped_items?: number;
  global_items?: number;
  rules?: number;
  decisions?: number;
  pitfalls?: number;
  workflows?: number;
  glossary?: number;
  episodes?: number;
  content_tokens?: number;
  content_chars?: number;
};

export type ProjectConfig = {
  format_version: 1;
  project_id: string;
  normalizer_version: string;
  retention: RetentionConfig;
  context_budgets?: ContextBudgetsConfig;
};

const CONTEXT_BUDGET_KEYS: ReadonlyArray<keyof ContextBudgetsConfig> = [
  "scoped_items",
  "global_items",
  "rules",
  "decisions",
  "pitfalls",
  "workflows",
  "glossary",
  "episodes",
  "content_tokens",
  "content_chars"
];

export function createDefaultProjectConfig(
  projectId: string,
  normalizerVersion = "0.1.0"
): ProjectConfig {
  return {
    format_version: 1,
    project_id: projectId,
    normalizer_version: normalizerVersion,
    retention: {
      raw_candidate_days: 30,
      audit_days: 180,
      archive_path: "archive/"
    }
  };
}

export function validateProjectConfig(value: unknown): ProjectConfig {
  if (!isRecord(value)) {
    throw new Error("project config must be an object");
  }

  if (value.format_version !== 1) {
    throw new Error("project config format_version must be 1");
  }

  if (typeof value.project_id !== "string" || value.project_id.length === 0) {
    throw new Error("project config project_id must be a non-empty string");
  }

  if (typeof value.normalizer_version !== "string" || value.normalizer_version.length === 0) {
    throw new Error("project config normalizer_version must be a non-empty string");
  }

  if (!isRetentionConfig(value.retention)) {
    throw new Error("project config retention is invalid");
  }

  const config: ProjectConfig = {
    format_version: value.format_version,
    project_id: value.project_id,
    normalizer_version: value.normalizer_version,
    retention: value.retention
  };

  if (value.context_budgets !== undefined) {
    config.context_budgets = validateContextBudgets(value.context_budgets);
  }

  return config;
}

function validateContextBudgets(value: unknown): ContextBudgetsConfig {
  if (!isRecord(value)) {
    throw new Error("project config context_budgets must be an object");
  }

  const result: ContextBudgetsConfig = {};

  for (const key of CONTEXT_BUDGET_KEYS) {
    const raw = value[key];

    if (raw === undefined) {
      continue;
    }

    if (!isPositiveInteger(raw)) {
      throw new Error(`project config context_budgets.${key} must be a positive integer`);
    }

    result[key] = raw;
  }

  return result;
}

export function serializeProjectConfig(value: ProjectConfig): string {
  const config = validateProjectConfig(value);
  const lines = [
    `format_version: ${config.format_version}`,
    `project_id: ${yamlString(config.project_id)}`,
    `normalizer_version: ${yamlString(config.normalizer_version)}`,
    "retention:",
    `  raw_candidate_days: ${config.retention.raw_candidate_days}`,
    `  audit_days: ${config.retention.audit_days}`,
    `  archive_path: ${yamlString(config.retention.archive_path)}`
  ];

  if (config.context_budgets !== undefined) {
    lines.push("context_budgets:");
    for (const key of CONTEXT_BUDGET_KEYS) {
      const value = config.context_budgets[key];
      if (value !== undefined) {
        lines.push(`  ${key}: ${value}`);
      }
    }
  }

  lines.push("");

  return lines.join("\n");
}

export function parseProjectConfig(content: string): ProjectConfig {
  const root: Record<string, unknown> = {};
  const sections: Record<"retention" | "context_budgets", Record<string, unknown>> = {
    retention: {},
    context_budgets: {}
  };
  let section: "retention" | "context_budgets" | undefined;

  for (const line of content.split(/\r?\n/)) {
    if (line.trim().length === 0) {
      continue;
    }

    const indentation = line.length - line.trimStart().length;
    const trimmed = line.trim();
    const separatorIndex = trimmed.indexOf(":");

    if (separatorIndex === -1) {
      throw new Error(`project config line is invalid: ${trimmed}`);
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();

    if (rawValue.length === 0) {
      if (indentation !== 0 || (key !== "retention" && key !== "context_budgets")) {
        throw new Error(`project config section is invalid: ${key}`);
      }
      section = key;
      root[key] = sections[key];
      continue;
    }

    if (indentation > 0) {
      if (section === undefined) {
        throw new Error(`project config nested key is invalid: ${key}`);
      }
      sections[section][key] = parseScalar(rawValue);
    } else {
      section = undefined;
      root[key] = parseScalar(rawValue);
    }
  }

  return validateProjectConfig(root);
}

function parseScalar(value: string): string | number {
  if (/^-?\d+$/.test(value)) {
    return Number(value);
  }

  if (value.startsWith('"')) {
    const parsed = JSON.parse(value) as unknown;

    if (typeof parsed !== "string") {
      throw new Error("project config quoted values must be strings");
    }

    return parsed;
  }

  return value;
}

function isRetentionConfig(value: unknown): value is RetentionConfig {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isPositiveInteger(value.raw_candidate_days) &&
    isPositiveInteger(value.audit_days) &&
    typeof value.archive_path === "string" &&
    value.archive_path.length > 0
  );
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}
