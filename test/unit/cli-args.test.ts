import assert from "node:assert/strict";
import test from "node:test";
import {
  assignDefined,
  parseCsvFlag,
  parseLimitFlag,
  parseOffsetFlag
} from "../../src/cli/cli-args.js";
import { CliError, CLI_EXIT } from "../../src/cli/cli-error.js";

test("parseLimitFlag accepts positive integers and rejects others", () => {
  assert.equal(parseLimitFlag(undefined), undefined);
  assert.equal(parseLimitFlag("10"), 10);
  assert.throws(
    () => parseLimitFlag("0"),
    (error: unknown) => isCliError(error, CLI_EXIT.VALIDATION)
  );
  assert.throws(
    () => parseLimitFlag("abc"),
    (error: unknown) => isCliError(error, CLI_EXIT.VALIDATION)
  );
  assert.throws(
    () => parseLimitFlag(true),
    (error: unknown) => isCliError(error, CLI_EXIT.VALIDATION)
  );
});

test("parseOffsetFlag accepts non-negative integers and rejects others", () => {
  assert.equal(parseOffsetFlag(undefined), undefined);
  assert.equal(parseOffsetFlag("0"), 0);
  assert.equal(parseOffsetFlag("3"), 3);
  assert.throws(
    () => parseOffsetFlag("-1"),
    (error: unknown) => isCliError(error, CLI_EXIT.VALIDATION)
  );
  assert.throws(
    () => parseOffsetFlag("abc"),
    (error: unknown) => isCliError(error, CLI_EXIT.VALIDATION)
  );
});

test("parseCsvFlag splits and trims string values", () => {
  assert.deepEqual(parseCsvFlag("a, b ,c"), ["a", "b", "c"]);
  assert.deepEqual(parseCsvFlag(["a, b", "c", "d, e"]), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(parseCsvFlag(""), []);
  assert.equal(parseCsvFlag(undefined), undefined);
  assert.throws(
    () => parseCsvFlag(true, "--domains"),
    (error: unknown) => isCliError(error, CLI_EXIT.VALIDATION)
  );
});

test("assignDefined only sets keys when value is defined", () => {
  const target: { a?: number; b?: number } = {};
  assignDefined(target, "a", 1);
  assignDefined(target, "b", undefined);
  assert.deepEqual(target, { a: 1 });
});

function isCliError(error: unknown, code: number): boolean {
  return error instanceof CliError && error.code === code;
}
