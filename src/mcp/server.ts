#!/usr/bin/env node

import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import { getContextTool } from "./tools/get-context.js";
import {
  recordObservationCandidateTool,
  recordObservationVerifiedTool
} from "./tools/record-observation.js";
import { statusTool } from "./tools/status.js";
import { toolDefinitions } from "./tools/definitions.js";

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

const inputSchemas: Record<string, Record<string, unknown>> = {
  "teamctx.get_context": {
    type: "object",
    properties: {
      cwd: { type: "string" },
      target_files: { type: "array", items: { type: "string" } },
      changed_files: { type: "array", items: { type: "string" } },
      branch: { type: "string" },
      head_commit: { type: "string" }
    },
    additionalProperties: false
  },
  "teamctx.status": {
    type: "object",
    properties: {
      cwd: { type: "string" }
    },
    additionalProperties: false
  },
  "teamctx.record_observation_candidate": {
    type: "object",
    properties: {
      cwd: { type: "string" },
      event_id: { type: "string" },
      session_id: { type: "string" },
      observed_at: { type: "string" },
      recorded_by: { type: "string" },
      kind: { type: "string" },
      text: { type: "string" },
      source_type: { type: "string" },
      evidence: { type: "array" },
      scope: { type: "object" },
      supersedes: { type: "array", items: { type: "string" } }
    },
    required: ["kind", "text", "source_type"],
    additionalProperties: false
  },
  "teamctx.record_observation_verified": {
    type: "object",
    properties: {
      cwd: { type: "string" },
      event_id: { type: "string" },
      session_id: { type: "string" },
      observed_at: { type: "string" },
      recorded_by: { type: "string" },
      kind: { type: "string" },
      text: { type: "string" },
      source_type: { type: "string" },
      evidence: { type: "array" },
      scope: { type: "object" },
      supersedes: { type: "array", items: { type: "string" } }
    },
    required: ["kind", "text", "source_type", "evidence"],
    additionalProperties: false
  }
};

const lineReader = createInterface({ input: stdin });

lineReader.on("line", (line) => {
  if (line.trim().length === 0) {
    return;
  }

  handleLine(line);
});

function handleLine(line: string): void {
  try {
    const request = JSON.parse(line) as JsonRpcRequest;
    const response = handleRequest(request);

    if (response !== undefined) {
      writeMessage(response);
    }
  } catch (error) {
    writeMessage({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32700,
        message: error instanceof Error ? error.message : String(error)
      }
    });
  }
}

function handleRequest(request: JsonRpcRequest): unknown {
  if (request.method === "notifications/initialized") {
    return undefined;
  }

  try {
    return {
      jsonrpc: "2.0",
      id: request.id ?? null,
      result: dispatchRequest(request)
    };
  } catch (error) {
    return {
      jsonrpc: "2.0",
      id: request.id ?? null,
      error: {
        code: -32603,
        message: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

function dispatchRequest(request: JsonRpcRequest): unknown {
  switch (request.method) {
    case "initialize":
      return {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo
      };
    case "tools/list":
      return {
        tools: toolDefinitions.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: inputSchemas[tool.name] ?? { type: "object", properties: {} }
        }))
      };
    case "tools/call":
      return callTool(request.params);
    default:
      throw new Error(`Unsupported MCP method: ${request.method}`);
  }
}

function callTool(params: unknown): unknown {
  if (!isToolCallParams(params)) {
    throw new Error("tools/call params must include a tool name");
  }

  switch (params.name) {
    case "teamctx.get_context":
      return toolResult(getContextTool(params.arguments));
    case "teamctx.record_observation_candidate":
      return toolResult(recordObservationCandidateTool(params.arguments));
    case "teamctx.record_observation_verified":
      return toolResult(recordObservationVerifiedTool(params.arguments));
    case "teamctx.status":
      return toolResult(statusTool(params.arguments));
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
