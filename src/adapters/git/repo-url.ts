export function normalizeGitHubRepo(remote: string): string {
  const trimmed = remote.trim().replace(/\.git$/, "");

  if (trimmed.startsWith("git@github.com:")) {
    return `github.com/${trimmed.slice("git@github.com:".length)}`;
  }

  if (trimmed.startsWith("https://github.com/")) {
    return `github.com/${trimmed.slice("https://github.com/".length)}`;
  }

  if (trimmed.startsWith("http://github.com/")) {
    return `github.com/${trimmed.slice("http://github.com/".length)}`;
  }

  if (trimmed.startsWith("github.com/")) {
    return trimmed;
  }

  return trimmed;
}

export function normalizeStoreRepo(repo: string): string {
  const normalized = normalizeGitHubRepo(repo);

  if (normalized.startsWith("github.com/")) {
    return normalized;
  }

  return `github.com/${normalized}`;
}
