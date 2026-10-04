import { chooseEdge } from "./ai";
import { deserialize } from "./engine";
import type { AiRequest, AiResponse } from "./ai-protocol";

/** Runs ONLY in the dedicated worker or the server fallback, never in a frame.
 * Uses exactly the normal difficulty settings, including Hard's full budget. */
export function runAiTask(request: AiRequest): AiResponse {
  try {
    const started = performance.now();
    const match = deserialize(request.state);
    const target = chooseEdge(match, request.level);
    return {
      id: request.id,
      ok: true,
      target,
      elapsedMs: performance.now() - started,
    };
  } catch (error) {
    return {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : "ai-search-failed",
    };
  }
}
