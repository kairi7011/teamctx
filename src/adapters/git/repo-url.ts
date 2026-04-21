export function normalizeGitHubRepo(remote: string): string {
  const trimmed = remote.trim();
  const scpStyleSsh = /^git@github\.com:(.+)$/i.exec(trimmed);

  if (scpStyleSsh?.[1]) {
    return `github.com/${normalizeRepoPath(scpStyleSsh[1])}`;
  }

  try {
    const url = new URL(trimmed);
    const protocol = url.protocol.toLowerCase();

    if (
      url.hostname.toLowerCase() === "github.com" &&
      (protocol === "https:" ||
        protocol === "http:" ||
        protocol === "ssh:" ||
        protocol === "git+ssh:")
    ) {
      return `github.com/${normalizeRepoPath(url.pathname)}`;
    }
  } catch {
    // Keep parsing permissive; non-URL inputs are handled below.
  }

  const bareGitHub = /^github\.com[/:](.+)$/i.exec(trimmed);

  if (bareGitHub?.[1]) {
    return `github.com/${normalizeRepoPath(bareGitHub[1])}`;
  }

  return normalizeRepoPath(trimmed);
}

export function normalizeStoreRepo(repo: string): string {
  const normalized = normalizeGitHubRepo(repo);

  if (normalized.startsWith("github.com/")) {
    return normalized;
  }

  return `github.com/${normalized}`;
}

function normalizeRepoPath(path: string): string {
  const withoutSlashes = path.trim().replace(/^\/+/, "").replace(/\/+$/, "");

  return withoutSlashes.endsWith(".git") ? withoutSlashes.slice(0, -".git".length) : withoutSlashes;
}
