export type ContextStoreFile = {
  path: string;
  content: string;
  revision: string | null;
};

export type ContextStoreWriteOptions = {
  message: string;
  expectedRevision?: string | null;
};

export type ContextStoreWriteResult = {
  path: string;
  revision: string | null;
  storeRevision: string | null;
};

export type ContextStoreAdapter = {
  getRevision: () => Promise<string | null>;
  readText: (path: string) => Promise<ContextStoreFile | undefined>;
  writeText: (
    path: string,
    content: string,
    options: ContextStoreWriteOptions
  ) => Promise<ContextStoreWriteResult>;
  appendJsonl: (
    path: string,
    rows: unknown[],
    options: ContextStoreWriteOptions
  ) => Promise<ContextStoreWriteResult>;
  listFiles: (path: string) => Promise<string[]>;
};

export function serializeJsonl(rows: unknown[]): string {
  return rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length > 0 ? "\n" : "");
}
