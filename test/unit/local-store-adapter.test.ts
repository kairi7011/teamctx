import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalContextStore } from "../../src/adapters/store/local-store.js";

function tempDirectory(): { directory: string; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "teamctx-local-store-"));

  return {
    directory,
    cleanup: () => rmSync(directory, { recursive: true, force: true })
  };
}

test("LocalContextStore reads, writes, appends, lists files, and rejects escaping paths", async (context) => {
  const { directory, cleanup } = tempDirectory();
  context.after(cleanup);
  const store = new LocalContextStore(directory);

  await store.writeText("normalized/facts.jsonl", "fact-1\n", { message: "Write facts" });
  await store.appendJsonl("audit/changes.jsonl", [{ id: "audit-1" }], {
    message: "Append audit"
  });

  assert.deepEqual(await store.readText("normalized/facts.jsonl"), {
    path: "normalized/facts.jsonl",
    content: "fact-1\n",
    revision: null
  });
  assert.equal(
    readFileSync(join(directory, "audit", "changes.jsonl"), "utf8"),
    '{"id":"audit-1"}\n'
  );
  assert.deepEqual(await store.listFiles("normalized"), ["normalized/facts.jsonl"]);
  await assert.rejects(
    () => store.writeText("../outside", "", { message: "bad" }),
    /relative path/
  );
});
