import assert from "node:assert/strict";
import test from "node:test";
import {
  createDefaultProjectConfig,
  serializeProjectConfig,
  validateProjectConfig
} from "../../src/schemas/project.js";

test("createDefaultProjectConfig returns the MVP project defaults", () => {
  assert.deepEqual(createDefaultProjectConfig("github.com/team/service"), {
    format_version: 1,
    project_id: "github.com/team/service",
    normalizer_version: "0.1.0",
    retention: {
      raw_candidate_days: 30,
      audit_days: 180,
      archive_path: "archive/"
    }
  });
});

test("validateProjectConfig rejects invalid retention values", () => {
  assert.throws(
    () =>
      validateProjectConfig({
        format_version: 1,
        project_id: "github.com/team/service",
        normalizer_version: "0.1.0",
        retention: {
          raw_candidate_days: 0,
          audit_days: 180,
          archive_path: "archive/"
        }
      }),
    /retention is invalid/
  );
});

test("serializeProjectConfig writes project.yaml content", () => {
  assert.equal(
    serializeProjectConfig(createDefaultProjectConfig("github.com/team/service")),
    [
      "format_version: 1",
      'project_id: "github.com/team/service"',
      'normalizer_version: "0.1.0"',
      "retention:",
      "  raw_candidate_days: 30",
      "  audit_days: 180",
      '  archive_path: "archive/"',
      ""
    ].join("\n")
  );
});
