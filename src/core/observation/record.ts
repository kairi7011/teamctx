import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { ContextStoreAdapter } from "../../adapters/store/context-store.js";
import { getOriginRemote, getRepoRoot } from "../../adapters/git/local-git.js";
import { normalizeGitHubRepo } from "../../adapters/git/repo-url.js";
import { findBinding } from "../binding/local-bindings.js";
import { resolveStoreRoot } from "../store/layout.js";
import {
  createContextStoreForBinding,
  type ContextStoreFactoryServices
} from "../store/bound-store.js";
import { formatRawEventPath } from "../store/raw-event-path.js";
import { scanRawObservation, type SensitiveFinding } from "../policy/redaction-policy.js";
import type { RawObservation } from "../../schemas/observation.js";
import type { Binding } from "../../schemas/types.js";

export type RawObservationWriteResult = {
  path: string;
  relativePath: string;
  findings: SensitiveFinding[];
};

export type RecordObservationServices = ContextStoreFactoryServices & {
  getRepoRoot: (cwd?: string) => string;
  getOriginRemote: (cwd?: string) => string;
  findBinding: (repo: string) => Binding | undefined;
};

export type RecordObservationOptions = {
  observation: RawObservation;
  cwd?: string;
  services?: RecordObservationServices;
};

const defaultServices: RecordObservationServices = {
  getRepoRoot,
  getOriginRemote,
  findBinding
};

export class SensitiveContentError extends Error {
  readonly findings: SensitiveFinding[];

  constructor(findings: SensitiveFinding[]) {
    super("Raw observation contains blocked sensitive content.");
    this.findings = findings;
  }
}

export function recordRawObservation(options: RecordObservationOptions): RawObservationWriteResult {
  const services = options.services ?? defaultServices;
  const root = services.getRepoRoot(options.cwd);
  const repo = normalizeGitHubRepo(services.getOriginRemote(root));
  const binding = services.findBinding(repo);

  if (!binding) {
    throw new Error("No teamctx binding found. Run: teamctx bind <store> --path <path>");
  }

  return writeRawObservationToBinding({
    repo,
    repoRoot: root,
    binding,
    observation: options.observation
  });
}

export async function recordRawObservationAsync(
  options: RecordObservationOptions
): Promise<RawObservationWriteResult> {
  const services = options.services ?? defaultServices;
  const root = services.getRepoRoot(options.cwd);
  const repo = normalizeGitHubRepo(services.getOriginRemote(root));
  const binding = services.findBinding(repo);

  if (!binding) {
    throw new Error("No teamctx binding found. Run: teamctx bind <store> --path <path>");
  }

  if (binding.contextStore.repo === repo) {
    return writeRawObservationToBinding({
      repo,
      repoRoot: root,
      binding,
      observation: options.observation
    });
  }

  return writeRawObservationToContextStore({
    repo,
    repoRoot: root,
    binding,
    observation: options.observation,
    store:
      services.createContextStore?.({ repo, repoRoot: root, binding }) ??
      createContextStoreForBinding({ repo, repoRoot: root, binding })
  });
}

export function writeRawObservationToBinding(options: {
  repo: string;
  repoRoot: string;
  binding: Binding;
  observation: RawObservation;
}): RawObservationWriteResult {
  if (options.binding.contextStore.repo !== options.repo) {
    throw new Error(
      "record_observation currently supports context stores inside the current repository."
    );
  }

  const sensitiveReport = scanRawObservation(options.observation);

  if (sensitiveReport.status === "blocked") {
    throw new SensitiveContentError(sensitiveReport.findings);
  }

  const storeRoot = resolveStoreRoot(options.repoRoot, options.binding.contextStore.path);
  const relativePath = formatRawEventPath({
    observedAt: options.observation.observed_at,
    sessionId: options.observation.session_id,
    eventId: options.observation.event_id
  });
  const path = resolveInside(storeRoot, relativePath);

  if (existsSync(path)) {
    throw new Error(`Raw observation event already exists: ${relativePath}`);
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(options.observation, null, 2)}\n`, "utf8");

  return {
    path,
    relativePath,
    findings: sensitiveReport.findings
  };
}

export async function writeRawObservationToContextStore(options: {
  repo: string;
  repoRoot: string;
  binding: Binding;
  observation: RawObservation;
  store: ContextStoreAdapter;
}): Promise<RawObservationWriteResult> {
  const sensitiveReport = scanRawObservation(options.observation);

  if (sensitiveReport.status === "blocked") {
    throw new SensitiveContentError(sensitiveReport.findings);
  }

  const relativePath = formatRawEventPath({
    observedAt: options.observation.observed_at,
    sessionId: options.observation.session_id,
    eventId: options.observation.event_id
  });
  const existing = await options.store.readText(relativePath);

  if (existing) {
    throw new Error(`Raw observation event already exists: ${relativePath}`);
  }

  await options.store.writeText(relativePath, `${JSON.stringify(options.observation, null, 2)}\n`, {
    message: `Record teamctx raw observation ${options.observation.event_id}`,
    expectedRevision: null
  });

  return {
    path: `${options.binding.contextStore.repo}/${options.binding.contextStore.path}/${relativePath}`,
    relativePath,
    findings: sensitiveReport.findings
  };
}

function resolveInside(root: string, relativePath: string): string {
  const path = resolve(root, ...relativePath.split("/"));
  const relativePathFromRoot = relative(root, path);

  if (
    relativePathFromRoot.startsWith("..") ||
    relativePathFromRoot === "" ||
    isAbsolute(relativePathFromRoot)
  ) {
    throw new Error("Resolved raw observation path must stay inside the context store.");
  }

  return path;
}
