export type McpErrorKind = "validation" | "binding" | "auth" | "store" | "internal";

export type StructuredMcpError = {
  kind: McpErrorKind;
  message: string;
};

export function structuredMcpError(error: unknown): StructuredMcpError {
  const message = error instanceof Error ? error.message : String(error);

  return {
    kind: classifyMcpError(message),
    message
  };
}

function classifyMcpError(message: string): McpErrorKind {
  const normalized = message.toLowerCase();

  if (
    normalized.includes("binding") ||
    normalized.includes("unbound") ||
    normalized.includes("no git repository")
  ) {
    return "binding";
  }

  if (
    normalized.includes("auth") ||
    normalized.includes("token") ||
    normalized.includes("unauthorized") ||
    normalized.includes("forbidden")
  ) {
    return "auth";
  }

  if (
    normalized.includes("github") ||
    normalized.includes("store") ||
    normalized.includes("revision") ||
    normalized.includes("write") ||
    normalized.includes("read")
  ) {
    return "store";
  }

  if (
    normalized.includes("must be") ||
    normalized.includes("is invalid") ||
    normalized.includes("missing") ||
    normalized.includes("unsupported mcp method") ||
    normalized.includes("tool is not implemented") ||
    normalized.includes("tools/call params")
  ) {
    return "validation";
  }

  return "internal";
}
