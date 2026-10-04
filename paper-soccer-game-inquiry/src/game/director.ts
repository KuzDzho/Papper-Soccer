/* ============================================================
 * PAPER SOCCER — match director (client orchestration)
 * Owns: engine instance, animation timeline, bot scheduling,
 * online sync, undo, FX & sound triggers, HUD snapshots.
 * Framework-agnostic: React only subscribes to `hud`.
 * ============================================================ */

import {
  Match,
  MatchConfig,
  Pt,
  PlayerIdx,
  MoveEvent,
  serialize,
  deserialize,
  goalMouths,
  SerializedState,
  ChainRec,
} from "./engine";
import type { BotLevel } from "./ai";
import { AiClient, type BotSearch } from "./ai-client";
import { pitchShape, currentIsPhone, currentIsLandscape } from "./presets";
import { sound } from "./sound";
import { Particles, Shake } from "./fx";
import { SceneView } from "./renderer";
import {
  RoomChannel,
  RoomSnapshot,
  createRoom,
  joinRoom,
  submitChain,
  rememberSession,
  recallSession,
  forgetSession,
} from "./net";

export type Mode = "demo" | "bot" | "local" | "online";
export type Phase = "menu" | "lobby" | "playing" | "goal" | "matchover";

export interface HudState {
  mode: Mode;
  phase: Phase;
  scores: [number, number];
  current: PlayerIdx;
  botLevel: BotLevel;
  cfg: MatchConfig;
  banner: string | null;
  names: [string, string]; // display names for side 0 / side 1
  arena: string;
  toss: { winner: PlayerIdx; at: number } | null;
  goalFlash: { scorer: PlayerIdx } | null;
  winner: PlayerIdx | null;
  roomCode: string | null;
  roomStatus: string | null;
  peerConnected: boolean;
  mySide: PlayerIdx;
  muted: boolean;
  canUndo: boolean;
  /** Whether the canvas uses the phone-sized pitch and touch controls. */
  phone: boolean;
  /** 0–3 lines drawn by the active side in this turn. */
  turnMoves: number;
  /** Human can pass voluntarily after line 1 or 2. */
  canEndTurn: boolean;
  /** The last landing was a wall/used-node bounce and must be continued. */
  bouncePending: boolean;
  thinking: boolean;
  moveCount: number;
  serial: number;
}

type Anim =
  | { type: "step"; ax: number; ay: number; bx: number; by: number; t0: number; dur: number }
  | { type: "flight"; ax: number; ay: number; bx: number; by: number; t0: number; dur: number }
  | { type: "sink"; x: number; y: number; t0: number; dur: number };

interface Timed {
  at: number;
  fn: () => void;
}

interface BotTask {
  generation: number;
  match: Match;
  mode: Mode;
  level: BotLevel;
  position: string;
  notBefore: number;
  ready: boolean;
  target: Pt | null;
}

const STEP_MS = 170;
const FLIGHT_MS = 850;
const GOAL_HOLD_MS = 2300;

/** Attract-mode pitch: same shape rules as a real match on this device. */
function demoCfg(): MatchConfig {
  const s = pitchShape("classic", currentIsPhone(), currentIsLandscape());
  return { size: s.cols, cols: s.cols, rows: s.rows, winScore: 99 };
}

export class Director {
  match: Match;
  particles = new Particles();
  shake = new Shake();

  mode: Mode = "demo";
  phase: Phase = "menu";
  botLevel: BotLevel = "medium";

  private anim: Anim | null = null;
  private timed: Timed[] = [];
  private dragState = { active: false, x: 0, y: 0, target: null as Pt | null };
  private impactAt = -10;
  private ballRot = { x: 0.5, y: 0.3 };
  private hideBall = false;

  private chain: { x: number; y: number }[] = [];
  private undoStack: SerializedState[] = [];
  private bannerTxt: string | null = null;
  private tossState: { winner: PlayerIdx; at: number } | null = null;
  private holdUntil = 0; // input/bot gate while the coin spins
  private teamNames: [string, string] = ["Ты", "Соперник"];
  arena = "stadium";

  /** Attract screensaver: idle time (ms) before the demo match starts behind the menu.
   *  Any pointer / key activity resets it and instantly halts the running demo. */
  private idleAt = 0;
  private static readonly ATTRACT_DELAY_MS = 120_000; // 2 minutes
  attractActive = false;

  private room: { code: string; token: string; role: PlayerIdx; seq: number; processed: number; status: string; peer: boolean } | null = null;
  private channel: RoomChannel | null = null;
  /** One remote target at a time; `endAfter` represents a voluntary pass. */
  private remoteQueue: { t: Pt; endAfter: boolean }[] = [];

  thinking = false;
  private botTask: BotTask | null = null;
  private botGeneration = 0;
  private botRetryAt = 0;
  private recorded = false;
  private hudCache: HudState | null = null;
  private listeners = new Set<(h: HudState) => void>();
  private lastEvent: { ev: MoveEvent; mover: PlayerIdx; endAfter?: boolean } | null = null;
  private lastSnapshot: RoomSnapshot | null = null;

  constructor(private readonly botSearch: BotSearch = new AiClient()) {
    this.match = new Match(demoCfg());
  }

  /** Release the worker and network channel on unmount. Reusable for React's
   *  Strict Mode setup/cleanup cycle; nothing is spawned during SSR. */
  dispose() {
    this.stopNet();
    this.botSearch.dispose();
    this.timed = [];
  }

  /* ================= HUD pub/sub ================= */

  subscribe(fn: (h: HudState) => void): () => void {
    this.listeners.add(fn);
    fn(this.hud());
    return () => this.listeners.delete(fn);
  }

  hud(): HudState {
    if (!this.hudCache) this.hudCache = this.buildHud();
    return this.hudCache;
  }

  private buildHud(): HudState {
    return {
      mode: this.mode,
      phase: this.phase,
      scores: [...this.match.scores] as [number, number],
      current: this.match.current,
      botLevel: this.botLevel,
      cfg: this.match.cfg,
      banner: this.bannerTxt,
      names: [this.teamNames[0], this.teamNames[1]],
      arena: this.arena,
      toss: this.tossState,
      goalFlash: this.phase === "goal" ? { scorer: this.match.lastScorer ?? 0 } : null,
      winner: this.match.status === "finished" ? this.match.winner : null,
      roomCode: this.room?.code ?? null,
      roomStatus: this.room?.status ?? null,
      peerConnected: this.room?.peer ?? false,
      mySide: this.room?.role ?? 0,
      muted: sound.muted,
      canUndo: this.mode !== "online" && this.undoStack.length > 0 && !this.anim && this.phase === "playing",
      phone: this.phone,
      turnMoves: Math.min(3, this.match.turnMoves),
      canEndTurn: this.isHumanTurn() && this.match.canEndTurn() && !this.anim && this.remoteQueue.length === 0,
      bouncePending: this.match.bouncePending,
      thinking: this.thinking,
      moveCount: this.match.moveCount,
      serial: (this.hudCache?.serial ?? 0) + 1,
    };
  }

  private emit() {
    this.hudCache = this.buildHud();
    for (const fn of this.listeners) fn(this.hudCache);
  }

  /* ================= helpers ================= */

  private after(ms: number, fn: () => void) {
    this.timed.push({ at: performance.now() + ms, fn });
  }

  /** SFX gate: the attract-mode derby behind the menu is silent. */
  private sfx(fn: () => void) {
    if (this.mode !== "demo") fn();
  }

  private banner(txt: string, holdMs = 2200) {
    this.bannerTxt = txt;
    this.emit();
    this.after(holdMs, () => {
      if (this.bannerTxt === txt) {
        this.bannerTxt = null;
        this.emit();
      }
    });
  }

  isHumanTurn(): boolean {
    if (this.phase !== "playing" || this.match.status !== "playing") return false;
    if (performance.now() < this.holdUntil) return false; // coin still spinning
    if (this.mode === "local") return true;
    if (this.mode === "bot") return this.match.current === 0;
    if (this.mode === "online") return this.room?.peer === true && this.room.status === "playing" && this.room.role === this.match.current;
    return false;
  }

  private isBotTurn(): boolean {
    if (this.match.status !== "playing" || performance.now() < this.holdUntil) return false;
    if (this.mode === "demo") return this.attractActive; // attract loop only once the idle delay expired
    if (this.phase !== "playing") return false;
    if (this.mode === "bot") return this.match.current === 1;
    return false;
  }

  /* ================= mode control ================= */

  startDemo() {
    this.stopNet();
    this.mode = "demo";
    this.phase = "menu";
    this.match = new Match(demoCfg());
    this.resetPresentation();
    this.tossState = null;
    this.holdUntil = 0;
    this.idleAt = performance.now(); // start the 2-minute idle clock for the attract match
    this.attractActive = false;
    this.emit();
  }

  /** User did something: restart the idle clock and, if the attract match was
   *  already playing, instantly wipe it back to a fresh idle pitch. */
  notifyActivity() {
    if (this.mode !== "demo") return;
    this.idleAt = performance.now();
    if (this.attractActive) {
      this.attractActive = false;
      this.match = new Match(demoCfg());
      this.resetPresentation();
      this.emit();
    }
  }

  /** Real-football ceremony: a coin toss decides the opening kickoff. */
  private coinToss() {
    const winner: PlayerIdx = Math.random() < 0.5 ? 0 : 1;
    this.match.current = winner;
    this.tossState = { winner, at: performance.now() };
    this.holdUntil = performance.now() + 2600;
    this.after(2400, () => {
      this.tossState = null;
      this.banner(winner === 0 ? "KICKOFF — BLUE" : "KICKOFF — RED", 1300);
      this.emit();
    });
  }

  setArena(id: string) {
    this.arena = id;
    this.emit();
  }

  /** Team labels (trimmed, capped, with sensible fallbacks). */
  setNames(a: string, b: string) {
    const clean = (s: string, fb: string) => {
      const t = s.replace(/\s+/g, " ").trim().slice(0, 14);
      return t.length > 0 ? t : fb;
    };
    this.teamNames = [clean(a, "Ты"), clean(b, "Соперник")];
    this.emit();
  }

  startBot(level: BotLevel, cfg: MatchConfig, names?: [string, string]) {
    this.stopNet();
    this.mode = "bot";
    this.botLevel = level;
    if (names) this.setNames(names[0], names[1]);
    this.match = new Match(cfg);
    this.phase = "playing";
    this.recorded = false;
    this.resetPresentation();
    this.botSearch.warmup(); // load the worker during the coin toss, not the first move
    this.coinToss();
    this.sfx(() => sound.coin());
    this.emit();
  }

  startLocal(cfg: MatchConfig, names?: [string, string]) {
    this.stopNet();
    this.mode = "local";
    if (names) this.setNames(names[0], names[1]);
    else this.teamNames = ["Синие", "Красные"];
    this.match = new Match(cfg);
    this.phase = "playing";
    this.recorded = false;
    this.resetPresentation();
    this.coinToss();
    this.sfx(() => sound.coin());
    this.emit();
  }

  async hostOnline(cfg: MatchConfig): Promise<void> {
    this.stopNet();
    this.thinking = true;
    this.emit();
    try {
      const r = await createRoom(cfg);
      this.mode = "online";
      this.match = deserialize(r.state); // server-authoritative start (coin toss already done)
      this.phase = "lobby";
      this.recorded = false;
      this.resetPresentation();
      this.room = { code: r.code, token: r.token, role: 0, seq: r.seq, processed: 0, status: "waiting", peer: false };
      rememberSession(r.code, r.token, 0);
      this.openChannel();
    } finally {
      this.thinking = false;
      this.emit();
    }
  }

  async joinOnline(code: string, token?: string): Promise<void> {
    this.stopNet();
    this.thinking = true;
    this.emit();
    try {
      const r = await joinRoom(code, token);
      this.mode = "online";
      this.match = deserialize(r.state);
      this.phase = "playing";
      this.recorded = false;
      this.resetPresentation();
      this.room = { code: r.code, token: r.token, role: r.role, seq: r.seq, processed: 0, status: r.status, peer: true };
      rememberSession(r.code, r.token, r.role);
      this.openChannel();
      this.banner(r.role === 0 ? "RECONNECTED AS HOME" : "CONNECTED AS AWAY", 1800);
    } finally {
      this.thinking = false;
      this.emit();
    }
  }

  resumeSession(): boolean {
    const s = recallSession();
    if (!s) return false;
    void this.joinOnline(s.code, s.token).catch(() => forgetSession());
    return true;
  }

  private openChannel() {
    if (!this.room) return;
    this.channel = new RoomChannel(this.room.code, this.room.seq);
    this.channel.onSnapshot = (s) => this.onSnapshot(s);
    this.channel.start(1100);
    void this.channel.tick();
  }

  private stopNet() {
    this.cancelBotSearch();
    this.channel?.stop();
    this.channel = null;
    this.room = null;
    this.remoteQueue = [];
  }

  quitToMenu() {
    forgetSession();
    this.startDemo();
  }

  forfeit() {
    // local/bot only: award match to the other side
    if (this.mode === "online") return;
    this.cancelBotSearch();
    this.timed = [];
    this.anim = null;
    const w: PlayerIdx = this.match.current === 0 ? 1 : 0;
    this.match.winner = w;
    this.match.status = "finished";
    this.phase = "matchover";
    this.recordResult();
    this.sfx(() => sound.crowd(0.7));
    this.emit();
  }

  rematch() {
    const cfg = { ...this.match.cfg, winScore: Math.min(this.match.cfg.winScore, 7) };
    if (this.mode === "bot") this.startBot(this.botLevel, cfg);
    else if (this.mode === "local") this.startLocal(cfg);
    else this.quitToMenu();
  }

  /* ================= online sync ================= */

  private onSnapshot(s: RoomSnapshot) {
    if (!this.room) return;
    this.lastSnapshot = s;
    const firstPeer = !this.room.peer && s.players.away;
    this.room.peer = s.players.away;
    this.room.status = s.status;
    if (firstPeer && this.phase === "lobby") {
      this.phase = "playing";
      const first = this.match.current;
      this.banner(
        this.room && first === this.room.role
          ? "COIN TOSS — YOU KICK OFF"
          : "COIN TOSS — OPPONENT KICKS OFF",
        2200,
      );
      this.sfx(() => sound.coin());
    }
    if (s.seq <= this.room.seq) {
      this.emit();
      return;
    }
    this.room.seq = s.seq;
    const fresh = s.chains.slice(this.room.processed);
    this.room.processed = s.chains.length;
    for (const c of fresh) {
      if (this.room && c.by === this.room.role) continue; // own chain already played optimistically
      this.replayChain(c);
    }
    this.emit();
  }

  /** Queue an opponent chain for edge-by-edge playback (validated on apply). */
  private replayChain(c: ChainRec) {
    for (let i = 0; i < c.e.length; i++) {
      if (this.match.status === "goal") {
        // server-side state lingers at goal until the next kick; align locally first
        this.match.resetAfterGoal();
        this.hideBall = false;
      }
      if (this.match.status !== "playing") break;
      this.remoteQueue.push({
        t: { x: c.e[i].x, y: c.e[i].y },
        endAfter: c.ended === true && i === c.e.length - 1,
      });
    }
  }

  private async submitOnlineChain(ended: boolean) {
    if (!this.room || this.chain.length === 0) return;
    const payload = [...this.chain];
    this.chain = [];
    try {
      const r = await submitChain(this.room.code, this.room.token, this.room.seq, payload, ended);
      this.room.seq = r.seq;
      this.channel?.setSeq(r.seq);
    } catch (e) {
      // desync safety net: pull authoritative state
      console.warn("submit failed, resyncing", e);
      this.channel?.tick();
    }
  }

  /* ================= input ================= */

  /** Phone-class viewport: bigger tap targets for fingertips. Set by GameCanvas. */
  phone = false;

  setPhone(v: boolean) {
    if (this.phone === v) return;
    this.phone = v;
    this.emit();
  }

  /** True while the ball is being dragged (the canvas suppresses scrolling then). */
  isDragging(): boolean {
    return this.dragState.active;
  }

  private grabRadius(): number {
    return this.phone ? 0.95 : 0.85;
  }

  private tapRadius(): number {
    return this.phone ? 0.8 : 0.62;
  }

  private magnetRadius(): number {
    return this.phone ? 1.08 : 0.95;
  }

  /** Nearest legal target within `radius`, or null. Nearest-wins (not
   *  first-in-list) so fat-finger taps between two nodes pick the intended one. */
  private nearestTarget(nx: number, ny: number, radius: number): Pt | null {
    let best: Pt | null = null;
    let bd = radius;
    for (const t of this.match.legalTargets()) {
      const d = Math.hypot(nx - t.x, ny - t.y);
      if (d < bd) {
        bd = d;
        best = t;
      }
    }
    return best;
  }

  pointerDown(nx: number, ny: number) {
    sound.unlock();
    if (!this.isHumanTurn() || this.anim || this.remoteQueue.length > 0) return;
    const b = this.match.ball;
    if (Math.hypot(nx - b.x, ny - b.y) < this.grabRadius()) {
      this.dragState = { active: true, x: nx, y: ny, target: null };
      return;
    }
    // tap on a hinted node commits instantly (nearest wins)
    const hit = this.nearestTarget(nx, ny, this.tapRadius());
    if (hit) this.commitEdge(hit, false);
  }

  pointerMove(nx: number, ny: number) {
    if (!this.dragState.active) return;
    this.dragState.x = nx;
    this.dragState.y = ny;
    this.dragState.target = this.nearestTarget(nx, ny, this.magnetRadius());
  }

  /** Cursor affordance for the canvas: grab over the ball, pointer over a legal node, default elsewhere. */
  cursorAt(nx: number, ny: number): "default" | "pointer" | "grab" | "grabbing" {
    if (this.dragState.active) return "grabbing";
    if (!this.isHumanTurn() || this.anim || this.remoteQueue.length > 0) return "default";
    const b = this.match.ball;
    if (Math.hypot(nx - b.x, ny - b.y) < this.grabRadius()) return "grab";
    if (this.nearestTarget(nx, ny, this.tapRadius())) return "pointer";
    return "default";
  }

  pointerUp() {
    const t = this.dragState.target;
    const wasActive = this.dragState.active;
    this.dragState = { active: false, x: 0, y: 0, target: null };
    if (wasActive && t) this.commitEdge(t, false);
  }

  /** Player chooses to stop after drawing line 1 or 2; possession changes now. */
  endTurn() {
    if (!this.isHumanTurn() || this.anim || this.remoteQueue.length > 0 || !this.match.canEndTurn()) return;
    this.passActiveTurn(true);
  }

  /** Shared voluntary pass path for humans and bots. */
  private passActiveTurn(ended: boolean) {
    let ev: MoveEvent;
    try {
      ev = this.match.endTurn();
    } catch {
      this.sfx(() => sound.deny());
      return;
    }
    if (ev.kind === "penalty") {
      this.handlePenalty(ev, ev.from, ended);
    } else if (ev.kind === "finished") {
      this.phase = "matchover";
      this.recordResult();
      this.finishTurn(ended);
    } else {
      this.finishTurn(ended);
    }
  }

  /* ================= core move flow ================= */

  /** Dust/spray colour for impacts, matched to the active arena surface. */
  private burstColor(): string {
    switch (this.arena) {
      case "winter":
        return "rgba(240,248,255,0.95)"; // powder snow
      case "paper":
        return "rgba(58,77,143,0.9)"; // ink spatter
      case "beach":
        return "rgba(224,196,138,0.9)"; // sand dust
      default:
        return "rgba(245,241,230,0.85)"; // chalk dust
    }
  }

  private commitEdge(target: Pt, byBot: boolean) {
    if (this.match.status !== "playing") return;
    if (this.chain.length === 0 && !byBot && this.mode !== "online") {
      this.undoStack.push(serialize(this.match));
    }
    const mover = this.match.current;
    let ev: MoveEvent;
    try {
      ev = this.match.doEdge(target);
    } catch {
      this.sfx(() => sound.deny());
      return;
    }
    this.lastEvent = { ev, mover };
    this.anim = {
      type: "step",
      ax: ev.from.x,
      ay: ev.from.y,
      bx: ev.to.x,
      by: ev.to.y,
      t0: performance.now(),
      dur: this.mode === "demo" ? 300 : STEP_MS,
    };
    this.chain.push({ x: target.x, y: target.y });
    this.sfx(() => sound.kick(ev.bounce ? 0.75 : 1));
    const burstColor = this.burstColor();
    this.particles.burst(ev.from.x, ev.from.y, 4, burstColor);
    this.emit();
  }

  /** Called when the step animation lands. */
  private onArrival() {
    const m = this.match;
    const le = this.lastEvent;
    this.impactAt = performance.now();
    if (!le) return;
    let ev = le.ev;
    const mover = le.mover;
    const at = m.ball;
    const burstColor = this.burstColor();

    // Opponent's final queued edge carried an explicit voluntary pass.
    if (ev.kind === "move" && le.endAfter && m.current === mover) {
      ev = m.endTurn();
    }

    if (ev.kind === "move") {
      if (ev.bounce) {
        this.sfx(() => sound.bounce(this.chain.length));
        this.particles.burst(at.x, at.y, 7, burstColor);
        this.shake.add(0.08);
      }
      // First / second line: possession stays with the player. Human sees the
      // End Turn action; bots continue automatically from tick().
      this.emit();
      return;
    }
    if (ev.kind === "pass") {
      if (ev.bounce) {
        this.sfx(() => sound.bounce(this.chain.length));
        this.particles.burst(at.x, at.y, 7, burstColor);
      }
      this.finishTurn(le.endAfter === true);
      return;
    }
    if (ev.kind === "penalty") {
      this.handlePenalty(ev, at, le.endAfter === true);
      return;
    }
    if (ev.kind === "goal" || ev.kind === "finished") {
      const scorer = ev.scorer ?? 0;
      const own = scorer !== mover; // the mover dived into the goal they defend
      this.phase = "goal";
      this.hideBall = true;
      this.finishTurn(false); // flush the scoring chain (online submit / bot handover)
      const mouthCenter = goalMouths(m.cfg)[scorer][1];
      this.particles.goalConfetti(mouthCenter.x, mouthCenter.y + (scorer === 0 ? 0.6 : -0.6));
      this.shake.add(0.5);
      this.sfx(() => sound.whistle(2));
      this.sfx(() => sound.crowd(1));
      void own;
      if (ev.kind === "finished") {
        this.after(GOAL_HOLD_MS, () => {
          this.phase = "matchover";
          this.recordResult();
          this.emit();
        });
      } else {
        this.after(GOAL_HOLD_MS, () => {
          m.resetAfterGoal();
          this.undoStack = [];
          this.hideBall = false;
          this.impactAt = performance.now();
          this.phase = "playing";
          this.particles.burst(m.ball.x, m.ball.y, 16, burstColor);
          this.banner("KICKOFF", 1200);
          this.emit();
        });
      }
      this.emit();
    }
  }

  private handlePenalty(ev: MoveEvent, at: Pt, ended: boolean) {
    const m = this.match;
    const burstColor = this.burstColor();
    this.banner("DEAD END — PENALTY KICK", 2200);
    this.sfx(() => sound.whistle(1));
    this.shake.add(0.15);
    const stuck = ev.stuckAt ?? at;
    // No human or bot starts a move before the penalty flight has landed.
    this.holdUntil = performance.now() + 420 + FLIGHT_MS;
    this.finishTurn(ended);
    this.after(420, () => {
      this.anim = { type: "flight", ax: stuck.x, ay: stuck.y, bx: m.ball.x, by: m.ball.y, t0: performance.now(), dur: FLIGHT_MS };
      this.emit();
    });
    this.after(420 + FLIGHT_MS, () => {
      this.particles.burst(m.ball.x, m.ball.y, 12, burstColor);
      this.impactAt = performance.now();
      this.emit();
    });
  }

  private finishTurn(ended: boolean) {
    // a completed turn: online → ship the chain; bots → schedule reply
    if (this.mode === "online" && this.chain.length > 0 && this.room) {
      void this.submitOnlineChain(ended);
    }
    this.chain = [];
    this.sfx(() => sound.ui());
    this.emit();
    this.maybeBot();
  }

  /* ================= bots ================= */

  private maybeBot() {
    // This is called every frame. Guard BEFORE scheduling: the old version
    // queued a 420ms callback on every frame, then ran a ~520ms search in rAF.
    if (this.botTask || this.thinking || !this.isBotTurn() || this.anim || performance.now() < this.botRetryAt) return;
    const snapshot = serialize(this.match);
    const task: BotTask = {
      generation: ++this.botGeneration,
      match: this.match,
      mode: this.mode,
      level: this.mode === "demo" ? "easy" : this.botLevel,
      position: JSON.stringify(snapshot),
      // Search and the small presentation delay run concurrently, not in series.
      notBefore: performance.now() + (this.mode === "demo" ? 650 : 420),
      ready: false,
      target: null,
    };
    this.botTask = task;
    this.thinking = true;
    this.emit();
    void this.botSearch.choose(snapshot, task.level).then(
      (target) => {
        if (this.botTask !== task || task.generation !== this.botGeneration) return;
        task.target = target;
        task.ready = true; // actual move is applied by the next animation frame
      },
      (error: unknown) => {
        if (this.botTask !== task || task.generation !== this.botGeneration) return;
        this.botTask = null;
        this.thinking = false;
        this.botRetryAt = performance.now() + 2_000;
        if (!(error instanceof Error && error.name === "AbortError")) {
          console.warn("AI calculation unavailable; retrying asynchronously", error);
          if (this.mode === "bot") this.banner("Не удалось рассчитать ход. Повторяем…", 1800);
        }
        this.emit();
      },
    );
  }

  /** One completed, still-relevant answer per position. Never applies a move
   *  from a match that was restarted, undone, forfeited or left for the menu. */
  private applyBotResult(now: number) {
    const task = this.botTask;
    if (!task || !task.ready || now < task.notBefore || this.anim) return;
    if (
      task.generation !== this.botGeneration || task.match !== this.match ||
      task.mode !== this.mode || !this.isBotTurn() ||
      (this.mode === "bot" && task.level !== this.botLevel) ||
      task.position !== JSON.stringify(serialize(this.match))
    ) {
      this.cancelBotSearch();
      this.emit();
      return;
    }
    this.botTask = null;
    this.thinking = false;
    if (task.target) {
      if (this.match.isLegal(task.target)) this.commitEdge(task.target, true);
      else {
        this.botRetryAt = performance.now() + 500;
        this.emit();
      }
    } else if (this.match.canEndTurn()) {
      this.passActiveTurn(true);
    } else {
      // Only an unavoidable forced line remains (e.g. Easy at its own goal).
      const forced = this.match.legalTargets()[0];
      if (forced) this.commitEdge(forced, true);
      else this.emit();
    }
  }

  private cancelBotSearch() {
    this.botGeneration++;
    this.botTask = null;
    this.botSearch.cancel();
    this.thinking = false;
    this.botRetryAt = 0;
  }

  /* ================= undo ================= */

  undo() {
    if (this.mode === "online" || this.anim || this.phase !== "playing") return;
    if (this.undoStack.length === 0) return;
    this.cancelBotSearch();
    this.timed = [];
    this.lastEvent = null;
    this.bannerTxt = null;
    if (this.mode === "local") {
      const snap = this.undoStack.pop()!;
      this.match = deserialize(snap);
      this.chain = [];
    } else {
      // bot mode: roll back to the last human kickoff
      while (this.undoStack.length > 0) {
        const snap = this.undoStack.pop()!;
        this.match = deserialize(snap);
        if (this.match.current === 0) break;
      }
      this.chain = [];
    }
    this.hideBall = false;
    this.impactAt = performance.now();
    this.sfx(() => sound.ui());
    this.emit();
  }

  /* ================= frame pump ================= */

  tick(now: number, dt: number) {
    // Attract-mode screensaver: only let the demo bots start after the full
    // idle delay has passed without any pointer/key activity.
    if (this.mode === "demo" && !this.attractActive && now - this.idleAt >= Director.ATTRACT_DELAY_MS) {
      this.attractActive = true;
    }

    this.particles.update(dt);
    this.shake.update(dt);

    // run scheduled actions
    for (let i = this.timed.length - 1; i >= 0; i--) {
      if (now >= this.timed[i].at) {
        const fn = this.timed[i].fn;
        this.timed.splice(i, 1);
        fn();
      }
    }

    // feed remote queue
    if (!this.anim && this.remoteQueue.length > 0 && this.match.status === "playing" && this.phase !== "goal") {
      const queued = this.remoteQueue.shift()!;
      const mover = this.match.current;
      try {
        const ev = this.match.doEdge(queued.t);
        this.lastEvent = { ev, mover, endAfter: queued.endAfter };
        this.anim = { type: "step", ax: ev.from.x, ay: ev.from.y, bx: ev.to.x, by: ev.to.y, t0: now, dur: STEP_MS };
        this.sfx(() => sound.kick(0.9));
      } catch {
        // desync: hard-align to the authoritative snapshot
        this.remoteQueue = [];
        if (this.lastSnapshot) {
          this.match = deserialize(this.lastSnapshot.state);
          this.room && (this.room.processed = this.lastSnapshot.chains.length);
          this.hideBall = false;
          this.emit();
        }
      }
      this.emit();
    }

    // advance current animation
    if (this.anim) {
      const a = this.anim;
      const k = Math.min(1, (now - a.t0) / a.dur);
      if (a.type === "step") {
        // spin proportional to travel
        const dx = a.bx - a.ax;
        const dy = a.by - a.ay;
        const dist = Math.hypot(dx, dy);
        this.ballRot.x += (dy / Math.max(dist, 0.001)) * dist * 4.4 * (dt * 1000) / a.dur;
        this.ballRot.y += (dx / Math.max(dist, 0.001)) * dist * 4.4 * (dt * 1000) / a.dur;
        if (Math.random() < 0.7) {
          const px = a.ax + dx * k;
          const py = a.ay + dy * k;
          this.particles.trail(px, py, dx / Math.max(dist, 0.001), dy / Math.max(dist, 0.001), 1, this.arena);
        }
      } else if (a.type === "flight") {
        this.ballRot.x += dt * 7;
      }
      if (k >= 1) {
        const finished = this.anim;
        this.anim = null;
        if (finished.type === "step") this.onArrival();
        if (finished.type === "flight") this.impactAt = now;
      }
    }

    // Worker replies are tiny DTOs; applying one is cheap and frame-aligned.
    this.applyBotResult(now);
    // Multi-line turns / forced bounces schedule one new job only after landing.
    if (!this.anim && this.isBotTurn()) this.maybeBot();
  }

  /* ================= view ================= */

  view(): SceneView {
    const now = performance.now();
    let bx = this.match.ball.x;
    let by = this.match.ball.y;
    let bz = 0;
    let scale = 1;
    if (this.anim) {
      const a = this.anim;
      const k = Math.min(1, Math.max(0, (now - a.t0) / a.dur));
      if (a.type === "step") {
        const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
        bx = a.ax + (a.bx - a.ax) * e;
        by = a.ay + (a.by - a.ay) * e;
        bz = Math.sin(Math.PI * k) * 0.1;
      } else if (a.type === "flight") {
        const e = 1 - Math.pow(1 - k, 2.2);
        bx = a.ax + (a.bx - a.ax) * e;
        by = a.ay + (a.by - a.ay) * e;
        bz = Math.sin(Math.PI * k) * 2.3;
      } else if (a.type === "sink") {
        bx = a.x;
        by = a.y;
        scale = Math.max(0.05, 1 - k * 1.1);
      }
    }
    const impulse = Math.max(0, 1 - (now - this.impactAt) / 260);
    const interactive = this.isHumanTurn() && !this.anim && this.remoteQueue.length === 0;
    return {
      edges: this.match.edges,
      ball: {
        x: bx,
        y: by,
        z: bz,
        scale: this.hideBall ? 0 : scale,
        squash: impulse * 0.9 * Math.abs(Math.cos((now - this.impactAt) / 45)),
        rotX: this.ballRot.x,
        rotY: this.ballRot.y,
        visible: !this.hideBall,
      },
      current: this.match.current,
      hints: interactive ? this.match.legalTargets() : [],
      interactive,
      drag: this.dragState,
      tSec: now / 1000,
    };
  }

  toggleSound() {
    sound.unlock();
    sound.setMuted(!sound.muted);
    this.emit();
  }

  private resetPresentation() {
    this.cancelBotSearch();
    this.anim = null;
    this.timed = [];
    this.lastEvent = null;
    this.holdUntil = 0;
    this.tossState = null;
    this.bannerTxt = null;
    this.dragState = { active: false, x: 0, y: 0, target: null };
    this.remoteQueue = [];
    this.undoStack = [];
    this.chain = [];
    this.hideBall = false;
    this.ballRot = { x: 0.5, y: 0.3 };
    this.particles.clear();
  }

  private recordResult() {
    if (this.recorded || this.mode === "demo" || this.mode === "online") return;
    this.recorded = true;
    const body = {
      mode: this.mode,
      difficulty: this.mode === "bot" ? this.botLevel : null,
      scoreHome: this.match.scores[0],
      scoreAway: this.match.scores[1],
      winner: this.match.winner,
      moves: this.match.moveCount,
      winScore: this.match.cfg.winScore,
    };
    void fetch("/api/matches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => undefined);
  }
}
