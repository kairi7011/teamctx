import type { Evidence } from "../../schemas/evidence.js";
import type { ConfidenceLevel } from "../../schemas/normalized-record.js";

export type Confidence = {
  level: ConfidenceLevel;
  score: number;
};

export function calculateConfidence(evidence: Evidence[]): Confidence {
  const kinds = new Set(evidence.map((item) => item.kind));

  if (kinds.has("code") && kinds.has("test")) {
    return { level: "high", score: 0.85 };
  }

  if (kinds.has("code") || kinds.has("diff") || kinds.has("test") || kinds.has("config")) {
    return { level: "medium", score: 0.65 };
  }

  if (kinds.has("docs") || kinds.has("issue") || kinds.has("pr")) {
    return { level: "medium", score: 0.55 };
  }

  return { level: "low", score: 0.35 };
}
