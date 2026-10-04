/* ============================================================
 * PAPER SOCCER — bot brain (shared/ai)
 * easy   : quick, varied forward-first play; no voluntary own goals
 * medium : bounded 2-turn alpha-beta lookahead + occasional imprecision
 * hard   : deeper iterative alpha-beta + BFS-distance heuristic
 * A "ply" = a finished turn (forced bounce chains continue).
 * ============================================================ */

import {
  Match,
  Pt,
  PlayerIdx,
  MoveEvent,
  goalMouths,
  goalOwner,
  isWall,
  wallTravel,
  edgeKey,
  colsOf,
  rowsOf,
} from "./engine";

export type BotLevel = "easy" | "medium" | "hard";

const INF = 1e9;
const BUDGET = 90_000;
const CHAIN_CAP = 16;

/* Difficulty ladder. Both levels share one engine; only the search horizon and
 * the thinking time differ, so Hard is a strict superset of Medium's search. */
const MEDIUM_DEPTH = 2;
const MEDIUM_MS = 140;
const HARD_DEPTH = 8; // an upper bound — iterative deepening stops on the clock
const HARD_MS = 520;

class SearchAbort extends Error {}

interface Budget {
  n: number;
  deadline: number;
}

function inTargets(x: number, y: number, ts: Pt[]): boolean {
  for (const t of ts) if (t.x === x && t.y === y) return true;
  return false;
}

/** Evaluate the threat picture from an arbitrary reference point (used after the ball teleports). */
function threatAt(m: Match, at: Pt, root: PlayerIdx): number {
  const gm = goalMouths(m.cfg);
  const [dA, dB] = bfsBoth(m, at, gm[0], gm[1]);
  const dRoot = root === 0 ? dA : dB;
  const dOpp = root === 0 ? dB : dA;
  const mine = Math.min(dRoot, DIST_CAP);
  const theirs = Math.min(dOpp, DIST_CAP);
  return (theirs - mine) * DIST_SCALE;
}

/** Multi-source BFS from the ball to BOTH goal mouths (3 nodes each) — one pass. */
function bfsBoth(m: Match, from: Pt, t0s: Pt[], t1s: Pt[]): [number, number] {
  const cols = colsOf(m.cfg);
  const rows = rowsOf(m.cfg);
  const cap = cols * rows;
  let d0 = inTargets(from.x, from.y, t0s) ? 0 : 99;
  let d1 = inTargets(from.x, from.y, t1s) ? 0 : 99;
  if (d0 === 0 && d1 === 0) return [0, 0];
  const dist = new Int32Array(cap).fill(-1);
  const q = new Int32Array(cap + 8);
  let qh = 0;
  let qt = 0;
  const si = from.y * cols + from.x;
  dist[si] = 0;
  q[qt++] = si;
  while (qh < qt && (d0 === 99 || d1 === 99)) {
    const cur = q[qh++];
    const x = cur % cols;
    const y = (cur / cols) | 0;
    const d = dist[cur] + 1;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const ni = ny * cols + nx;
        if (dist[ni] !== -1) continue;
        const a = { x, y };
        const b = { x: nx, y: ny };
        if (m.used.has(edgeKey(a, b))) continue;
        if (wallTravel(a, b, m.cfg)) continue; // no riding the touchline in routes either
        if (d0 === 99 && inTargets(nx, ny, t0s)) d0 = d;
        if (d1 === 99 && inTargets(nx, ny, t1s)) d1 = d;
        dist[ni] = d;
        q[qt++] = ni;
      }
    }
  }
  return [d0, d1];
}

const DIST_CAP = 20;
const DIST_SCALE = 36 / DIST_CAP; // (theirs - mine) spans ≈ 2*DIST_CAP → ±36 pts

function evaluate(m: Match, root: PlayerIdx): number {
  if (m.status === "finished") {
    if (m.winner === null) return 0;
    return m.winner === root ? 500_000 : -500_000;
  }
  const gm = goalMouths(m.cfg);
  const [dA, dB] = bfsBoth(m, m.ball, gm[0], gm[1]);
  const dRoot = root === 0 ? dA : dB;
  const dOpp = root === 0 ? dB : dA;
  // Saturate range: pure ~10-step route runs shouldn't outweigh being 2 steps from scoring.
  const mine = Math.min(dRoot, DIST_CAP);
  const theirs = Math.min(dOpp, DIST_CAP);
  const mob = m.legalTargets().length;
  const scoreDiff = (m.scores[root] - m.scores[1 - root]) * 500;
  const side: PlayerIdx = m.current;
  const mobTerm = (side === root ? mob : -mob) * 1.6;
  // Ball pressure toward the goal I attack, away from the one I defend.
  // Measured at the reached position — NOT from the perspective of the side to move.
  return scoreDiff + (theirs - mine) * DIST_SCALE + mobTerm;
}

function goalVal(ev: MoveEvent, root: PlayerIdx, ply: number): number {
  const base = 240_000;
  if (ev.scorer === null) return 0;
  return ev.scorer === root ? base - ply * 90 : -base + ply * 90;
}

function orderScore(m: Match, t: Pt, root: PlayerIdx): number {
  const mine = goalMouths(m.cfg)[root];
  const mouthDist = (x: number, y: number) => {
    let best = 99;
    for (const n of mine) {
      const d = Math.abs(x - n.x) + Math.abs(y - n.y);
      if (d < best) best = d;
    }
    return best;
  };
  const before = mouthDist(m.ball.x, m.ball.y);
  const after = mouthDist(t.x, t.y);
  let s = (before - after) * 10;
  if (isWall(t, m.cfg) || m.deg[t.y * colsOf(m.cfg) + t.x] > 0) s += 14; // keep the turn alive
  const owner = goalOwner(t, m.cfg);
  if (owner === root) s += 10_000;
  else if (owner !== -1) s -= 10_000; // never dive into the goal you defend
  return s;
}

function search(
  m: Match,
  depth: number,
  alpha: number,
  beta: number,
  root: PlayerIdx,
  ply: number,
  chain: number,
  budget: Budget,
): number {
  const n = ++budget.n;
  if (n > BUDGET) throw new SearchAbort();
  if ((n & 511) === 0 && Date.now() > budget.deadline) throw new SearchAbort();
  if (m.status === "finished") return evaluate(m, root);
  if (depth <= 0) return evaluate(m, root);
  if (chain > CHAIN_CAP) return evaluate(m, root);

  const targets = m.legalTargets();
  targets.sort((a, b) => orderScore(m, b, root) - orderScore(m, a, root));

  const idxB = m.ball.y * colsOf(m.cfg) + m.ball.x;
  const jammed =
    !isWall(m.ball, m.cfg) && m.deg[idxB] >= 1 && targets.length === 0;

  const maximizing = m.current === root;
  let best = maximizing ? -INF : INF;

  for (const t of targets) {
    const mover = m.current;
    const ev = m.doEdge(t);
    let val: number;
    try {
      if (ev.kind === "goal") {
        val = goalVal(ev, root, ply);
      } else if (ev.kind === "finished" && m.winner !== null) {
        val = m.winner === root ? 420_000 - ply * 60 : -420_000 + ply * 60;
      } else if (ev.kind === "penalty") {
        // REAL penalty: side to move ran out of lines and the ball teleports off.
        // Sharp positional judgement at the restart spot — this is a disaster to avoid
        // (or a gift to force), never a neutral "toss the ball back".
        const restart = m.penaltySpot() ?? m.ball;
        const threat = threatAt(m, restart, root);
        const swing = m.current === root ? 900 : -900;
        val = threat * 55 + swing;
      } else {
        const passed = m.current !== mover; // quiet landing — turn goes over
        const nextDepth = passed ? depth - 1 : depth;
        val = search(m, nextDepth, alpha, beta, root, ply + 1, chain + 1, budget);
      }
    } finally {
      m.unEdge();
    }
    if (maximizing) {
      if (val > best) best = val;
      if (best > alpha) alpha = best;
    } else {
      if (val < best) best = val;
      if (best < beta) beta = best;
    }
    if (alpha >= beta) break;
  }

  if (targets.length === 0) {
    // Midfield jam with ink through the ball: ball jams permanently.
    // Rank it precisely by whose half suffers more on the frozen position.
    return threatAt(m, m.ball, root) * 60;
  }
  void jammed;
  return best;
}

export interface ScoredMove {
  t: Pt;
  v: number;
}

interface RankResult {
  moves: ScoredMove[];
  /** True only when EVERY legal root move received a real score at this depth. */
  complete: boolean;
}

/** Scores every legal first edge at a fixed depth.
 *
 * A partial pass is useless for choosing a move: the unscored moves are simply
 * missing, so the pick collapses onto the ordering heuristic. Therefore the
 * result is flagged and the caller keeps the last COMPLETE depth instead. */
function rankAtDepth(m: Match, depth: number, budget: Budget, pre?: ScoredMove[]): RankResult {
  const root = m.current;
  const targets = m.legalTargets();
  targets.sort((a, b) => orderScore(m, b, root) - orderScore(m, a, root));
  if (pre && pre.length > 0) {
    // Search the previous iteration's best lines first → far better cutoffs.
    const prio = new Map<string, number>();
    pre.forEach((r, i) => prio.set(`${r.t.x},${r.t.y}`, pre.length - i));
    targets.sort((a, b) => (prio.get(`${b.x},${b.y}`) ?? 0) - (prio.get(`${a.x},${a.y}`) ?? 0));
  }
  const out: ScoredMove[] = [];
  let complete = true;
  try {
    for (const t of targets) {
      const mover = m.current;
      const ev = m.doEdge(t);
      let v: number;
      try {
        if (ev.kind === "goal") v = goalVal(ev, root, 0);
        else if (ev.kind === "finished" && m.winner !== null) {
          v = m.winner === root ? 420_000 : -420_000;
        } else if (ev.kind === "finished") {
          v = threatAt(m, m.ball, root) * 60;
        } else if (ev.kind === "penalty") {
          const restart = m.penaltySpot() ?? m.ball;
          const threat = threatAt(m, restart, root);
          const swing = m.current === root ? 900 : -900;
          v = threat * 55 + swing;
        } else v = search(m, m.current !== mover ? depth - 1 : depth, -INF, INF, root, 1, 1, budget);
      } finally {
        m.unEdge();
      }
      out.push({ t, v });
    }
  } catch (e) {
    if (!(e instanceof SearchAbort)) throw e;
    complete = false; // ran out of time / nodes: this depth is not trustworthy
  }
  out.sort((a, b) => b.v - a.v);
  return { moves: out, complete };
}

/** Iterative deepening: depth 1, 2, 3 … keeping the deepest COMPLETE ranking.
 *
 * Depth 1 is nearly free, so a usable full ranking always exists; deeper passes
 * only ever replace it when they finish. This is what makes Hard reliably
 * stronger than Medium instead of occasionally degenerating into a truncated
 * candidate list. */
function bestRanking(m: Match, maxDepth: number, timeMs: number): ScoredMove[] {
  const root = m.current;
  const budget: Budget = { n: 0, deadline: Date.now() + timeMs };
  let best: ScoredMove[] = [];
  for (let d = 1; d <= maxDepth; d++) {
    const r = rankAtDepth(m, d, budget, best);
    if (!r.complete) break; // keep the last fully searched depth
    best = r.moves;
    if (Date.now() >= budget.deadline || budget.n > BUDGET) break;
  }
  if (best.length === 0) {
    // Extremely tight budget: fall back to the static ordering, never nothing.
    const targets = m.legalTargets();
    return targets
      .map((t) => ({ t, v: orderScore(m, t, root) }))
      .sort((a, b) => b.v - a.v);
  }
  return best;
}

/** Back-compat wrapper used by tests and diagnostics.
 *  Always returns every legal root move: if a timed pass is incomplete, its
 *  verified scores are retained and unscored candidates receive static values.
 */
function rankMoves(m: Match, depth: number, timeMs = 380, pre?: ScoredMove[]): ScoredMove[] {
  const root = m.current;
  const budget: Budget = { n: 0, deadline: Date.now() + timeMs };
  const r = rankAtDepth(m, depth, budget, pre);
  const seen = new Map(r.moves.map((x) => [`${x.t.x},${x.t.y}`, x.v]));
  const complete: ScoredMove[] = m.legalTargets().map((t) => ({
    t,
    v: seen.get(`${t.x},${t.y}`) ?? orderScore(m, t, root),
  }));
  return complete.sort((a, b) => b.v - a.v);
}

/** A simple one-step warning for Easy: if a bounce would FORCE the very next
 * line into our own mouth (or straight into a dead end), avoid it when there
 * is another choice. This is not minimax — just the obvious football instinct. */
function badEasyBounce(m: Match, target: Pt, ownGoal: PlayerIdx): boolean {
  const index = target.y * colsOf(m.cfg) + target.x;
  if (!isWall(target, m.cfg) && m.deg[index] === 0) return false;
  const incoming = edgeKey(m.ball, target);
  const exits = m.legalTargets(target).filter((p) => edgeKey(target, p) !== incoming);
  return exits.length === 0 || exits.every((p) => goalOwner(p, m.cfg) === ownGoal);
}

/** Easy plays without minimax: picks random SAFE forward lines, can use a
 * lateral detour, and stops after 1–2 lines rather than retreating towards its
 * own goal. It converts a free goal and never deliberately shoots into its own. */
function chooseEasy(m: Match, rand: () => number): Pt | null {
  const targets = m.legalTargets();
  if (targets.length === 0) return null;
  const me = m.current;
  const ownGoal: PlayerIdx = me === 0 ? 1 : 0;
  const pick = (pool: Pt[]): Pt => pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))];

  // If the only possible line is an own-goal, pass when legal. A pending
  // bounce or the mandatory first line cannot be skipped under the rules.
  const noOwnGoal = targets.filter((t) => goalOwner(t, m.cfg) !== ownGoal);
  if (noOwnGoal.length === 0) return m.canEndTurn() ? null : pick(targets);

  // Nobody should miss an entirely unguarded goal right next to the ball.
  const finish = noOwnGoal.filter((t) => goalOwner(t, m.cfg) === me);
  if (finish.length > 0) return pick(finish);

  // Do not deliberately bounce into a forced own-goal on the next line. If
  // there is no alternative, it remains a legal move (the rules still apply).
  const noTrap = noOwnGoal.filter((t) => !badEasyBounce(m, t, ownGoal));
  if (noTrap.length === 0 && m.canEndTurn()) return null;
  const safe = noTrap.length > 0 ? noTrap : noOwnGoal;
  const direction = me === 0 ? -1 : 1; // blue north, red south
  const forward = safe.filter((t) => (t.y - m.ball.y) * direction > 0);
  const lateral = safe.filter((t) => t.y === m.ball.y);

  // After a non-bounce first/second line a simple player may stop while ahead.
  // The modest pass chance keeps Easy approachable without sending the ball
  // back toward its own net. Passing is forbidden during a forced bounce.
  if (m.canEndTurn() && (forward.length === 0 && lateral.length === 0 || rand() < (m.turnMoves === 1 ? 0.18 : 0.3))) {
    return null;
  }

  if (forward.length > 0) {
    // An occasional sideways setup adds variety, but never retreat when a
    // safe forward/lateral line exists. No search or multi-step tactics.
    return lateral.length > 0 && rand() < 0.2 ? pick(lateral) : pick(forward);
  }
  if (lateral.length > 0) return pick(lateral);
  // Only backward lines remain and a pass is not allowed (first line or a
  // compulsory bounce). Pick the least harmful legal direction.
  return pick(safe);
}

export function chooseEdge(
  m: Match,
  level: BotLevel,
  rand: () => number = Math.random,
  opts?: { timeMs?: number },
): Pt | null {
  const targets = m.legalTargets();
  if (targets.length === 0) return null;
  if (level === "easy") return chooseEasy(m, rand);

  if (level === "medium") {
    // Club player: a shallow but complete search, and it sometimes settles for
    // the second-best line instead of the optimum.
    const ranked = bestRanking(m, MEDIUM_DEPTH, opts?.timeMs ?? MEDIUM_MS);
    if (ranked.length === 0) return targets[Math.floor(rand() * targets.length)];
    if (ranked.length > 1 && rand() < 0.16) {
      const k = Math.min(ranked.length - 1, 1 + Math.floor(rand() * 2));
      return ranked[k].t;
    }
    return ranked[0].t;
  }

  // Hard: same engine, but deeper, longer and never second-guessing itself.
  // Iterative deepening guarantees it searches at least as deep as Medium.
  const ranked = bestRanking(m, HARD_DEPTH, opts?.timeMs ?? HARD_MS);
  if (ranked.length === 0) return targets[Math.floor(rand() * targets.length)];
  return ranked[0].t;
}

/** Exposed for tests: Hard should see a forced goal within its horizon. */
export { rankMoves, bfsBoth, evaluate };
