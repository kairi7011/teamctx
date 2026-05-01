import assert from "node:assert/strict";
import test from "node:test";
import { buildFirstRecordTemplate } from "../../src/cli/index.js";

test("buildFirstRecordTemplate returns a stable starter observation shape", () => {
  const template = buildFirstRecordTemplate();

  assert.equal(template.kind, "workflow");
  assert.equal(template.source_type, "inferred_from_code");
  assert.deepEqual(template.scope.paths, ["src/**"]);
  assert.deepEqual(template.scope.domains, ["example"]);
  assert.deepEqual(template.scope.tags, ["first-record"]);
  assert.equal(template.evidence.length, 1);
  assert.equal(template.evidence[0]?.kind, "code");
  assert.equal(template.evidence[0]?.repo, "github.com/my-org/my-repo");
  assert.equal(template.evidence[0]?.file, "src/index.ts");
  assert.equal(template.evidence[0]?.line_start, 1);
  assert.equal(template.evidence[0]?.line_end, 20);
});

test("buildFirstRecordTemplate text encourages all knowledge kinds", () => {
  const text = buildFirstRecordTemplate().text;

  for (const kind of ["workflow", "rule", "pitfall", "decision", "fact", "glossary term"]) {
    assert.ok(text.includes(kind), `template text should mention ${kind}, got: ${text}`);
  }
});
