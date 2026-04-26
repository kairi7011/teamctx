export function jsonlLines(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function parseJsonlValidated<T>(content: string, validate: (value: unknown) => T): T[] {
  return jsonlLines(content).map((line) => validate(JSON.parse(line) as unknown));
}
