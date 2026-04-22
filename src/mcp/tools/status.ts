import { getBoundStatus, type BoundStatusServices } from "../../core/status/status.js";
import { isRecord } from "../../schemas/validation.js";

export function statusTool(rawInput: unknown, services?: BoundStatusServices): unknown {
  const cwd = getOptionalString(rawInput, "cwd");

  return getBoundStatus({
    ...(cwd !== undefined ? { cwd } : {}),
    ...(services !== undefined ? { services } : {})
  });
}

function getOptionalString(rawInput: unknown, key: string): string | undefined {
  if (!isRecord(rawInput)) {
    return undefined;
  }

  const value = rawInput[key];

  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`status ${key} must be a non-empty string`);
  }

  return value;
}
