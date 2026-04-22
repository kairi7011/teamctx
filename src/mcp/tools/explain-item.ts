import {
  explainBoundItem,
  explainBoundItemAsync,
  type ControlServices
} from "../../core/audit/control.js";
import { isNonEmptyString, isRecord } from "../../schemas/validation.js";

export function explainItemTool(rawInput: unknown, services?: ControlServices): unknown {
  const input = parseItemInput(rawInput, "explain_item");

  return explainBoundItem({
    itemId: input.itemId,
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(services !== undefined ? { services } : {})
  });
}

export async function explainItemToolAsync(
  rawInput: unknown,
  services?: ControlServices
): Promise<unknown> {
  const input = parseItemInput(rawInput, "explain_item");

  return explainBoundItemAsync({
    itemId: input.itemId,
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(services !== undefined ? { services } : {})
  });
}

export function parseItemInput(
  rawInput: unknown,
  toolName: string
): { itemId: string; cwd?: string; reason?: string } {
  if (!isRecord(rawInput)) {
    throw new Error(`${toolName} input must be an object`);
  }

  if (!isNonEmptyString(rawInput.item_id)) {
    throw new Error(`${toolName} item_id must be a non-empty string`);
  }

  const input: { itemId: string; cwd?: string; reason?: string } = {
    itemId: rawInput.item_id
  };

  if (rawInput.cwd !== undefined) {
    if (!isNonEmptyString(rawInput.cwd)) {
      throw new Error(`${toolName} cwd must be a non-empty string`);
    }
    input.cwd = rawInput.cwd;
  }

  if (rawInput.reason !== undefined) {
    if (!isNonEmptyString(rawInput.reason)) {
      throw new Error(`${toolName} reason must be a non-empty string`);
    }
    input.reason = rawInput.reason;
  }

  return input;
}
