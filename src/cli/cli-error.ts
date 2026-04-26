export const CLI_EXIT = {
  SUCCESS: 0,
  UNEXPECTED: 1,
  USAGE: 2,
  BINDING: 3,
  AUTH: 4,
  VALIDATION: 5,
  STORE: 6
} as const;

export type CliExitCode = (typeof CLI_EXIT)[keyof typeof CLI_EXIT];

export class CliError extends Error {
  readonly code: CliExitCode;

  constructor(code: CliExitCode, message: string) {
    super(message);
    this.code = code;
    this.name = "CliError";
  }
}

export function mapErrorToExitCode(error: unknown): CliExitCode {
  if (error instanceof CliError) {
    return error.code;
  }

  const message = error instanceof Error ? error.message : String(error);

  if (/^No teamctx binding found/i.test(message)) {
    return CLI_EXIT.BINDING;
  }
  if (/GitHub API request failed: 40[13]/.test(message)) {
    return CLI_EXIT.AUTH;
  }
  if (/^GitHub API request failed/.test(message)) {
    return CLI_EXIT.STORE;
  }
  if (/(is invalid|must be|schema_version)/i.test(message)) {
    return CLI_EXIT.VALIDATION;
  }

  return CLI_EXIT.UNEXPECTED;
}
