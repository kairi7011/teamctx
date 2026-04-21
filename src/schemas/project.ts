export type RetentionConfig = {
  raw_candidate_days: number;
  audit_days: number;
  archive_path: string;
};

export type ProjectConfig = {
  format_version: 1;
  project_id: string;
  normalizer_version: string;
  retention: RetentionConfig;
};

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

  return {
    format_version: value.format_version,
    project_id: value.project_id,
    normalizer_version: value.normalizer_version,
    retention: value.retention
  };
}

export function serializeProjectConfig(value: ProjectConfig): string {
  const config = validateProjectConfig(value);

  return [
    `format_version: ${config.format_version}`,
    `project_id: ${yamlString(config.project_id)}`,
    `normalizer_version: ${yamlString(config.normalizer_version)}`,
    "retention:",
    `  raw_candidate_days: ${config.retention.raw_candidate_days}`,
    `  audit_days: ${config.retention.audit_days}`,
    `  archive_path: ${yamlString(config.retention.archive_path)}`,
    ""
  ].join("\n");
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
