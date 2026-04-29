import assert from "node:assert/strict";
import test from "node:test";
import { handleJsonRpcLine } from "../../src/mcp/server.js";

type JsonObject = Record<string, unknown>;

function objectValue(value: unknown): JsonObject {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  return value as JsonObject;
}

test("MCP server handles initialize requests", async () => {
  const response = objectValue(
    await handleJsonRpcLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }))
  );
  const result = objectValue(response.result);
  const serverInfo = objectValue(result.serverInfo);

  assert.equal(response.jsonrpc, "2.0");
  assert.equal(response.id, 1);
  assert.equal(result.protocolVersion, "2024-11-05");
  assert.deepEqual(result.capabilities, { tools: {} });
  assert.equal(serverInfo.name, "teamctx");
});

test("MCP server lists declared tools with input schemas", async () => {
  const response = objectValue(
    await handleJsonRpcLine(JSON.stringify({ jsonrpc: "2.0", id: "tools", method: "tools/list" }))
  );
  const result = objectValue(response.result);
  const tools = result.tools;

  assert.ok(Array.isArray(tools));
  assert.ok(tools.length > 0);
  assert.ok(
    tools.some((tool) => {
      const item = objectValue(tool);
      return item.name === "teamctx.get_context" && objectValue(item.inputSchema).type === "object";
    })
  );
});

test("MCP server ignores initialized notifications", async () => {
  assert.equal(
    await handleJsonRpcLine(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
    ),
    undefined
  );
});

test("MCP server returns structured parse errors", async () => {
  const response = objectValue(await handleJsonRpcLine("{"));
  const error = objectValue(response.error);
  const data = objectValue(error.data);

  assert.equal(error.code, -32700);
  assert.equal(data.kind, "internal");
});

test("MCP server returns structured validation errors for unsupported methods", async () => {
  const response = objectValue(
    await handleJsonRpcLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "unknown/method" }))
  );
  const error = objectValue(response.error);
  const data = objectValue(error.data);

  assert.equal(response.id, 2);
  assert.equal(error.code, -32603);
  assert.equal(data.kind, "validation");
  assert.equal(data.message, "Unsupported MCP method: unknown/method");
});

test("MCP server returns structured validation errors for invalid tool calls", async () => {
  const response = objectValue(
    await handleJsonRpcLine(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call" }))
  );
  const error = objectValue(response.error);
  const data = objectValue(error.data);

  assert.equal(response.id, 3);
  assert.equal(error.code, -32603);
  assert.equal(data.kind, "validation");
  assert.equal(data.message, "tools/call params must include a tool name");
});
