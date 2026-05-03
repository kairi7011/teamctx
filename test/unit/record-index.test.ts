import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRecordIndexes,
  hasTextLookupSelector,
  matchesPath,
  selectIndexedRecordIds,
  validatePathIndex,
  validateSymbolIndex,
  validateTextIndex
} from "../../src/core/indexes/record-index.js";
import type { NormalizedRecord } from "../../src/schemas/normalized-record.js";

test("buildRecordIndexes indexes paths domains tags kinds states and symbols", () => {
  const indexes = buildRecordIndexes([record("pitfall-auth")], "2026-04-22T11:00:00.000Z");

  assert.deepEqual(indexes.pathIndex.paths["src/auth/**"], ["pitfall-auth"]);
  assert.deepEqual(indexes.pathIndex.domains.auth, ["pitfall-auth"]);
  assert.deepEqual(indexes.pathIndex.tags["request-lifecycle"], ["pitfall-auth"]);
  assert.deepEqual(indexes.pathIndex.kinds.pitfall, ["pitfall-auth"]);
  assert.deepEqual(indexes.pathIndex.states.active, ["pitfall-auth"]);
  assert.deepEqual(indexes.symbolIndex.symbols.AuthMiddleware, ["pitfall-auth"]);
  assert.deepEqual(indexes.textIndex.tokens.pitfall, ["pitfall-auth"]);
  assert.deepEqual(indexes.textIndex.tokens.auth, ["pitfall-auth"]);
});

test("selectIndexedRecordIds retrieves records by file domain symbol tag and text query", () => {
  const indexes = buildRecordIndexes(
    [
      record("pitfall-auth"),
      record("decision-billing", {
        paths: ["src/billing/**"],
        domains: ["billing"],
        symbols: ["InvoiceService"],
        tags: ["payments"]
      })
    ],
    "2026-04-22T11:00:00.000Z"
  );

  assert.deepEqual(
    [...selectIndexedRecordIds(indexes, { target_files: ["src/auth/middleware.ts"] })],
    ["pitfall-auth"]
  );
  assert.deepEqual(
    [...selectIndexedRecordIds(indexes, { domains: ["BILLING"] })],
    ["decision-billing"]
  );
  assert.deepEqual(
    [...selectIndexedRecordIds(indexes, { symbols: ["InvoiceService"] })],
    ["decision-billing"]
  );
  assert.deepEqual(
    [...selectIndexedRecordIds(indexes, { tags: ["request-lifecycle"] })],
    ["pitfall-auth"]
  );
  assert.deepEqual(
    [...selectIndexedRecordIds(indexes, { query: "decision billing" })],
    ["decision-billing"]
  );
});

test("selectIndexedRecordIds treats domains and tags as weak selectors when strong selectors exist", () => {
  const indexes = buildRecordIndexes(
    [
      record("pitfall-auth"),
      record("decision-billing", {
        paths: ["src/billing/**"],
        domains: ["billing"],
        symbols: ["InvoiceService"],
        tags: ["payments"]
      }),
      record("pitfall-payments", {
        paths: ["src/payments/**"],
        domains: ["payments"],
        symbols: [],
        tags: ["request-lifecycle"]
      })
    ],
    "2026-04-22T11:00:00.000Z"
  );

  assert.deepEqual(
    [
      ...selectIndexedRecordIds(indexes, {
        target_files: ["src/auth/middleware.ts"],
        domains: ["payments"],
        tags: ["request-lifecycle"]
      })
    ],
    ["pitfall-auth"]
  );

  assert.deepEqual(
    [
      ...selectIndexedRecordIds(indexes, {
        symbols: ["InvoiceService"],
        tags: ["request-lifecycle"]
      })
    ],
    ["decision-billing"]
  );

  assert.deepEqual(
    [
      ...selectIndexedRecordIds(indexes, { domains: ["payments"], tags: ["request-lifecycle"] })
    ].sort(),
    ["pitfall-auth", "pitfall-payments"]
  );
});

test("hasTextLookupSelector uses normalized query tokens", () => {
  assert.equal(hasTextLookupSelector("cache tokens"), true);
  assert.equal(hasTextLookupSelector("the and of"), false);
  assert.equal(hasTextLookupSelector(" , "), false);
  assert.equal(hasTextLookupSelector(undefined), false);
});

test("matchesPath supports exact paths and glob scopes", () => {
  assert.equal(matchesPath("src/auth/middleware.ts", "src/auth/middleware.ts"), true);
  assert.equal(matchesPath("src/auth/**", "src/auth/middleware.ts"), true);
  assert.equal(matchesPath("src/*/middleware.ts", "src/auth/middleware.ts"), true);
  assert.equal(matchesPath("src/billing/**", "src/auth/middleware.ts"), false);
});

test("validatePathIndex and validateSymbolIndex reject legacy empty objects", () => {
  assert.throws(() => validatePathIndex({}), /schema_version/);
  assert.throws(() => validateSymbolIndex({}), /schema_version/);
  assert.throws(() => validateTextIndex({}), /schema_version/);
});

function record(id: string, scope: NormalizedRecord["scope"] = defaultScope()): NormalizedRecord {
  return {
    id,
    schema_version: 1,
    normalizer_version: "0.1.0",
    kind: id.startsWith("decision") ? "decision" : "pitfall",
    state: "active",
    text: `${id} text`,
    scope,
    evidence: [
      {
        kind: "code",
        repo: "github.com/team/service",
        commit: "abc123",
        file: "src/auth/middleware.ts"
      }
    ],
    provenance: {
      recorded_by: "codex",
      session_id: "session-1",
      observed_at: "2026-04-22T10:00:00.000Z"
    },
    confidence_level: "medium",
    confidence_score: 0.65,
    last_verified_at: "2026-04-22T11:00:00.000Z",
    supersedes: [],
    conflicts_with: []
  };
}

function defaultScope(): NormalizedRecord["scope"] {
  return {
    paths: ["src/auth/**"],
    domains: ["auth"],
    symbols: ["AuthMiddleware"],
    tags: ["request-lifecycle"]
  };
}
