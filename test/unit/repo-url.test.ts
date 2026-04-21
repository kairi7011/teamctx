import assert from "node:assert/strict";
import test from "node:test";
import { normalizeGitHubRepo, normalizeStoreRepo } from "../../src/adapters/git/repo-url.js";

test("normalizeGitHubRepo canonicalizes common GitHub remote forms", () => {
  const cases: Array<{ input: string; expected: string }> = [
    { input: "git@github.com:owner/repo.git", expected: "github.com/owner/repo" },
    { input: "https://github.com/owner/repo.git", expected: "github.com/owner/repo" },
    { input: "http://github.com/owner/repo.git", expected: "github.com/owner/repo" },
    { input: "ssh://git@github.com/owner/repo.git", expected: "github.com/owner/repo" },
    { input: "git+ssh://git@github.com/owner/repo.git", expected: "github.com/owner/repo" },
    { input: "github.com/owner/repo.git", expected: "github.com/owner/repo" },
    { input: " github.com/owner/repo/ ", expected: "github.com/owner/repo" }
  ];

  for (const { input, expected } of cases) {
    assert.equal(normalizeGitHubRepo(input), expected);
  }
});

test("normalizeGitHubRepo leaves non-GitHub repo identifiers as normalized paths", () => {
  assert.equal(normalizeGitHubRepo("owner/repo.git"), "owner/repo");
});

test("normalizeStoreRepo defaults bare owner/repo stores to GitHub", () => {
  assert.equal(normalizeStoreRepo("owner/repo.git"), "github.com/owner/repo");
  assert.equal(normalizeStoreRepo("https://github.com/owner/repo.git"), "github.com/owner/repo");
});
