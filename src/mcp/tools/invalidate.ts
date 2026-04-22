import {
  invalidateBoundItem,
  invalidateBoundItemAsync,
  type ControlServices
} from "../../core/audit/control.js";
import { parseItemInput } from "./explain-item.js";

export function invalidateTool(rawInput: unknown, services?: ControlServices): unknown {
  const input = parseItemInput(rawInput, "invalidate");

  return invalidateBoundItem({
    itemId: input.itemId,
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    ...(services !== undefined ? { services } : {})
  });
}

export async function invalidateToolAsync(
  rawInput: unknown,
  services?: ControlServices
): Promise<unknown> {
  const input = parseItemInput(rawInput, "invalidate");

  return invalidateBoundItemAsync({
    itemId: input.itemId,
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    ...(services !== undefined ? { services } : {})
  });
}
