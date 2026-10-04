/* ============================================================
 * PAPER SOCCER — network transport (shared/net contract)
 * Socket-shaped API over fetch+poll. Swap `connect()` internals
 * for a real WebSocket without touching callers.
 * ============================================================ */

import { SerializedState, PlayerIdx, ChainRec, MatchConfig } from "./engine";
import { storageGetJSON, storageRemove, storageSetJSON } from "./storage";

export interface RoomSnapshot {
  code: string;
  status: "waiting" | "playing" | "finished";
  seq: number;
  state: SerializedState;
  chains: ChainRec[];
  players: { home: boolean; away: boolean };
}

export interface JoinResult {
  code: string;
  role: PlayerIdx;
  token: string;
  seq: number;
  state: SerializedState;
  status: RoomSnapshot["status"];
}

async function jpost<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(String(data.error ?? `http-${res.status}`));
  return data as T;
}

export async function createRoom(cfg: MatchConfig): Promise<JoinResult> {
  return jpost<JoinResult>("/api/rooms", { cfg });
}

export async function joinRoom(code: string, token?: string): Promise<JoinResult> {
  return jpost<JoinResult>(`/api/rooms/${code.toUpperCase()}/join`, { token });
}

export async function submitChain(
  code: string,
  token: string,
  baseSeq: number,
  chain: { x: number; y: number }[],
  ended: boolean,
): Promise<{ ok: true; seq: number }> {
  return jpost(`/api/rooms/${code.toUpperCase()}/move`, { token, baseSeq, chain, ended });
}

export async function fetchRoom(code: string): Promise<RoomSnapshot> {
  const res = await fetch(`/api/rooms/${code.toUpperCase()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`http-${res.status}`);
  return (await res.json()) as RoomSnapshot;
}

/** Poll-based "socket": emits snapshots whenever seq advances. */
export class RoomChannel {
  onSnapshot: ((s: RoomSnapshot) => void) | null = null;
  onError: ((e: Error) => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private code: string;
  private seq: number;
  private inflight = false;

  constructor(code: string, seq: number) {
    this.code = code;
    this.seq = seq;
  }

  start(intervalMs = 1200) {
    this.stop();
    this.timer = setInterval(() => void this.tick(), intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  setSeq(seq: number) {
    this.seq = seq;
  }

  async tick() {
    if (this.inflight) return;
    this.inflight = true;
    try {
      const s = await fetchRoom(this.code);
      if (s.seq !== this.seq) {
        this.seq = s.seq;
        this.onSnapshot?.(s);
      } else {
        // still emit occasionally for presence (players.away join flips seq anyway)
        this.onSnapshot?.(s);
      }
    } catch (e) {
      this.onError?.(e as Error);
    } finally {
      this.inflight = false;
    }
  }
}

const LS_KEY = "ps_room";

export function rememberSession(code: string, token: string, role: PlayerIdx) {
  storageSetJSON(LS_KEY, { code, token, role });
}

export function recallSession(): { code: string; token: string; role: PlayerIdx } | null {
  return storageGetJSON<{ code: string; token: string; role: PlayerIdx }>(LS_KEY);
}

export function forgetSession() {
  storageRemove(LS_KEY);
}
