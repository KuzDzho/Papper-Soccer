import assert from "node:assert/strict";
import { test } from "node:test";
import { AiClient, type AiWorkerPort, type BotSearch } from "../src/game/ai-client";
import type { AiRequest, AiResponse } from "../src/game/ai-protocol";
import { runAiTask } from "../src/game/ai-task";
import type { BotLevel } from "../src/game/ai";
import { Director } from "../src/game/director";
import { Match, serialize, type Pt, type SerializedState } from "../src/game/engine";

class FakeWorker implements AiWorkerPort {
  onmessage: AiWorkerPort["onmessage"] = null;
  onerror: AiWorkerPort["onerror"] = null;
  onmessageerror: AiWorkerPort["onmessageerror"] = null;
  requests: AiRequest[] = [];
  terminated = false;
  postMessage(request: AiRequest) { this.requests.push(structuredClone(request)); }
  terminate() { this.terminated = true; }
  reply(id: number, target: Pt | null) {
    this.onmessage?.({ data: { id, ok: true, target, elapsedMs: 520 } } as MessageEvent<AiResponse>);
  }
}

/** Intentionally delivers answers even AFTER cancellation to test stale-reply
 * rejection at the director boundary, not just at the worker boundary. */
class ManualSearch implements BotSearch {
  jobs: { state: SerializedState; level: BotLevel; resolve: (t: Pt | null) => void; reject: (e: Error) => void }[] = [];
  warmups = 0;
  cancellations = 0;
  disposals = 0;
  warmup() { this.warmups++; }
  choose(state: SerializedState, level: BotLevel): Promise<Pt | null> {
    return new Promise((resolve, reject) => this.jobs.push({ state: structuredClone(state), level, resolve, reject }));
  }
  cancel() { this.cancellations++; }
  dispose() { this.disposals++; this.cancel(); }
}

function botDirector() {
  const search = new ManualSearch();
  const director = new Director(search);
  director.mode = "bot";
  director.phase = "playing";
  director.botLevel = "hard";
  director.match = new Match({ size: 19, winScore: 3 });
  director.match.current = 1;
  return { director, search };
}

// AI strength and rules stay in the original shared search. Worker reconstruction
// must preserve the active side, remaining turn budget, and mandatory bounces.
test("background task preserves state and completes a forced bounce into goal", () => {
  const match = new Match({ size: 11, cols: 11, rows: 19, winScore: 1 });
  match.ball = { x: 5, y: 17 };
  match.current = 1;
  match.turnMoves = 3;
  match.bouncePending = true;
  const state = serialize(match);
  const before = JSON.stringify(state);
  const result = runAiTask({ id: 42, state, level: "hard" });
  assert.equal(result.id, 42);
  assert.ok(result.ok);
  assert.ok(result.target && match.isLegal(result.target));
  assert.equal(result.target.y, 18);
  assert.equal(JSON.stringify(state), before, "worker never mutates the submitted snapshot");
});

test("AI client reuses one worker and rejects overlapping calculations", async () => {
  const worker = new FakeWorker();
  let factories = 0;
  const client = new AiClient(() => { factories++; return worker; });
  client.warmup();
  const state = serialize(new Match());
  const first = client.choose(state, "hard");
  await assert.rejects(client.choose(state, "hard"), /in-progress/);
  assert.equal(worker.requests.length, 1);
  worker.reply(worker.requests[0].id + 100, { x: 9, y: 8 }); // unrelated reply
  worker.reply(worker.requests[0].id, { x: 9, y: 8 });
  assert.deepEqual(await first, { x: 9, y: 8 });
  const second = client.choose(state, "medium");
  worker.reply(worker.requests[1].id, null);
  assert.equal(await second, null);
  assert.equal(factories, 1);
  client.dispose();
  assert.equal(worker.terminated, true);
});

test("cancelling a worker stops CPU work and discards its late reply", async () => {
  const workers: FakeWorker[] = [];
  const client = new AiClient(() => {
    const w = new FakeWorker(); workers.push(w); return w;
  });
  const first = client.choose(serialize(new Match()), "hard");
  const rejected = assert.rejects(first, { name: "AbortError" });
  const late = workers[0].onmessage!;
  client.cancel();
  await rejected;
  assert.equal(workers[0].terminated, true);
  const next = client.choose(serialize(new Match()), "hard");
  late({ data: { id: workers[0].requests[0].id, ok: true, target: { x: 0, y: 0 }, elapsedMs: 520 } } as MessageEvent<AiResponse>);
  workers[1].reply(workers[1].requests[0].id, { x: 9, y: 8 });
  assert.deepEqual(await next, { x: 9, y: 8 });
  client.dispose();
});

test("hundreds of animation frames schedule only one search per position", async () => {
  const { director: d, search } = botDirector();
  const before = JSON.stringify(serialize(d.match));
  const now = performance.now();
  for (let frame = 0; frame < 600; frame++) d.tick(now + frame * 16, 0.016);
  assert.equal(search.jobs.length, 1);
  assert.equal(d.thinking, true);
  assert.equal(JSON.stringify(serialize(d.match)), before);
  assert.equal(search.jobs[0].level, "hard");
  search.jobs[0].resolve({ x: 9, y: 10 });
  await Promise.resolve();
  assert.equal(d.match.moveCount, 0, "response waits for the frame pump");
  d.tick(performance.now() + 1000, 0.016);
  assert.equal(d.match.moveCount, 1);
  assert.equal(d.thinking, false);
  assert.equal(search.jobs.length, 1, "no new search while the ball animates");
  d.tick(performance.now() + 1300, 0.016);
  assert.equal(search.jobs.length, 2, "one new search after the first line lands");
  assert.equal(search.jobs[1].state.turnMoves, 1);
  d.dispose();
});

test("undo cancels a pending bot move and restores the human turn", async () => {
  const { director: d, search } = botDirector();
  d.match.current = 0;
  const before = JSON.stringify(serialize(d.match));
  d.pointerDown(9, 8);
  d.tick(performance.now() + 300, 0.016);
  d.endTurn();
  assert.equal(search.jobs.length, 1);
  assert.equal(d.match.current, 1);
  d.undo();
  const restored = JSON.stringify(serialize(d.match));
  assert.equal(restored, before);
  search.jobs[0].resolve({ x: 10, y: 9 });
  await Promise.resolve();
  d.tick(performance.now() + 1800, 0.016);
  assert.equal(JSON.stringify(serialize(d.match)), restored);
  assert.equal(d.thinking, false);
  d.dispose();
});

test("late result cannot alter a restarted game, menu or another mode", async () => {
  for (const action of ["rematch", "menu", "local"] as const) {
    const { director: d, search } = botDirector();
    d.tick(performance.now(), 0.016);
    assert.equal(search.jobs.length, 1);
    if (action === "rematch") d.rematch();
    if (action === "menu") d.quitToMenu();
    if (action === "local") d.startLocal({ size: 15, winScore: 3 });
    const before = JSON.stringify(serialize(d.match));
    search.jobs[0].resolve({ x: 9, y: 10 });
    await Promise.resolve();
    d.tick(performance.now() + 1000, 0.016);
    assert.equal(JSON.stringify(serialize(d.match)), before, action);
    assert.equal(d.thinking, false, action);
    d.dispose();
  }
});

test("unmount disposal cancels jobs and releases the worker service", async () => {
  const { director: d, search } = botDirector();
  d.tick(performance.now(), 0.016);
  d.dispose();
  assert.equal(search.disposals, 1);
  search.jobs[0].resolve({ x: 9, y: 10 });
  await Promise.resolve();
  assert.equal(d.match.moveCount, 0);
  assert.equal(d.thinking, false);
});
