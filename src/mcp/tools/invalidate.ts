import { invalidateBoundItem, type ControlServices } from "../../core/audit/control.js";
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
