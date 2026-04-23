import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GitHubContentsStore } from "../../src/adapters/github/contents-store.js";
import { resolveGitHubToken } from "../../src/adapters/github/github-client.js";
import { normalizeGitHubRepo } from "../../src/adapters/git/repo-url.js";
import { explainItemToolAsync } from "../../src/mcp/tools/explain-item.js";
import { getContextToolAsync } from "../../src/mcp/tools/get-context.js";
import { invalidateToolAsync } from "../../src/mcp/tools/invalidate.js";
import { recordObservationVerifiedToolAsync } from "../../src/mcp/tools/record-observation.js";
import { statusToolAsync } from "../../src/mcp/tools/status.js";
import { normalizeBoundStoreAsync } from "../../src/core/normalize/normalize.js";
import { compactBoundStoreAsync } from "../../src/core/retention/compact.js";
import { initBoundStoreAsync } from "../../src/core/store/init-store.js";
import type { Binding } from "../../src/schemas/types.js";

type SmokeConfig =
  | { enabled: false; skipReason: string }
  | {
      enabled: true;
      storeRepo: string;
      storePath: string;
      branch?: string;
      keepFiles: boolean;
      workRepo: string;
    };

const smokeConfig = readSmokeConfig();

test("GitHub contents store supports the real MVP context flow", {
  skip: smokeConfig.enabled ? false : smokeConfig.skipReason,
  timeout: 180_000
}, async (context) => {
  if (!smokeConfig.enabled) {
    return;
  }

  const token = resolveGitHubToken();
  assert.ok(
    token,
    "TEAMCTX_GITHUB_SMOKE=1 requires TEAMCTX_GITHUB_TOKEN, GITHUB_TOKEN, or gh auth token"
  );

  const repoRoot = mkdtempSync(join(tmpdir(), "teamctx-github-smoke-"));
  context.after(() => rmSync(repoRoot, { recursive: true, force: true }));

  const evidenceFile = "src/smoke/teamctx-smoke.ts";
  const evidencePath = join(repoRoot, "src", "smoke");
  mkdirSync(evidencePath, { recursive: true });
  writeFileSync(join(repoRoot, evidenceFile), "export class TeamctxSmokeSymbol {}\n", "utf8");

  const store = new GitHubContentsStore({
    repository: smokeConfig.storeRepo,
    storePath: smokeConfig.storePath,
    token,
    ...(smokeConfig.branch !== undefined ? { branch: smokeConfig.branch } : {})
  });

  if (!smokeConfig.keepFiles) {
    context.after(async () => cleanupSmokeStore(store));
  }

  const services = smokeServices({
    repoRoot,
    workRepo: smokeConfig.workRepo,
    binding: {
      repo: smokeConfig.workRepo,
      root: repoRoot,
      contextStore: {
        provider: "github",
        repo: smokeConfig.storeRepo,
        path: smokeConfig.storePath
      },
      createdAt: "2026-04-23T00:00:00.000Z"
    },
    store
  });

  const initResult = await initBoundStoreAsync({ services });
  assert.equal(initResult.localStore, false);
  assert.equal(initResult.store, `${smokeConfig.storeRepo}/${smokeConfig.storePath}`);
  assert.ok(initResult.createdFiles.length + initResult.existingFiles.length >= 14);

  const eventId = `event-${randomUUID()}`;
  await recordObservationVerifiedToolAsync(
    {
      event_id: eventId,
      session_id: "github-smoke-session",
      observed_at: "2026-04-23T00:00:00.000Z",
      recorded_by: "teamctx-smoke",
      kind: "pitfall",
      text: "GitHub smoke context must keep scoped records selectable.",
      source_type: "inferred_from_code",
      evidence: [
        {
          kind: "code",
          repo: smokeConfig.workRepo,
          commit: "smoke-head",
          file: evidenceFile,
          lines: [1, 1]
        }
      ],
      scope: {
        paths: ["src/smoke/**"],
        domains: ["teamctx-smoke"],
        symbols: ["TeamctxSmokeSymbol"],
        tags: ["github-smoke"]
      }
    },
    services
  );

  const normalizeResult = await normalizeBoundStoreAsync({
    services,
    now: () => new Date("2026-04-23T00:05:00.000Z")
  });
  assert.equal(normalizeResult.rawEventsRead, 1);
  assert.equal(normalizeResult.recordsWritten, 1);
  assert.equal(normalizeResult.droppedEvents, 0);

  const payload = await getContextToolAsync(
    {
      target_files: [evidenceFile],
      symbols: ["TeamctxSmokeSymbol"],
      branch: "github-smoke",
      head_commit: "smoke-head"
    },
    services
  );

  assert.equal(payload.enabled, true);
  if (!payload.enabled) {
    throw new Error("expected enabled context payload");
  }

  const scopedItem = payload.normalized_context.scoped[0];
  assert.ok(scopedItem);
  assert.equal(scopedItem.content, "GitHub smoke context must keep scoped records selectable.");
  assert.equal(payload.relevant_episodes[0]?.source_event_ids[0], eventId);

  const explained = asRecord(await explainItemToolAsync({ item_id: scopedItem.id }, services));
  assert.equal(explained.found, true);
  assert.equal(asRecord(explained.record).id, scopedItem.id);

  const invalidated = asRecord(
    await invalidateToolAsync(
      {
        item_id: scopedItem.id,
        reason: "github smoke cleanup"
      },
      services
    )
  );
  assert.equal(invalidated.invalidated, true);
  assert.equal(invalidated.after_state, "archived");

  const status = asRecord(await statusToolAsync({}, services));
  assert.equal(status.enabled, true);
  assert.equal(status.local_store, false);
  assert.ok(asRecord(asRecord(status.summary).counts).archived_records);

  const compactResult = await compactBoundStoreAsync({
    services,
    now: () => new Date("2026-11-01T00:00:00.000Z")
  });
  assert.equal(compactResult.storeRoot, `${smokeConfig.storeRepo}/${smokeConfig.storePath}`);
});

function readSmokeConfig(): SmokeConfig {
  if (process.env.TEAMCTX_GITHUB_SMOKE !== "1") {
    return {
      enabled: false,
      skipReason: "set TEAMCTX_GITHUB_SMOKE=1 to run the real GitHub smoke test"
    };
  }

  const storeRepo = optionalEnv("TEAMCTX_GITHUB_SMOKE_STORE");

  if (!storeRepo) {
    return {
      enabled: false,
      skipReason: "TEAMCTX_GITHUB_SMOKE_STORE is required for the real GitHub smoke test"
    };
  }

  const storePath =
    optionalEnv("TEAMCTX_GITHUB_SMOKE_PATH") ??
    `contexts/teamctx-smoke/${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;

  if (
    !storePath.toLowerCase().includes("smoke") &&
    process.env.TEAMCTX_GITHUB_SMOKE_ALLOW_NON_SMOKE_PATH !== "1"
  ) {
    throw new Error(
      "TEAMCTX_GITHUB_SMOKE_PATH must include 'smoke' unless TEAMCTX_GITHUB_SMOKE_ALLOW_NON_SMOKE_PATH=1"
    );
  }

  const branch = optionalEnv("TEAMCTX_GITHUB_SMOKE_BRANCH");
  const config: SmokeConfig = {
    enabled: true,
    storeRepo: normalizeGitHubRepo(storeRepo),
    storePath,
    keepFiles: process.env.TEAMCTX_GITHUB_SMOKE_KEEP === "1",
    workRepo: normalizeGitHubRepo(
      optionalEnv("TEAMCTX_GITHUB_SMOKE_WORK_REPO") ?? "github.com/teamctx/github-smoke-work"
    )
  };

  if (branch !== undefined) {
    config.branch = branch;
  }

  return config;
}

function smokeServices(options: {
  repoRoot: string;
  workRepo: string;
  binding: Binding;
  store: GitHubContentsStore;
}) {
  return {
    getRepoRoot: () => options.repoRoot,
    getOriginRemote: () => `https://${options.workRepo}.git`,
    getCurrentBranch: () => "github-smoke",
    getHeadCommit: () => "smoke-head",
    findBinding: (repo: string) => (repo === options.workRepo ? options.binding : undefined),
    createContextStore: () => options.store
  };
}

async function cleanupSmokeStore(store: GitHubContentsStore): Promise<void> {
  const paths = new Set<string>(["project.yaml"]);

  for (const root of ["raw/events", "normalized", "audit", "indexes", "archive"]) {
    for (const path of await store.listFiles(root)) {
      paths.add(path);
    }
  }

  for (const path of [...paths].sort().reverse()) {
    await store.deleteText(path, {
      message: `Delete teamctx GitHub smoke file ${path}`
    });
  }
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name];

  return value && value.trim().length > 0 ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);

  return value as Record<string, unknown>;
}
