import { normalizeBoundStore, type NormalizeServices } from "../../core/normalize/normalize.js";
import { isRecord } from "../../schemas/validation.js";

export function normalizeTool(rawInput: unknown, services?: NormalizeServices): unknown {
  const cwd = getOptionalString(rawInput, "cwd");

  return normalizeBoundStore({
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
    throw new Error(`normalize ${key} must be a non-empty string`);
  }

  return value;
}
