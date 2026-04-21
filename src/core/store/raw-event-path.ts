import { join } from "node:path/posix";

export type RawEventPathInput = {
  observedAt: Date | string;
  sessionId: string;
  eventId: string;
};

export function formatRawEventPath(input: RawEventPathInput): string {
  const date = formatDate(input.observedAt);
  const sessionId = validatePathPart(input.sessionId, "sessionId");
  const eventId = validatePathPart(input.eventId, "eventId");

  return join("raw", "events", date, `${sessionId}-${eventId}.json`);
}

function formatDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error("observedAt must be a valid date");
  }

  return date.toISOString().slice(0, 10);
}

function validatePathPart(value: string, name: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(`${name} must contain only letters, numbers, dot, underscore, or dash`);
  }

  return value;
}
