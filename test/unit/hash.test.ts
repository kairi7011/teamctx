import assert from "node:assert/strict";
import test from "node:test";
import { sha256Hex } from "../../src/core/store/hash.js";

test("sha256Hex returns the lowercase hex digest", () => {
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Hex("teamctx"), sha256Hex("teamctx"), "hash output must be deterministic");
  assert.match(sha256Hex("any input"), /^[0-9a-f]{64}$/);
});

test("sha256Hex distinguishes different inputs", () => {
  assert.notEqual(sha256Hex("a"), sha256Hex("b"));
});
