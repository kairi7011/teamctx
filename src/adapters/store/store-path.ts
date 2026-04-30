export type NormalizeStorePathOptions = {
  errorMessage?: string;
};

const DEFAULT_ERROR = "Context store path must be a relative path inside the store.";

export function normalizeStorePath(path: string, options: NormalizeStorePathOptions = {}): string {
  const normalizedPath = path.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");

  if (
    normalizedPath.length === 0 ||
    normalizedPath === "." ||
    normalizedPath.split("/").includes("..")
  ) {
    throw new Error(options.errorMessage ?? DEFAULT_ERROR);
  }

  return normalizedPath;
}

export function joinStorePath(...parts: string[]): string {
  return normalizeStorePath(parts.join("/"));
}
