import assert from "node:assert/strict";
import test from "node:test";
import { CLI_EXIT, mapErrorToExitCode } from "../../src/cli/cli-error.js";
import {
  CoreError,
  bindingMissingError,
  itemNotFoundError,
  projectConfigMissingError,
  unsupportedRemoteOperationError
} from "../../src/core/errors.js";
import { structuredMcpError } from "../../src/mcp/errors.js";

test("CoreError carries a typed kind alongside the message", () => {
  const error = new CoreError("validation", "details");

  assert.equal(error.kind, "validation");
  assert.equal(error.message, "details");
  assert.equal(error.name, "CoreError");
});

test("bindingMissingError uses the binding kind", () => {
  const error = bindingMissingError();

  assert.equal(error.kind, "binding");
  assert.match(error.message, /^No teamctx binding found/);
});

test("itemNotFoundError formats the missing id and uses validation kind", () => {
  const error = itemNotFoundError("pitfall-x");

  assert.equal(error.kind, "validation");
  assert.equal(error.message, "No normalized context item found: pitfall-x");
});

test("projectConfigMissingError uses the store kind", () => {
  const error = projectConfigMissingError();

  assert.equal(error.kind, "store");
  assert.match(error.message, /project\.yaml is missing/);
});

test("unsupportedRemoteOperationError uses the validation kind", () => {
  const error = unsupportedRemoteOperationError("normalize");

  assert.equal(error.kind, "validation");
  assert.match(error.message, /^normalize currently supports/);
});

test("mapErrorToExitCode prefers CoreError kind over message regex", () => {
  assert.equal(mapErrorToExitCode(bindingMissingError()), CLI_EXIT.BINDING);
  assert.equal(mapErrorToExitCode(itemNotFoundError("x")), CLI_EXIT.VALIDATION);
  assert.equal(mapErrorToExitCode(projectConfigMissingError()), CLI_EXIT.STORE);
  assert.equal(mapErrorToExitCode(new CoreError("auth", "token rejected")), CLI_EXIT.AUTH);
  assert.equal(
    mapErrorToExitCode(new CoreError("internal", "should not happen")),
    CLI_EXIT.UNEXPECTED
  );
});

test("structuredMcpError prefers CoreError kind over message regex", () => {
  assert.deepEqual(structuredMcpError(bindingMissingError()), {
    kind: "binding",
    message: "No teamctx binding found. Run: teamctx bind <store> --path <path>"
  });
  assert.deepEqual(structuredMcpError(itemNotFoundError("x")), {
    kind: "validation",
    message: "No normalized context item found: x"
  });
  assert.deepEqual(structuredMcpError(projectConfigMissingError()), {
    kind: "store",
    message: "Context store project.yaml is missing. Run: teamctx init-store"
  });
});
