import type { EnabledContextPayload } from "../../schemas/context-payload.js";
import { isRecord } from "../../schemas/validation.js";
import { CoreError } from "../errors.js";

export const WRITE_POLICY: EnabledContextPayload["write_policy"] = {
  record_observation_candidate: "allowed",
  record_observation_verified: "allowed_with_evidence",
  invalidate: "human_only",
  docs_evidence: "allowed_with_doc_role"
};

export function assertHumanInvalidateConfirmation(rawInput: unknown, toolName: string): void {
  if (!isRecord(rawInput) || rawInput.human_confirmed !== true) {
    throw new CoreError(
      "validation",
      `${toolName} requires human_confirmed: true because write_policy.invalidate is human_only`
    );
  }
}
