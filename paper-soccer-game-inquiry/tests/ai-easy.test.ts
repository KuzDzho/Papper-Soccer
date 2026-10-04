import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseEdge } from "../src/game/ai";
import { runAiTask } from "../src/game/ai-task";
import { Match, edgeKey, goalOwner, serialize, type MatchConfig, type Pt, type PlayerIdx } from "../src/game/engine";

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const configs: MatchConfig[] = [
  { size: 11, cols: 11, rows: 19, winScore: 1 },
  { size: 19, winScore: 1 },
];

for (const cfg of configs) {
  for (const player of [0, 1] as const) {
    test(`Easy ${player === 0 ? "blue" : "red"} advances toward the opponent's goal (${cfg.cols ?? cfg.size}×${cfg.rows ?? cfg.size})`, () => {
      const m = new Match(cfg);
      m.current = player;
      const forward = player === 0 ? -1 : 1;
      const chosen = new Set<string>();
      for (let seed = 1; seed <= 100; seed++) {
        const before = JSON.stringify({ ball: m.ball, edges: m.edges, moveCount: m.moveCount });
        const t = chooseEdge(m, "easy", random(seed));
        assert.ok(t, "there are free forward nodes from kickoff");
        assert.ok((t.y - m.ball.y) * forward >= 0, `must not retreat to its own goal: ${JSON.stringify(t)}`);
        assert.notEqual(goalOwner(t, cfg), player === 0 ? 1 : 0, "never shoot into own goal");
        assert.equal(JSON.stringify({ ball: m.ball, edges: m.edges, moveCount: m.moveCount }), before, "Easy does not mutate the input match");
        chosen.add(`${t.x},${t.y}`);
      }
      assert.ok(chosen.size >= 2, "Easy is still varied rather than a scripted perfect bot");
    });

    test(`Easy ${player === 0 ? "blue" : "red"} takes an open goal (${cfg.cols ?? cfg.size}×${cfg.rows ?? cfg.size})`, () => {
      const m = new Match(cfg);
      m.current = player;
      const mid = Math.floor((cfg.cols ?? cfg.size) / 2);
      m.ball = { x: mid, y: player === 0 ? 1 : (cfg.rows ?? cfg.size) - 2 };
      for (let seed = 0; seed < 50; seed++) {
        const shot = chooseEdge(m, "easy", random(seed));
        assert.ok(shot);
        assert.equal(goalOwner(shot, cfg), player, "take the obvious goal instead of a random detour");
      }
    });
  }
}

test("Easy never chooses an own-goal when a legal alternative exists", () => {
  for (const player of [0, 1] as const) {
    const cfg = { size: 9, winScore: 1 };
    const m = new Match(cfg);
    m.current = player;
    m.ball = { x: 4, y: player === 0 ? 7 : 1 }; // adjacent to its own goal
    assert.ok(m.legalTargets().some((t) => goalOwner(t, cfg) === (player === 0 ? 1 : 0)));
    for (let seed = 0; seed < 100; seed++) {
      const t = chooseEdge(m, "easy", random(seed));
      assert.ok(t);
      assert.notEqual(goalOwner(t, cfg), player === 0 ? 1 : 0);
      assert.ok((t.y - m.ball.y) * (player === 0 ? -1 : 1) >= 0);
    }
  }
});

test("Easy passes rather than marching backwards after line one or two", () => {
  for (const player of [0, 1] as const) {
    for (const turnMoves of [1, 2]) {
      const cfg = { size: 11, winScore: 1 };
      const m = new Match(cfg);
      m.current = player;
      m.turnMoves = turnMoves;
      m.ball = { x: 5, y: 5 };
      const forwardDy = player === 0 ? -1 : 1;
      // All forward and lateral edges are already drawn; only safe backwards ones remain.
      for (const dx of [-1, 0, 1]) {
        const t: Pt = { x: m.ball.x + dx, y: m.ball.y + forwardDy };
        m.used.add(edgeKey(m.ball, t));
      }
      for (const dx of [-1, 1]) m.used.add(edgeKey(m.ball, { x: m.ball.x + dx, y: m.ball.y }));
      assert.equal(m.canEndTurn(), true);
      assert.ok(m.legalTargets().some((t) => (t.y - m.ball.y) * forwardDy < 0));
      for (let seed = 1; seed <= 30; seed++) {
        assert.equal(chooseEdge(m, "easy", random(seed)), null, "pass instead of retreating");
      }
      m.endTurn();
      assert.notEqual(m.current, player);
      assert.equal(m.turnMoves, 0);
    }
  }
});

test("Easy must draw the mandatory first line even if only backwards lines remain", () => {
  const m = new Match({ size: 11, winScore: 1 });
  m.ball = { x: 5, y: 5 };
  for (const dx of [-1, 0, 1]) m.used.add(edgeKey(m.ball, { x: 5 + dx, y: 4 }));
  for (const dx of [-1, 1]) m.used.add(edgeKey(m.ball, { x: 5 + dx, y: 5 }));
  assert.equal(m.canEndTurn(), false);
  const t = chooseEdge(m, "easy", random(7));
  assert.ok(t && m.isLegal(t), "the bot cannot illegally pass before drawing its first line");
  assert.equal(t.y, 6);
});

test("Easy avoids stepping into a visited node whose forced exit is an own goal", () => {
  const m = new Match({ size: 9, winScore: 1 });
  m.current = 1; // red defends north
  m.ball = { x: 4, y: 1 };
  m.turnMoves = 1;
  const trap = { x: 3, y: 1 };
  m.deg[trap.y * 9 + trap.x] = 1; // old ink → forced bounce if landed on
  // From (3,1), allow only the incoming edge and two exits into our own goal.
  for (const candidate of m.legalTargets(trap)) {
    if (candidate.x === m.ball.x && candidate.y === m.ball.y) continue;
    if (goalOwner(candidate, m.cfg) === 1) continue;
    m.used.add(edgeKey(trap, candidate));
  }
  // From the ball, deny all forward lines and the other lateral line.
  for (const candidate of m.legalTargets()) {
    if (candidate.x === trap.x && candidate.y === trap.y) continue;
    if (goalOwner(candidate, m.cfg) === 0) continue;
    m.used.add(edgeKey(m.ball, candidate));
  }
  assert.deepEqual(m.legalTargets().find((t) => t.x === 3 && t.y === 1), trap);
  assert.equal(m.canEndTurn(), true);
  for (let seed = 1; seed <= 30; seed++) {
    assert.equal(chooseEdge(m, "easy", random(seed)), null, "pass instead of entering a forced own-goal bounce");
  }
});

test("mandatory bounce cannot be skipped; a truly unavoidable own-goal obeys the rules", () => {
  const m = new Match({ size: 9, winScore: 1 });
  m.current = 1;
  m.ball = { x: 4, y: 1 };
  m.turnMoves = 2;
  m.bouncePending = true;
  for (const t of m.legalTargets()) {
    if (goalOwner(t, m.cfg) !== 0) m.used.add(edgeKey(m.ball, t));
  }
  assert.equal(m.canEndTurn(), false);
  const t = chooseEdge(m, "easy", random(13));
  assert.ok(t && m.isLegal(t));
  assert.equal(goalOwner(t, m.cfg), 0);
  const ev = m.doEdge(t);
  assert.equal(ev.kind, "finished");
  assert.equal(ev.scorer, 0);
});

test("Easy uses the same safe attacking choice through the background worker task", () => {
  for (const player of [0, 1] as const) {
    const m = new Match({ size: 11, cols: 11, rows: 19, winScore: 1 });
    m.current = player;
    m.ball = { x: 5, y: player === 0 ? 17 : 1 };
    const snapshot = serialize(m);
    const before = JSON.stringify(snapshot);
    for (let i = 0; i < 20; i++) {
      const answer = runAiTask({ id: i + 1, state: snapshot, level: "easy" });
      assert.equal(answer.ok, true);
      if (answer.ok) {
        assert.ok(answer.target);
        assert.notEqual(goalOwner(answer.target, m.cfg), player === 0 ? 1 : 0);
        assert.ok((answer.target.y - m.ball.y) * (player === 0 ? -1 : 1) >= 0);
      }
    }
    assert.equal(JSON.stringify(snapshot), before, "worker simulation doesn't mutate the match snapshot");
  }
});

test("seeded full Easy matches avoid *deliberate* own goals and keep progressing", () => {
  let finished = 0;
  let voluntaryOwnGoals = 0;
  let moves = 0;
  for (const cfg of configs) {
    for (let seed = 1; seed <= 20; seed++) {
      const m = new Match(cfg);
      const rand = random(seed * 827 + cfg.size);
      let guard = 0;
      while (m.status === "playing" && guard++ < 4000) {
        const mover: PlayerIdx = m.current;
        const t = chooseEdge(m, "easy", rand);
        if (!t) {
          assert.equal(m.canEndTurn(), true, "a null move must be a legal voluntary pass");
          m.endTurn();
          continue;
        }
        const alternatives = m.legalTargets().filter((p) => goalOwner(p, cfg) !== (mover === 0 ? 1 : 0));
        if (goalOwner(t, cfg) === (mover === 0 ? 1 : 0) && (alternatives.length || m.canEndTurn())) voluntaryOwnGoals++;
        const ev = m.doEdge(t);
        moves++;
        if (ev.kind === "goal") m.resetAfterGoal();
      }
      if (m.status === "finished") finished++;
    }
  }
  assert.equal(voluntaryOwnGoals, 0, "no avoidable own goals over full matches");
  assert.ok(finished >= 35, `most matches finish naturally (${finished}/40)`);
  assert.ok(moves > 200, "matches have meaningful play rather than always passing");
});
