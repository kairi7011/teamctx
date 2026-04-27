import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "../../adapters/git/local-git.js";
import type { NormalizedRecord } from "../../schemas/normalized-record.js";

export function staleReason(record: NormalizedRecord, repoRoot: string): string | undefined {
  const fileEvidence = record.evidence.flatMap((evidence) =>
    evidence.file === undefined ? [] : [evidence.file]
  );

  if (fileEvidence.length === 0) {
    return undefined;
  }

  const missingEvidence = fileEvidence.filter((file) => !existsSync(join(repoRoot, file)));

  if (missingEvidence.length === fileEvidence.length) {
    const renamed = renamedEvidencePaths(repoRoot, missingEvidence);

    return renamed.length > 0
      ? `file-backed evidence paths were renamed: ${renamed.join(", ")}`
      : "all file-backed evidence paths are missing";
  }

  if (symbolsAreMissingFromEvidence(record, repoRoot, fileEvidence)) {
    return "scoped symbols are no longer referenced in file-backed evidence";
  }

  return undefined;
}

function renamedEvidencePaths(repoRoot: string, missingEvidence: string[]): string[] {
  const renames = gitRenames(repoRoot);

  return missingEvidence.flatMap((file) => {
    const renamedTo = renames.get(normalizeRepoPath(file));

    return renamedTo === undefined ? [] : [`${file} -> ${renamedTo}`];
  });
}

function symbolsAreMissingFromEvidence(
  record: NormalizedRecord,
  repoRoot: string,
  fileEvidence: string[]
): boolean {
  const symbols = uniqueSorted(record.scope.symbols.map((symbol) => symbol.trim())).filter(
    (symbol) => symbol.length > 0
  );
  const existingFiles = uniqueSorted(fileEvidence).filter((file) =>
    existsSync(join(repoRoot, file))
  );

  if (symbols.length === 0 || existingFiles.length === 0) {
    return false;
  }

  const contents = existingFiles.map((file) => readFileSync(join(repoRoot, file), "utf8"));

  return !symbols.some((symbol) => contents.some((content) => content.includes(symbol)));
}

function gitRenames(repoRoot: string): Map<string, string> {
  try {
    const output = git(["status", "--porcelain=v1", "--renames"], repoRoot);
    const renames = new Map<string, string>();

    for (const line of output.split("\n")) {
      const detail = line.slice(3);
      const separator = " -> ";
      const separatorIndex = detail.indexOf(separator);

      if (separatorIndex === -1) {
        continue;
      }

      renames.set(
        normalizeRepoPath(detail.slice(0, separatorIndex)),
        normalizeRepoPath(detail.slice(separatorIndex + separator.length))
      );
    }

    return renames;
  } catch {
    return new Map();
  }
}

function normalizeRepoPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
