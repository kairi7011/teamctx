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
