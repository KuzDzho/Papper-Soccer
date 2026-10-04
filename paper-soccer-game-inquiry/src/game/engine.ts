/* ============================================================
 * PAPER SOCCER — core rules engine (platform-agnostic, shared)
 * Mirror of the KMP `shared/engine` module: zero DOM, zero I/O.
 * Field: COLS x ROWS nodes (default 19x19, both odd). Goals on the
 * short sides (north / south). Phones use a narrow, taller pitch.
 * ============================================================ */

export type PlayerIdx = 0 | 1;

export interface Pt {
  x: number;
  y: number;
}

export interface MatchConfig {
  size: number; // legacy square size — still the fallback for cols/rows
  winScore: number; // goals to win the match, default 3
  cols?: number; // pitch width in nodes (odd); defaults to `size`
  rows?: number; // pitch length in nodes (odd); defaults to `size`
}

/** Pitch width in nodes. */
export const colsOf = (cfg: MatchConfig): number => cfg.cols ?? cfg.size;
/** Pitch length in nodes. */
export const rowsOf = (cfg: MatchConfig): number => cfg.rows ?? cfg.size;

export type GameStatus = "playing" | "goal" | "finished";

export interface EdgeRec {
  a: Pt;
  b: Pt;
  by: PlayerIdx;
}

export interface MoveEvent {
  kind: "move" | "pass" | "goal" | "penalty" | "finished";
  /** Landing was a traditional bounce (wall / already-used node). It is visual
   *  information now; possession is governed by the 1–3 line turn budget. */
  bounce: boolean;
  scorer: PlayerIdx | null; // set when kind === "goal" (or finished by goal)
  from: Pt; // ball position before the edge / at pass time
  to: Pt; // ball position after the edge / at pass time
  stuckAt: Pt | null; // set on penalty (ball teleports to centre from here)
  winner: PlayerIdx | null; // set when kind === "finished" (null => draw)
}

export const DEFAULT_CFG: MatchConfig = { size: 19, winScore: 3 };

export const key = (p: Pt): string => `${p.x},${p.y}`;

export function edgeKey(a: Pt, b: Pt): string {
  const ka = key(a);
  const kb = key(b);
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

/** Row-major node index. `stride` is the pitch width (cols). */
export const idxOf = (p: Pt, stride: number): number => p.y * stride + p.x;

/** Goal mouth half-width in nodes — scales with the pitch WIDTH so the goal
 *  matches the goal-area rectangle visually (≈5 nodes wide on 19 cols). */
export function goalHalf(cols: number): number {
  return Math.max(1, Math.round(((cols - 1) / 2) * 0.22));
}

export function goalMouths(cfg: MatchConfig): [Pt[], Pt[]] {
  const cols = colsOf(cfg);
  const rows = rowsOf(cfg);
  const m = (cols - 1) / 2;
  const gh = goalHalf(cols);
  const top: Pt[] = [];
  const bottom: Pt[] = [];
  for (let dx = -gh; dx <= gh; dx++) {
    top.push({ x: m + dx, y: 0 }); // player 0 (HOME) attacks north
    bottom.push({ x: m + dx, y: rows - 1 }); // player 1 (AWAY) attacks south
  }
  return [top, bottom];
}

/** Returns the scorer index if `p` lies inside a goal mouth, otherwise -1.
 *  Entering the mouth scores for its attacker (own-goal possible). */
export function goalOwner(p: Pt, cfg: MatchConfig): number {
  const cols = colsOf(cfg);
  const m = (cols - 1) / 2;
  if (Math.abs(p.x - m) > goalHalf(cols)) return -1;
  if (p.y === 0) return 0;
  if (p.y === rowsOf(cfg) - 1) return 1;
  return -1;
}

/** Boundary nodes act as walls (bounce-off), except the goal mouths. */
export function isWall(p: Pt, cfg: MatchConfig): boolean {
  const onEdge =
    p.x === 0 || p.y === 0 || p.x === colsOf(cfg) - 1 || p.y === rowsOf(cfg) - 1;
  return onEdge && goalOwner(p, cfg) === -1;
}

export function inside(p: Pt, cfg: MatchConfig): boolean {
  return p.x >= 0 && p.y >= 0 && p.x < colsOf(cfg) && p.y < rowsOf(cfg);
}

/** Forbid riding ALONG a touchline: both endpoints on the same boundary line.
 *  The wall may only be ricocheted off (arrive → bounce → leave through the pitch). */
export function wallTravel(a: Pt, b: Pt, cfg: MatchConfig): boolean {
  const lastX = colsOf(cfg) - 1;
  const lastY = rowsOf(cfg) - 1;
  if (a.x === b.x && (a.x === 0 || a.x === lastX) && a.y !== b.y) return true;
  if (a.y === b.y && (a.y === 0 || a.y === lastY) && a.x !== b.x) return true;
  return false;
}

export function adjacent(a: Pt, b: Pt): boolean {
  const dx = Math.abs(a.x - b.x);
  const dy = Math.abs(a.y - b.y);
  return dx <= 1 && dy <= 1 && dx + dy > 0;
}

/** Diagonal move would cross the other diagonal already drawn in the same cell. */
// v2 rule set: diagonal crossings within the same cell are now permitted
// (legacy `crosses()` removed — no crossing ban).

interface UndoEntry {
  statusBefore: GameStatus;
  scoresBefore: [number, number];
  winnerBefore: PlayerIdx | null;
  lastScorerBefore: PlayerIdx | null;
  turnMovesBefore: number;
  bouncePendingBefore: boolean;
}

export class Match {
  cfg: MatchConfig;
  edges: EdgeRec[] = [];
  used: Set<string> = new Set();
  deg: Int16Array;
  ball: Pt;
  current: PlayerIdx = 0;
  scores: [number, number] = [0, 0];
  status: GameStatus = "playing";
  winner: PlayerIdx | null = null;
  lastScorer: PlayerIdx | null = null;
  moveCount = 0;
  /** Number of drawn edges in the active player's turn (0–3, plus forced bounces). */
  turnMoves = 0;
  /** Landing on a wall / previously-used node forces one continuation. */
  bouncePending = false;
  undoStack: UndoEntry[] = [];

  constructor(cfg: MatchConfig = DEFAULT_CFG) {
    this.cfg = cfg;
    const cols = colsOf(cfg);
    const rows = rowsOf(cfg);
    this.ball = { x: (cols - 1) / 2, y: (rows - 1) / 2 };
    this.deg = new Int16Array(cols * rows);
  }

  clone(): Match {
    const m = new Match(this.cfg);
    m.edges = this.edges.map((e) => ({ a: { ...e.a }, b: { ...e.b }, by: e.by }));
    m.used = new Set(this.used);
    m.deg = this.deg.slice();
    m.ball = { ...this.ball };
    m.current = this.current;
    m.scores = [this.scores[0], this.scores[1]];
    m.status = this.status;
    m.winner = this.winner;
    m.lastScorer = this.lastScorer;
    m.moveCount = this.moveCount;
    m.turnMoves = this.turnMoves;
    m.bouncePending = this.bouncePending;
    m.undoStack = this.undoStack.map((u) => ({
      statusBefore: u.statusBefore,
      scoresBefore: [u.scoresBefore[0], u.scoresBefore[1]] as [number, number],
      winnerBefore: u.winnerBefore,
      lastScorerBefore: u.lastScorerBefore,
      turnMovesBefore: u.turnMovesBefore,
      bouncePendingBefore: u.bouncePendingBefore,
    }));
    return m;
  }

  legalTargets(from: Pt = this.ball): Pt[] {
    if (this.status !== "playing") return [];
    if (goalOwner(from, this.cfg) !== -1) return [];
    const out: Pt[] = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const t: Pt = { x: from.x + dx, y: from.y + dy };
        if (!inside(t, this.cfg)) continue;
        if (wallTravel(from, t, this.cfg)) continue;
        if (this.used.has(edgeKey(from, t))) continue;
        out.push(t);
      }
    }
    return out;
  }

  isLegal(target: Pt): boolean {
    return this.legalTargets().some((t) => t.x === target.x && t.y === target.y);
  }

  /** A player may voluntarily pass after line 1 or 2, unless an old-node/wall
   *  bounce is pending. The forced bounce carries the current line count on. */
  canEndTurn(): boolean {
    return this.status === "playing" && !this.bouncePending && this.turnMoves >= 1 && this.turnMoves < 3;
  }

  /** Bounce rule: landing on a wall or on a node that already had lines. */
  private bounceAt(p: Pt): boolean {
    if (isWall(p, this.cfg)) return true;
    return this.deg[idxOf(p, colsOf(this.cfg))] >= 1; // checked BEFORE adding the edge
  }

  /**
   * Apply one edge from the current ball position to `to`.
   * Throws on illegal input. Handles bounces, goals, deadlocks (penalty) and match end.
   */
  doEdge(to: Pt): MoveEvent {
    if (this.status !== "playing") throw new Error("match-not-playing");
    // The 3-line budget applies to voluntary movement only. A pending bounce
    // must be honoured even after line three; it does not reset this counter.
    if (this.turnMoves >= 3 && !this.bouncePending) throw new Error("turn-limit");
    const from = { ...this.ball };
    if (!adjacent(from, to)) throw new Error("not-adjacent");
    if (!inside(to, this.cfg)) throw new Error("outside");
    if (this.used.has(edgeKey(from, to))) throw new Error("edge-used");
    if (wallTravel(from, to, this.cfg)) throw new Error("wall-travel");
    // crossing rule removed — diagonals may freely overlap within a cell

    const mover = this.current;
    const bounce = this.bounceAt(to);
    this.undoStack.push({
      statusBefore: this.status,
      scoresBefore: [this.scores[0], this.scores[1]],
      winnerBefore: this.winner,
      lastScorerBefore: this.lastScorer,
      turnMovesBefore: this.turnMoves,
      bouncePendingBefore: this.bouncePending,
    });
    const rec: EdgeRec = { a: from, b: { ...to }, by: mover };
    this.edges.push(rec);
    this.used.add(edgeKey(from, to));
    this.deg[idxOf(from, colsOf(this.cfg))]++;
    this.deg[idxOf(to, colsOf(this.cfg))]++;
    this.ball = { ...to };
    this.moveCount++;
    this.turnMoves++;

    const mouth = goalOwner(to, this.cfg);
    if (mouth !== -1) {
      const scorer = mouth as PlayerIdx; // attacker of that mouth scores (own goal => opponent)
      this.scores[scorer]++;
      this.lastScorer = scorer;
      if (this.scores[scorer] >= this.cfg.winScore) {
        this.status = "finished";
        this.winner = scorer;
        return {
          kind: "finished",
          bounce: false,
          scorer,
          from,
          to: { ...to },
          stuckAt: null,
          winner: scorer,
        };
      }
      this.status = "goal";
      return {
        kind: "goal",
        bounce: false,
        scorer,
        from,
        to: { ...to },
        stuckAt: null,
        winner: null,
      };
    }

    const hasFollowUp = this.legalTargets().length > 0;
    // Classic Paper Soccer rule stays intact: a used node / wall forces an
    // immediate bounce. It may exceed line three, but never resets turnMoves.
    this.bouncePending = bounce && hasFollowUp;
    if (this.bouncePending) {
      return {
        kind: "move",
        bounce: true,
        scorer: null,
        from,
        to: { ...to },
        stuckAt: null,
        winner: null,
      };
    }

    // Quiet landing: after the third line (or a dead end) possession passes.
    if (!hasFollowUp || this.turnMoves >= 3) {
      return this.passTurn(from, to, false);
    }

    return {
      kind: "move",
      bounce: false,
      scorer: null,
      from,
      to: { ...to },
      stuckAt: null,
      winner: null,
    };
  }

  /** End the active 1–3 line turn voluntarily after line 1 or 2. */
  endTurn(): MoveEvent {
    if (this.status !== "playing") throw new Error("match-not-playing");
    if (this.turnMoves < 1) throw new Error("must-draw-first");
    if (this.bouncePending) throw new Error("bounce-required");
    if (this.turnMoves >= 3) throw new Error("turn-already-complete");
    const at = { ...this.ball };
    return this.passTurn(at, at, false);
  }

  /** Transfer possession and resolve a deadlock / penalty kick if necessary. */
  private passTurn(from: Pt, to: Pt, bounce: boolean): MoveEvent {
    const next: PlayerIdx = this.current === 0 ? 1 : 0;
    this.current = next;
    this.turnMoves = 0;
    this.bouncePending = false;
    if (this.legalTargets().length === 0) {
      const stuck = { ...this.ball };
      const spot = this.penaltySpot();
      if (!spot) {
        this.status = "finished";
        this.winner = null;
        return {
          kind: "finished",
          bounce,
          scorer: null,
          from,
          to,
          stuckAt: stuck,
          winner: null,
        };
      }
      this.ball = { ...spot };
      return {
        kind: "penalty",
        bounce: false,
        scorer: null,
        from,
        to,
        stuckAt: stuck,
        winner: null,
      };
    }

    return {
      kind: "pass",
      bounce,
      scorer: null,
      from,
      to,
      stuckAt: null,
      winner: null,
    };
  }

  /** Dropped-ball spot: centre if playable, otherwise spiral outward to the freest node. */
  penaltySpot(): Pt | null {
    const cols = colsOf(this.cfg);
    const rows = rowsOf(this.cfg);
    const cx = (cols - 1) / 2;
    const cy = (rows - 1) / 2;
    const freedom = (p: Pt) => this.legalTargets(p).length;
    const centre: Pt = { x: cx, y: cy };
    if (freedom(centre) > 0) return centre;
    let best: Pt | null = null;
    let bestFree = 0;
    const maxR = Math.max(cx, cy);
    for (let r = 1; r <= maxR; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // ring only
          const p: Pt = { x: cx + dx, y: cy + dy };
          if (!inside(p, this.cfg)) continue;
          const f = freedom(p);
          if (f >= 5) return p;
          if (f > bestFree) {
            bestFree = f;
            best = { ...p };
          }
        }
      }
    }
    return best;
  }

  /** Mutating undo of the LAST edge (fully sound: reverts score, status and penalty teleports). Used by AI search. */
  unEdge(): void {
    const e = this.edges.pop();
    const u = this.undoStack.pop();
    if (!e || !u) return;
    this.used.delete(edgeKey(e.a, e.b));
    this.deg[idxOf(e.a, colsOf(this.cfg))]--;
    this.deg[idxOf(e.b, colsOf(this.cfg))]--;
    this.ball = { ...e.a };
    this.current = e.by;
    this.status = u.statusBefore;
    this.scores = [u.scoresBefore[0], u.scoresBefore[1]];
    this.winner = u.winnerBefore;
    this.lastScorer = u.lastScorerBefore;
    this.turnMoves = u.turnMovesBefore;
    this.bouncePending = u.bouncePendingBefore;
    this.moveCount--;
  }

  /** After a goal is celebrated: wipe the pitch, centre the ball, conceder kicks off. */
  resetAfterGoal(): void {
    this.edges = [];
    this.used = new Set();
    const cols = colsOf(this.cfg);
    const rows = rowsOf(this.cfg);
    this.deg = new Int16Array(cols * rows);
    this.ball = { x: (cols - 1) / 2, y: (rows - 1) / 2 };
    this.current = this.lastScorer === 0 ? 1 : 0;
    this.turnMoves = 0;
    this.bouncePending = false;
    this.status = "playing";
    this.undoStack = [];
  }
}

/* ================= serialization (network / storage) ================= */

export interface SerializedState {
  cfg: MatchConfig;
  edges: [number, number, number, number, PlayerIdx][];
  ball: [number, number];
  current: PlayerIdx;
  scores: [number, number];
  status: GameStatus;
  winner: PlayerIdx | null;
  lastScorer: PlayerIdx | null;
  moveCount: number;
  /** Undefined only for legacy room records; interpreted as 0. */
  turnMoves?: number;
  /** Undefined for legacy records; interpreted as false. */
  bouncePending?: boolean;
}

export function serialize(m: Match): SerializedState {
  return {
    cfg: m.cfg,
    edges: m.edges.map((e) => [e.a.x, e.a.y, e.b.x, e.b.y, e.by]),
    ball: [m.ball.x, m.ball.y],
    current: m.current,
    scores: [m.scores[0], m.scores[1]],
    status: m.status,
    winner: m.winner,
    lastScorer: m.lastScorer,
    moveCount: m.moveCount,
    turnMoves: m.turnMoves,
    bouncePending: m.bouncePending,
  };
}

export function deserialize(s: SerializedState): Match {
  const m = new Match(s.cfg);
  for (const [ax, ay, bx, by, pl] of s.edges) {
    m.edges.push({ a: { x: ax, y: ay }, b: { x: bx, y: by }, by: pl });
    m.used.add(edgeKey({ x: ax, y: ay }, { x: bx, y: by }));
    m.deg[idxOf({ x: ax, y: ay }, colsOf(s.cfg))]++;
    m.deg[idxOf({ x: bx, y: by }, colsOf(s.cfg))]++;
  }
  m.ball = { x: s.ball[0], y: s.ball[1] };
  m.current = s.current;
  m.scores = [s.scores[0], s.scores[1]];
  m.status = s.status;
  m.winner = s.winner;
  m.lastScorer = s.lastScorer;
  m.moveCount = s.moveCount;
  m.turnMoves = s.turnMoves ?? 0;
  m.bouncePending = s.bouncePending ?? false;
  // Defensive: restore undo stack entries so do/unEdge stays balanced
  // if the state is cloned into an AI search later.
  for (const e of m.edges) {
    void e;
    m.undoStack.push({
      statusBefore: "playing",
      scoresBefore: [s.scores[0], s.scores[1]],
      winnerBefore: null,
      lastScorerBefore: null,
      turnMovesBefore: Math.max(0, m.turnMoves - 1),
      bouncePendingBefore: false,
    });
  }
  return m;
}

/** One finished turn as a network DTO (targets only; start is implied by the ball). */
export interface ChainRec {
  by: PlayerIdx;
  e: { x: number; y: number }[];
  /** Player elected to stop after their 1st or 2nd line. */
  ended?: boolean;
}

/** Validate + replay one completed 1–3 line turn coming from the network. */
export function applyChain(
  m: Match,
  chain: { x: number; y: number }[],
  by: PlayerIdx,
  ended = false,
): MoveEvent[] {
  if (m.status === "goal") m.resetAfterGoal(); // deterministic lazy reset first — the conceder kicks off
  if (m.current !== by) throw new Error("not-your-turn");
  // Three voluntary lines plus any number of classic forced bounces.
  // The engine enforces the 3-line budget; 64 is only an abuse guard.
  if (chain.length < 1 || chain.length > 64) throw new Error("bad-turn-length");
  const events: MoveEvent[] = [];
  for (const t of chain) {
    const ev = m.doEdge({ x: t.x, y: t.y });
    events.push(ev);
    if (ev.kind === "goal" || ev.kind === "finished" || m.current !== by) break;
  }
  // Reject extra targets after an automatic pass / score.
  if (events.length !== chain.length) throw new Error("chain-overrun");
  if (m.current === by && m.status === "playing") {
    if (!ended) throw new Error("chain-incomplete");
    events.push(m.endTurn());
  } else if (ended && m.status === "playing") {
    // Third line already passed the turn; an extra "stop" is malformed.
    throw new Error("redundant-end");
  }
  return events;
}
