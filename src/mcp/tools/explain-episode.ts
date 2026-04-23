import {
  explainBoundEpisodeAsync,
  type ExplainEpisodeServices
} from "../../core/episodes/explain.js";
import { isNonEmptyString, isRecord } from "../../schemas/validation.js";

export async function explainEpisodeToolAsync(
  rawInput: unknown,
  services?: ExplainEpisodeServices
): Promise<unknown> {
  const input = parseEpisodeInput(rawInput);

  return explainBoundEpisodeAsync({
    episodeId: input.episodeId,
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(services !== undefined ? { services } : {})
  });
}

function parseEpisodeInput(rawInput: unknown): { episodeId: string; cwd?: string } {
  if (!isRecord(rawInput)) {
    throw new Error("explain_episode input must be an object");
  }

  if (!isNonEmptyString(rawInput.episode_id)) {
    throw new Error("explain_episode episode_id must be a non-empty string");
  }

  const input: { episodeId: string; cwd?: string } = {
    episodeId: rawInput.episode_id
  };

  if (rawInput.cwd !== undefined) {
    if (!isNonEmptyString(rawInput.cwd)) {
      throw new Error("explain_episode cwd must be a non-empty string");
    }
    input.cwd = rawInput.cwd;
  }

  return input;
}
