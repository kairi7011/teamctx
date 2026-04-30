#!/usr/bin/env node

import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import { getContextToolAsync } from "./tools/get-context.js";
import { explainEpisodeToolAsync } from "./tools/explain-episode.js";
import { explainItemToolAsync } from "./tools/explain-item.js";
import { invalidateToolAsync } from "./tools/invalidate.js";
import { normalizeToolAsync } from "./tools/normalize.js";
import {
  recordObservationCandidateToolAsync,
  recordObservationVerifiedToolAsync
} from "./tools/record-observation.js";
import { statusToolAsync } from "./tools/status.js";
import { toolDefinitions } from "./tools/definitions.js";
import { structuredMcpError } from "./errors.js";

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
};

type ToolCallParams = {
  name: string;
  arguments?: unknown;
};

const serverInfo = {
  name: "teamctx",
  version: "0.1.0"
};

export async function handleJsonRpcLine(line: string): Promise<unknown | undefined> {
  if (line.trim().length === 0) {
    return undefined;
  }

  try {
    const request = JSON.parse(line) as JsonRpcRequest;
    return await handleRequest(request);
  } catch (error) {
    const structured = structuredMcpError(error);

    return {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32700,
        message: structured.message,
        data: structured
      }
    };
  }
}

function startServer(): void {
  const lineReader = createInterface({ input: stdin });

  lineReader.on("line", (line) => {
    void handleJsonRpcLine(line).then((response) => {
      if (response !== undefined) {
        writeMessage(response);
      }
    });
  });
}

async function handleRequest(request: JsonRpcRequest): Promise<unknown> {
  if (request.method === "notifications/initialized") {
    return undefined;
  }

  try {
    return {
      jsonrpc: "2.0",
      id: request.id ?? null,
      result: await dispatchRequest(request)
    };
  } catch (error) {
    const structured = structuredMcpError(error);

    return {
      jsonrpc: "2.0",
      id: request.id ?? null,
      error: {
        code: -32603,
        message: structured.message,
        data: structured
      }
    };
  }
}

async function dispatchRequest(request: JsonRpcRequest): Promise<unknown> {
  switch (request.method) {
    case "initialize":
      return {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo
      };
    case "tools/list":
      return {
        tools: toolDefinitions
      };
    case "tools/call":
      return callTool(request.params);
    default:
      throw new Error(`Unsupported MCP method: ${request.method}`);
  }
}

async function callTool(params: unknown): Promise<unknown> {
  if (!isToolCallParams(params)) {
    throw new Error("tools/call params must include a tool name");
  }

  switch (params.name) {
    case "teamctx.get_context":
      return toolResult(await getContextToolAsync(params.arguments));
    case "teamctx.record_observation_candidate":
      return toolResult(await recordObservationCandidateToolAsync(params.arguments));
    case "teamctx.record_observation_verified":
      return toolResult(await recordObservationVerifiedToolAsync(params.arguments));
    case "teamctx.normalize":
      return toolResult(await normalizeToolAsync(params.arguments));
    case "teamctx.status":
      return toolResult(await statusToolAsync(params.arguments));
    case "teamctx.explain_item":
      return toolResult(await explainItemToolAsync(params.arguments));
    case "teamctx.explain_episode":
      return toolResult(await explainEpisodeToolAsync(params.arguments));
    case "teamctx.invalidate":
      return toolResult(await invalidateToolAsync(params.arguments));
    default:
      throw new Error(`Tool is not implemented yet: ${params.name}`);
  }
}

function toolResult(value: unknown): unknown {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

function isToolCallParams(value: unknown): value is ToolCallParams {
  return (
    typeof value === "object" && value !== null && "name" in value && typeof value.name === "string"
  );
}

function writeMessage(value: unknown): void {
  stdout.write(`${JSON.stringify(value)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  startServer();
}
