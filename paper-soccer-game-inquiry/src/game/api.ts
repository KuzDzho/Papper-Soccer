/* ============================================================
 * PAPER SOCCER — сервер комнат и AI-эндпоинт
 * Реализация ровно того контракта, который ждёт src/game/net.ts:
 *   POST /api/rooms               { cfg }                       -> JoinResult
 *   POST /api/rooms/:code/join    { token? }                    -> JoinResult
 *   POST /api/rooms/:code/move    { token, baseSeq, chain, ended } -> { ok, seq }
 *   GET  /api/rooms/:code                                        -> RoomSnapshot
 *   POST /api/ai/move             AiRequest                     -> AiResponse
 *
 * Сервер авторитетный: состояние партии и проверка хода идут через движок
 * (applyChain бросает not-your-turn / chain-overrun / must-continue и т.д.),
 * поэтому обмануть клиента нельзя. Хранилище — интерфейсов на один метод:
 * в бою это Postgres/Redis, здесь — то же API поверх localStorage, чтобы
 * режим «по ссылке» работал между вкладками без Node-процесса.
 * ============================================================ */

import { Match, applyChain, deserialize, serialize, type ChainRec, type MatchConfig, type PlayerIdx, type SerializedState } from "./engine";
import { runAiTask } from "./ai-task";
import type { AiRequest } from "./ai-protocol";
import { storageGetJSON, storageSetJSON } from "./storage";

export interface RoomRecord {
  code: string;
  cfg: MatchConfig;
  seq: number;
  status: "waiting" | "playing" | "finished";
  state: SerializedState;
  chains: ChainRec[];
  home: { token: string; joined: boolean };
  away: { token: string; joined: boolean } | null;
  updatedAt: number;
}

export interface RoomStore {
  load(code: string): RoomRecord | null;
  save(room: RoomRecord): void;
  create(room: RoomRecord): RoomRecord | null;
  watch(cb: (code: string) => void): () => void;
}

const PREFIX = "ps-room-";
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** 5 знаков — ровно столько принимает поле ввода в меню (slice(0, 5)). */
function newCode(): string {
  let code = "";
  for (let i = 0; i < 5; i++) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return code;
}
function newToken(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/** localStorage-хранилище: одно на браузер, поэтому две вкладки = две стороны. */
export const localStore: RoomStore = {
  load(code) {
    return storageGetJSON<RoomRecord>(PREFIX + code);
  },
  save(room) {
    room.updatedAt = Date.now();
    storageSetJSON(PREFIX + room.code, room);
    try {
      bus()?.postMessage({ type: "update", code: room.code });
    } catch {
      /* ignore */
    }
  },
  create(room) {
    const taken = storageGetJSON<RoomRecord>(PREFIX + room.code);
    if (taken) return null;
    this.save(room);
    return room;
  },
  watch(cb) {
    const bc = bus();
    if (!bc) return () => {};
    const handler = (event: MessageEvent<{ type?: string; code?: string }>) => {
      if (event.data?.type === "update" && event.data.code) cb(event.data.code);
    };
    bc.addEventListener("message", handler);
    return () => bc.removeEventListener("message", handler);
  },
};

let busRef: BroadcastChannel | null | undefined;
function bus(): BroadcastChannel | null {
  if (busRef !== undefined) return busRef;
  try {
    busRef = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("ps_rooms") : null;
  } catch {
    busRef = null;
  }
  return busRef;
}

function roleOf(room: RoomRecord, token: string): PlayerIdx | null {
  if (room.home.token === token) return 0;
  if (room.away?.token === token) return 1;
  return null;
}

function snapshot(room: RoomRecord) {
  return {
    code: room.code,
    status: room.status,
    seq: room.seq,
    state: room.state,
    chains: room.chains,
    players: { home: room.home.joined, away: !!room.away?.joined },
  };
}

function joinResult(room: RoomRecord, role: PlayerIdx, token: string) {
  return { code: room.code, role, token, seq: room.seq, state: room.state, status: room.status };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const fail = (error: string, status = 400) => json({ error }, status);

export interface ApiDeps {
  store: RoomStore;
}

/** Все эндпоинты API одним диспетчером — переиспользуется и в Next-роутах. */
export function createApi(deps: ApiDeps = { store: localStore }) {
  const { store } = deps;

  return async function handleApi(request: Request): Promise<Response | null> {
    const url = new URL(request.url, "http://localhost");
    const path = url.pathname.replace(/\/+$/, "");
    const method = request.method.toUpperCase();

    if (path === "/api/health") return json({ ok: true, at: Date.now() });

    if (path === "/api/ai/move" && method === "POST") {
      const body = (await request.json().catch(() => null)) as AiRequest | null;
      if (!body?.state) return fail("bad-request");
      return json(runAiTask(body));
    }

    if (path === "/api/rooms" && method === "POST") {
      const { cfg } = (await request.json().catch(() => ({}))) as { cfg?: MatchConfig };
      const config: MatchConfig = cfg ?? { size: 19, winScore: 3 };
      const match = new Match(config);
      const room: RoomRecord = {
        code: newCode(),
        cfg: config,
        seq: 0,
        status: "waiting",
        state: serialize(match),
        chains: [],
        home: { token: newToken(), joined: true },
        away: null,
        updatedAt: Date.now(),
      };
      if (!store.create(room)) return fail("code-clash", 500);
      return json(joinResult(room, 0, room.home.token), 201);
    }

    const join = /^\/api\/rooms\/([A-Z0-9]{4,5})\/join$/.exec(path);
    const move = /^\/api\/rooms\/([A-Z0-9]{4,5})\/move$/.exec(path);
    const peek = /^\/api\/rooms\/([A-Z0-9]{4,5})$/.exec(path);

    if (join && method === "POST") {
      const room = store.load(join[1]);
      if (!room) return fail("room-not-found", 404);
      const { token } = (await request.json().catch(() => ({}))) as { token?: string };
      if (token) {
        const role = roleOf(room, token);
        if (role === null) return fail("bad-token", 403);
        if (role === 0) room.home.joined = true;
        else if (room.away) room.away.joined = true;
        store.save(room);
        return json(joinResult(room, role, token));
      }
      if (room.away?.joined) return fail("room-full", 409);
      const fresh = { token: newToken(), joined: true };
      room.away = fresh;
      if (room.status === "waiting") {
        room.status = "playing";
        // the away side picks the other colour: current stays as the engine left it
        const m = deserialize(room.state);
        m.current = 1;
        room.state = serialize(m);
      }
      room.seq++;
      store.save(room);
      return json(joinResult(room, 1, fresh.token));
    }

    if (move && method === "POST") {
      const room = store.load(move[1]);
      if (!room) return fail("room-not-found", 404);
      const body = (await request.json().catch(() => ({}))) as { token?: string; baseSeq?: number; chain?: { x: number; y: number }[]; ended?: boolean };
      const role = roleOf(room, String(body.token ?? ""));
      if (role === null) return fail("bad-token", 403);
      if (room.seq !== Number(body.baseSeq)) return fail("stale-seq", 409);
      const match = deserialize(room.state);
      try {
        applyChain(match, body.chain ?? [], role, Boolean(body.ended));
      } catch (e) {
        return fail(e instanceof Error ? e.message : "chain-rejected", 422);
      }
      room.chains = [...room.chains, { by: role, e: (body.chain ?? []).map((p) => ({ x: p.x, y: p.y })), ended: Boolean(body.ended) }];
      room.state = serialize(match);
      room.status = match.status === "finished" ? "finished" : "playing";
      room.seq++;
      store.save(room);
      return json({ ok: true, seq: room.seq });
    }

    if (peek && method === "GET") {
      const room = store.load(peek[1]);
      if (!room) return fail("room-not-found", 404);
      return json(snapshot(room));
    }

    return null;
  };
}

export const handleApi = createApi();

/** В статической сборке (без Node) сервер монтируется во вкладку: перехватываются
 *  только /api/*, всё остальное идёт оригинальным fetch. Клиент не меняется. */
export function installPreviewApi(): () => void {
  if (typeof window === "undefined" || (window as unknown as { __psApi?: boolean }).__psApi) return () => {};
  const original = window.fetch.bind(window);
  (window as unknown as { __psApi?: boolean }).__psApi = true;
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      const request = input instanceof Request ? input : new Request(typeof input === "string" ? input : input.toString(), init);
      if (new URL(request.url, location.href).pathname.startsWith("/api/")) {
        const handled = await handleApi(request);
        if (handled) return handled;
      }
    } catch {
      /* падаем на оригинальный fetch */
    }
    return original(input as RequestInfo, init);
  };
  return () => {
    window.fetch = original;
    (window as unknown as { __psApi?: boolean }).__psApi = false;
  };
}
