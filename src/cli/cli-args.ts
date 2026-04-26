import { CliError, CLI_EXIT } from "./cli-error.js";

export function parseLimitFlag(
  value: string | boolean | undefined,
  flagName = "--limit"
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new CliError(CLI_EXIT.VALIDATION, `${flagName} requires a positive integer`);
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new CliError(CLI_EXIT.VALIDATION, `${flagName} must be a positive integer`);
  }

  return parsed;
}

export function parseOffsetFlag(
  value: string | boolean | undefined,
  flagName = "--offset"
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new CliError(CLI_EXIT.VALIDATION, `${flagName} requires a non-negative integer`);
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new CliError(CLI_EXIT.VALIDATION, `${flagName} must be a non-negative integer`);
  }

  return parsed;
}

export function parseCsvFlag(value: string | boolean | undefined): string[] | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function assignDefined<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined
): void {
  if (value !== undefined) {
    Object.assign(target, { [key]: value });
  }
}
