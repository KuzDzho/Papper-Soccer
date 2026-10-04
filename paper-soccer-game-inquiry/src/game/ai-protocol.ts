import type { BotLevel } from "./ai";
import type { Pt, SerializedState } from "./engine";

/** Only plain structured-cloneable data crosses the worker boundary. */
export interface AiRequest {
  id: number;
  level: BotLevel;
  state: SerializedState;
}

export type AiResponse =
  | { id: number; ok: true; target: Pt | null; elapsedMs: number }
  | { id: number; ok: false; error: string };
