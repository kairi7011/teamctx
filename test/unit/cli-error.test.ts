import assert from "node:assert/strict";
import test from "node:test";
import { CliError, CLI_EXIT, mapErrorToExitCode } from "../../src/cli/cli-error.js";

test("mapErrorToExitCode honors CliError code", () => {
  assert.equal(mapErrorToExitCode(new CliError(CLI_EXIT.USAGE, "missing arg")), CLI_EXIT.USAGE);
  assert.equal(
    mapErrorToExitCode(new CliError(CLI_EXIT.VALIDATION, "bad payload")),
    CLI_EXIT.VALIDATION
  );
});

test("mapErrorToExitCode classifies binding errors", () => {
  assert.equal(
    mapErrorToExitCode(new Error("No teamctx binding found. Run: teamctx bind")),
    CLI_EXIT.BINDING
  );
});

test("mapErrorToExitCode classifies GitHub auth errors", () => {
  assert.equal(
    mapErrorToExitCode(new Error("GitHub API request failed: 401 Unauthorized")),
    CLI_EXIT.AUTH
  );
  assert.equal(
    mapErrorToExitCode(new Error("GitHub API request failed: 403 Forbidden")),
    CLI_EXIT.AUTH
  );
});

test("mapErrorToExitCode classifies other GitHub errors as store errors", () => {
  assert.equal(
    mapErrorToExitCode(new Error("GitHub API request failed: 500 Internal Server Error")),
    CLI_EXIT.STORE
  );
});

test("mapErrorToExitCode classifies validation messages", () => {
  assert.equal(mapErrorToExitCode(new Error("list kind is invalid: nope")), CLI_EXIT.VALIDATION);
});

test("mapErrorToExitCode falls back to UNEXPECTED", () => {
  assert.equal(mapErrorToExitCode(new Error("something else")), CLI_EXIT.UNEXPECTED);
  assert.equal(mapErrorToExitCode("string error"), CLI_EXIT.UNEXPECTED);
});
