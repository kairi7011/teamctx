export const CORE_ERROR_KINDS = [
  "binding",
  "auth",
  "store",
  "validation",
  "internal"
] as const;

export type CoreErrorKind = (typeof CORE_ERROR_KINDS)[number];

export class CoreError extends Error {
  readonly kind: CoreErrorKind;

  constructor(kind: CoreErrorKind, message: string) {
    super(message);
    this.kind = kind;
    this.name = "CoreError";
  }
}

export function bindingMissingError(): CoreError {
  return new CoreError(
    "binding",
    "No teamctx binding found. Run: teamctx bind <store> --path <path>"
  );
}

export function itemNotFoundError(itemId: string): CoreError {
  return new CoreError("validation", `No normalized context item found: ${itemId}`);
}

export function projectConfigMissingError(): CoreError {
  return new CoreError(
    "store",
    "Context store project.yaml is missing. Run: teamctx init-store"
  );
}

export function unsupportedRemoteOperationError(operation: string): CoreError {
  return new CoreError(
    "validation",
    `${operation} currently supports context stores inside the current repository.`
  );
}
