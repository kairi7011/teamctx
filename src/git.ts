import { execFileSync } from "node:child_process";

export function git(args: string[], cwd = process.cwd()): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

export function getRepoRoot(cwd = process.cwd()): string {
  return git(["rev-parse", "--show-toplevel"], cwd);
}

export function getOriginRemote(cwd = process.cwd()): string {
  return git(["remote", "get-url", "origin"], cwd);
}

export function getCurrentBranch(cwd = process.cwd()): string {
  return git(["branch", "--show-current"], cwd);
}

export function getHeadCommit(cwd = process.cwd()): string {
  return git(["rev-parse", "HEAD"], cwd);
}

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
