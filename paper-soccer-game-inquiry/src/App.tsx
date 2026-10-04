"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  Bot,
  Copy,
  Palette,
  Radio,
  RotateCcw,
  Share2,
  SkipForward,
  Users,
  Volume2,
  VolumeX,
  Wifi,
  X,
} from "lucide-react";
import GameCanvas from "./components/GameCanvas";
import { Director, type HudState } from "./game/director";
import { ARENAS } from "./game/arenas";
import { buildField, computeLayout } from "./game/field";
import type { BotLevel } from "./game/ai";
import { PITCH_KINDS, isPhoneViewport, pitchShape, type PitchKind } from "./game/presets";
import { sound } from "./game/sound";
import { recallSession } from "./game/net";
import { storageGetJSON, storageSetJSON } from "./game/storage";
import { installPreviewApi } from "./game/api";
import type { MatchConfig } from "./game/engine";
import { TEAM_SWATCHES, applyTeamColors, colorOf, loadTeamColors, rgbaOf, saveTeamColors } from "./game/teams";
import { cn } from "./utils/cn";

// Node-процесса в этой сборке нет: сервер комнат и /api/ai/move монтируем во вкладку.
installPreviewApi();

type Mode3 = "bot" | "local" | "online";

/** Подписи классов бота — только для UI: сами настройки бота живут в shared/ai. */
const BOT_LABELS: Record<BotLevel, string> = {
  easy: "Новичок",
  medium: "Любитель",
  hard: "Профессионал",
};

/** Короткие названия стадионов для карточек меню (id остаются из arenas.ts). */
const ARENA_LABELS: Record<string, string> = {
  stadium: "Стандартный",
  night: "Ночной",
  winter: "Зимний",
  beach: "Пляжный",
  paper: "Тетрадь",
};

interface BotStat {
  wins: number;
  losses: number;
}
type BotStats = Partial<Record<BotLevel, BotStat>>;

export default function Page() {
  const director = useMemo(() => {
    const d = new Director();
    const saved = storageGetJSON<{ arena?: string }>("ps.prefs");
    if (saved?.arena) d.setArena(saved.arena);
    return d;
  }, []);
  const hud = useHud(director);

  const [tab, setTab] = useState<Mode3>("bot");
  const [level, setLevel] = useState<BotLevel>("medium");
  const [kind, setKind] = useState<PitchKind>("classic");
  const [winScore, setWinScore] = useState(3);
  const [names, setNames] = useState<[string, string]>(["Я", "ИИ"]);
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [rules, setRules] = useState(false);
  const [copied, setCopied] = useState(false);
  const [stats, setStats] = useState<BotStats>(() => storageGetJSON<BotStats>("ps.botStats") ?? {});
  /** Цвета команд: пишутся в общий TEAM-объект, их подхватывают чернила, узлы и флаги. */
  const [colors, setColors] = useState<[string, string]>(() => loadTeamColors());

  useEffect(() => {
    applyTeamColors(colors[0], colors[1]);
    saveTeamColors(colors);
  }, [colors]);

  /** Выбор цвета: если такой уже у соперника — команды меняются цветами. */
  const pickColor = (side: 0 | 1, hex: string) => {
    sound.unlock();
    sound.ui();
    setColors((prev) => {
      const next: [string, string] = [prev[0], prev[1]];
      if (prev[1 - side] === hex) next[1 - side] = prev[side];
      next[side] = hex;
      return next;
    });
  };

  // Форма листа зависит от устройства: превью арен должны показывать ровно то
  // поле, которое начнётся в матче, поэтому следим за viewport вживую.
  const [{ phone, landscape }, setViewport] = useState(() => ({
    phone: typeof window !== "undefined" && isPhoneViewport(window.innerWidth, window.innerHeight),
    landscape: typeof window !== "undefined" && window.innerWidth > window.innerHeight,
  }));
  useEffect(() => {
    const sync = () =>
      setViewport({
        phone: isPhoneViewport(window.innerWidth, window.innerHeight),
        landscape: window.innerWidth > window.innerHeight,
      });
    window.addEventListener("resize", sync);
    window.addEventListener("orientationchange", sync);
    return () => {
      window.removeEventListener("resize", sync);
      window.removeEventListener("orientationchange", sync);
    };
  }, []);
  const hasSession = !!recallSession();
  const shape = pitchShape(kind, phone, landscape);
  // Превью арен не зависит от размера будущего матча: всегда используется
  // компактный «Спринт», где фактура, ворота и разметка читаются лучше всего.
  const previewShape = pitchShape("sprint", phone, landscape);

  useEffect(() => storageSetJSON("ps.prefs", { arena: hud.arena }), [hud.arena]);

  /* история против каждого класса — как в оригинале, считывается в меню */
  const lastOver = useRef(-1);
  useEffect(() => {
    if (hud.phase !== "matchover" || hud.mode !== "bot") return;
    if (lastOver.current === hud.moveCount) return;
    lastOver.current = hud.moveCount;
    const key = hud.botLevel;
    const prev = stats[key] ?? { wins: 0, losses: 0 };
    const won = hud.winner === 0;
    if (hud.winner === null) return;
    const next = { ...stats, [key]: { wins: prev.wins + (won ? 1 : 0), losses: prev.losses + (won ? 0 : 1) } };
    setStats(next);
    storageSetJSON("ps.botStats", next);
  }, [hud, stats]);

  const cfg = useCallback((): MatchConfig => {
    const s = pitchShape(kind, phone, landscape);
    return { size: s.cols, cols: s.cols, rows: s.rows, winScore };
  }, [kind, phone, landscape, winScore]);

  const go = async (next: Mode3) => {
    sound.unlock();
    setErr(null);
    director.setNames(names[0], names[1]);
    try {
      if (next === "bot") director.startBot(level, cfg(), names);
      else if (next === "local") director.startLocal(cfg(), names);
      else if (code.length >= 4) await director.joinOnline(code);
      else await director.hostOnline(cfg());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  /* «?room=КОД» сразу зовёт в комнату */
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const room = params.get("room");
    if (!room) return;
    setTab("online");
    setCode(room.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.tagName === "INPUT") return;
      const k = e.key.toLowerCase();
      if (k === " " || k === "enter") {
        e.preventDefault();
        director.endTurn();
      } else if (k === "z") director.undo();
      else if (k === "r" && hud.phase !== "menu") director.rematch();
      else if (k === "escape") (rules ? setRules(false) : director.quitToMenu());
      else if (k === "m") director.toggleSound();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [director, rules, hud.phase]);

  const botStat = (l: BotLevel) => stats[l];

  return (
    <main className="relative h-full w-full overflow-hidden bg-[#0a0f0a] text-[#f0ead6] select-none noise">
      <GameCanvas director={director} />

      {/* top bar: 3 equal columns → scoreboard is dead-centre regardless of button widths */}
      {hud.phase !== "menu" && (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex flex-col items-center gap-1 px-3 pt-2 sm:pt-3">
          <div className="glass pointer-events-auto flex items-center gap-3 rounded-2xl px-4 py-1.5 sm:gap-5 sm:px-6 sm:py-2">
            <span
              className="display text-[30px] leading-none tabular-nums sm:text-[42px]"
              style={{ color: colors[0], textShadow: `0 0 22px ${rgbaOf(colors[0], 0.45)}` }}
            >
              {hud.scores[0]}
            </span>
            <span className="mono text-[9.5px] tracking-[0.18em] text-[#f0ead6]/35 uppercase">до {hud.cfg.winScore}</span>
            <span
              className="display text-[30px] leading-none tabular-nums sm:text-[42px]"
              style={{ color: colors[1], textShadow: `0 0 22px ${rgbaOf(colors[1], 0.45)}` }}
            >
              {hud.scores[1]}
            </span>
          </div>
          {/* названия команд — под счётом, берутся из главного меню */}
          <div className="flex items-start gap-4 sm:gap-8">
            <TeamTag hud={hud} side={0} color={colors[0]} />
            <TeamTag hud={hud} side={1} color={colors[1]} />
          </div>
        </div>
      )}

      {/* вторичные действия в верхней полосе; «Пас» живёт у большого пальца */}
      {hud.phase !== "menu" && (
        <div className="absolute top-2 right-2 z-30 flex items-center gap-1.5 sm:top-3 sm:right-4">
          {hud.mode !== "online" && (
            <TopBtn label="отменить ход" onClick={() => director.undo()} disabled={!hud.canUndo}>
              <RotateCcw size={14} />
            </TopBtn>
          )}
          <TopBtn label={hud.muted ? "включить звук" : "выключить звук"} onClick={() => director.toggleSound()}>
            {hud.muted ? <VolumeX size={14} className="opacity-45" /> : <Volume2 size={14} />}
          </TopBtn>
          <TopBtn label="в меню" onClick={() => director.quitToMenu()}>
            <X size={14} />
          </TopBtn>
        </div>
      )}

      {hud.banner && (
        <div className="pointer-events-none absolute inset-x-0 top-[22%] z-20 flex justify-center px-6">
          <p key={hud.banner} className="display anim-rise rounded-xl border border-[#f0ead6]/12 bg-[#0a0f0a]/80 px-5 py-2 text-center text-[19px] tracking-[0.14em] backdrop-blur-md sm:text-[26px]">
            {hud.banner}
          </p>
        </div>
      )}

      {/* Desktop/tablet Pass stays where it was: centred below the pitch. */}
      {hud.canEndTurn && !hud.phone && (
        <div className="absolute inset-x-0 bottom-4 z-20 flex justify-center sm:bottom-6">
          <button
            onClick={() => {
              sound.unlock();
              director.endTurn();
            }}
            className="group flex items-center gap-2 rounded-xl border border-[#9fe870]/40 bg-[#0a0f0a]/80 px-4 py-2 text-[12.5px] font-bold tracking-[0.08em] text-[#9fe870] uppercase backdrop-blur-md transition hover:border-[#9fe870]/80 hover:bg-[#9fe870]/10 active:scale-[0.98]"
          >
            <SkipForward size={15} className="transition-transform group-hover:translate-x-0.5" /> пас / конец хода
          </button>
        </div>
      )}

      {/* coin toss overlay */}
      {hud.toss && <CoinToss hud={hud} colors={colors} />}
      {hud.phase === "goal" && hud.goalFlash && (
        <div className="pointer-events-none absolute inset-0 z-30 flex flex-col items-center justify-center">
          <p className="display anim-goal text-[76px] leading-none text-[#9fe870] drop-shadow-[0_0_40px_rgba(159,232,112,.55)] sm:text-[132px]">ГОЛ!</p>
          <p className="display mt-1 text-[16px] tracking-[0.2em] text-[#f0ead6]/85 sm:text-[24px]">
            {labelSide(hud, hud.goalFlash.scorer)} ЗАБИВАЕТ
          </p>
        </div>
      )}
      {hud.phase === "lobby" && <LobbyOverlay hud={hud} director={director} copied={copied} setCopied={setCopied} />}
      {hud.phase === "matchover" && <MatchOverOverlay hud={hud} director={director} colors={colors} />}

      {/* меню живёт, пока не выбран режим: attract-матч играет ПОД ним, как в оригинале */}
      {hud.mode === "demo" && (
        <div className="absolute inset-0 z-40 overflow-y-auto scroll-thin bg-[#050805]/78 backdrop-blur-[3px]">
          <div className="mx-auto flex min-h-full w-full max-w-[682px] flex-col justify-center gap-3 p-4 sm:p-7">
            <header className="anim-rise flex items-end justify-between gap-3 px-1 pb-0.5">
              <h1 className="display text-[40px] leading-[0.86] sm:text-[55px]">
                БУМАЖНЫЙ <span className="text-stroke">ФУТБОЛ</span>
              </h1>
              <button
                onClick={() => setRules(true)}
                className="mb-1 flex shrink-0 items-center gap-2 rounded-lg border border-[#f0ead6]/12 px-3.5 py-2.5 text-[13px] font-semibold text-[#f0ead6]/75 transition hover:border-[#9fe870]/50 hover:text-[#9fe870]"
              >
                <BookOpen size={15} /> правила
              </button>
            </header>

            {/* настройки игры — одна колонка по центру */}
            <section className="anim-rise-1 space-y-3">
              <ModeCard
                active={tab === "bot"}
                onPick={() => {
                  setTab("bot");
                  // дефолты других режимов возвращаем к паре «Я / ИИ»
                  setNames((n) =>
                    (n[0] === "Синие" && n[1] === "Красные") || (n[0] === "Я" && n[1] === "Соперник") ? ["Я", "ИИ"] : n,
                  );
                }}
                icon={<Bot size={15} />}
                title="Против бота"
              >
                <div className="mt-3 flex gap-1.5">
                  {(["easy", "medium", "hard"] as BotLevel[]).map((l) => (
                    <button
                      key={l}
                      onClick={() => {
                        setLevel(l);
                        director.botLevel = l;
                      }}
                      className={cn(
                        "flex-1 rounded-lg border px-2 py-2 text-[12.5px] font-bold transition",
                        level === l ? "border-[#9fe870]/70 bg-[#9fe870]/12 text-[#9fe870]" : "border-[#f0ead6]/10 text-[#f0ead6]/60 hover:border-[#f0ead6]/30",
                      )}
                    >
                      {BOT_LABELS[l]}
                    </button>
                  ))}
                </div>
                {botStat(level) && (
                  <p className="mono mt-1.5 text-[11px] text-[#f0ead6]/45">
                    история: {botStat(level)!.wins}W — {botStat(level)!.losses}L
                  </p>
                )}
                <TeamSetup
                  names={names}
                  colors={colors}
                  onName={(side, v) => setNames(side === 0 ? [v, names[1]] : [names[0], v])}
                  onColor={pickColor}
                />
              </ModeCard>

              <ModeCard
                active={tab === "local"}
                onPick={() => {
                  setTab("local");
                  // для игры вдвоём «Я / ИИ» не подходит — подставляем стороны поля
                  setNames((n) =>
                    (n[0] === "Я" && n[1] === "ИИ") || (n[0] === "Я" && n[1] === "Соперник") ? ["Синие", "Красные"] : n,
                  );
                }}
                icon={<Users size={15} />}
                title="Двое за экраном"
              >
                <p className="mt-2 text-[13px] leading-relaxed text-[#f0ead6]/60">
                  Одно устройство на двоих: ходите по очереди. Кто начинает — решит жребий.
                </p>
                <TeamSetup
                  names={names}
                  colors={colors}
                  onName={(side: 0 | 1, v: string) => setNames(side === 0 ? [v, names[1]] : [names[0], v])}
                  onColor={pickColor}
                />
              </ModeCard>

              <ModeCard
                active={tab === "online"}
                onPick={() => {
                  setTab("online");
                  // в сети соперник — человек, а не бот
                  setNames((n) => (n[0] === "Я" && n[1] === "ИИ" ? ["Я", "Соперник"] : n));
                }}
                icon={<Wifi size={15} />}
                title="Онлайн PvP"
              >
                <div className="mt-3 flex gap-2">
                  <input
                    value={code}
                    onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5))}
                    placeholder="КОД"
                    className="mono w-0 flex-1 rounded-lg border border-[#f0ead6]/10 bg-black/40 px-3 py-2 text-sm tracking-[0.3em] text-[#f0ead6] outline-none placeholder:text-[#f0ead6]/25 focus:border-[#5ad2ff]/60"
                  />
                  {hasSession && (
                    <button onClick={() => director.resumeSession()} className="rounded-lg border border-[#f0ead6]/12 px-3 py-2 text-[11.5px] font-bold text-[#f0ead6]/70 transition hover:border-[#5ad2ff]/60">
                      вернуться
                    </button>
                  )}
                </div>
                <p className="mt-2 text-[13px] leading-relaxed text-[#f0ead6]/60">
                  Оставь код пустым — создадим комнату и покажем код, скинь его другу. Есть чужой код? Впиши и подключайся.
                </p>
                <TeamSetup
                  names={names}
                  colors={colors}
                  onName={(side: 0 | 1, v: string) => setNames(side === 0 ? [v, names[1]] : [names[0], v])}
                  onColor={pickColor}
                />
              </ModeCard>

              {/* picker стадионов: живые миниатюры, запечённые тем же buildField */}
              <div className="glass rounded-xl p-3.5">
                <div className="mb-2.5 flex items-baseline justify-between gap-2">
                  <p className="mono flex items-center gap-1.5 text-[11px] tracking-[0.2em] text-[#f0ead6]/40 uppercase">
                    <Palette size={12} className="text-[#9fe870]/70" /> стадион
                  </p>
                  <p className="mono text-[11px] tracking-[0.12em] text-[#f0ead6]/35 uppercase">
                    лист {shape.cols}×{shape.rows}
                  </p>
                </div>
                <div className="grid grid-cols-5 gap-2">
                  {ARENAS.map((a) => {
                    const active = a.id === hud.arena;
                    return (
                      <button
                        key={a.id}
                        onClick={() => {
                          sound.unlock();
                          sound.ui();
                          director.setArena(a.id);
                        }}
                        aria-pressed={active}
                        className={cn(
                          "group relative flex min-w-0 flex-col items-center gap-1.5 rounded-lg border p-1",
                          active
                            ? "border-[#9fe870]/70 bg-[#9fe870]/10 shadow-[0_0_0_1px_rgba(159,232,112,.22),0_12px_28px_-18px_rgba(159,232,112,.7)]"
                            : "border-[#f0ead6]/10 hover:border-[#f0ead6]/40",
                        )}
                      >
                        <ArenaPreview arenaId={a.id} cols={previewShape.cols} rows={previewShape.rows} active={active} />
                        <span className="display w-full truncate text-center text-[10px] leading-tight">
                          {ARENA_LABELS[a.id] ?? a.name}
                        </span>
                        <span
                          className={cn(
                            "absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full bg-[#9fe870] shadow-[0_0_9px_#9fe870] transition-transform duration-300",
                            active ? "scale-100" : "scale-0",
                          )}
                        />
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* match config */}
              <div className="glass flex flex-wrap items-center gap-x-6 gap-y-3.5 rounded-xl p-3.5">
                <div className="flex items-center gap-2">
                  <span className="mono text-[11px] tracking-[0.2em] text-[#f0ead6]/40 uppercase">поле:</span>
                  {PITCH_KINDS.filter((k) => !phone || k.kind !== "marathon").map((k) => {
                    const sh = pitchShape(k.kind, phone, landscape);
                    return (
                      <button
                        key={k.kind}
                        onClick={() => {
                          sound.unlock();
                          sound.ui();
                          setKind(k.kind);
                        }}
                        className={cn("rounded-lg border px-3 py-2 text-left transition", kind === k.kind ? "border-[#9fe870]/70 bg-[#9fe870]/10 text-[#9fe870]" : "border-[#f0ead6]/10 text-[#f0ead6]/60 hover:border-[#f0ead6]/30")}
                      >
                        <span className="display block text-[13px] leading-none">{k.hint}</span>
                        <span className="mono mt-1 block text-[10.5px] opacity-70">
                          {sh.cols}×{sh.rows}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <div className="flex items-center gap-2">
                  <span className="mono text-[11px] tracking-[0.2em] text-[#f0ead6]/40 uppercase">матч до:</span>
                  {[1, 3, 5].map((n) => (
                    <button
                      key={n}
                      onClick={() => {
                        sound.unlock();
                        sound.ui();
                        setWinScore(n);
                      }}
                      className={cn("mono h-8 w-8 rounded-lg border text-[13px] transition", winScore === n ? "border-[#ff6a2a]/70 bg-[#ff6a2a]/12 text-[#ff6a2a]" : "border-[#f0ead6]/10 text-[#f0ead6]/55 hover:border-[#f0ead6]/30")}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </div>

              {err && <p className="mono rounded-lg border border-[#ff3366]/40 bg-[#ff3366]/10 px-3.5 py-2.5 text-[12.5px] text-[#ff3366]">{err}</p>}

              <button
                onClick={() => void go(tab)}
                className="display w-full rounded-xl bg-[#9fe870] px-4 py-4 text-[21px] tracking-[0.1em] text-[#050805] shadow-[0_18px_60px_-18px_rgba(159,232,112,.75)] transition hover:brightness-105 active:scale-[.99]"
              >
                {tab === "online" && code.length >= 4 ? "войти по коду" : tab === "online" ? "создать комнату" : "начать матч"}
              </button>
            </section>
          </div>
        </div>
      )}

      {rules && <RulesModal onClose={() => setRules(false)} />}
    </main>
  );
}

/* ================= HUD pieces ================= */

function useHud(director: Director): HudState {
  const [hud, setHud] = useState(() => director.hud());
  useEffect(() => director.subscribe(setHud), [director]);
  return hud;
}

function labelSide(hud: HudState, side: 0 | 1): string {
  const name = hud.names[side]?.trim();
  return name && name.length > 0 ? name : side === 0 ? "Синие" : "Красные";
}

/** Название команды под счётом + три пипса линий текущего хода. */
function TeamTag({ hud, side, color }: { hud: HudState; side: 0 | 1; color: string }) {
  const active = hud.current === side && hud.phase === "playing";
  return (
    <div className="flex min-w-[92px] flex-col items-center gap-1 sm:min-w-[132px]">
      <span
        className="display max-w-full truncate text-[12px] leading-none tracking-[0.04em] transition-all duration-300 sm:text-[16px]"
        style={{ color, opacity: active ? 1 : 0.5, textShadow: active ? `0 0 18px ${color}55` : "none" }}
      >
        {labelSide(hud, side)}
      </span>
      <span className="flex gap-1">
        {[0, 1, 2].map((i) => (
          <i
            key={i}
            className="h-1 w-4 rounded-full transition-all duration-200 sm:w-6"
            style={{
              background: active && i < hud.turnMoves ? color : "rgba(240,234,214,.16)",
              boxShadow: active && i < hud.turnMoves ? `0 0 10px ${color}` : "none",
            }}
          />
        ))}
      </span>
    </div>
  );
}

function TopBtn({ children, label, onClick, disabled }: { children: React.ReactNode; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="glass rounded-lg p-2 text-[#f0ead6]/70 transition hover:text-[#9fe870] disabled:opacity-25"
    >
      {children}
    </button>
  );
}

/** Жеребьёвка: золотая монета с гуртом, чеканкой мяча и двумя сторонами
 *  в цветах команд. 5 оборотов — остаётся сторона первой команды,
 *  5.5 — второй; тень, свечение и искры живут в такт подбросу. */
function CoinToss({ hud, colors }: { hud: HudState; colors: [string, string] }) {
  const winner = hud.toss?.winner ?? 0;
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setSettled(true), 1250);
    return () => clearTimeout(id);
  }, []);
  const end = winner === 0 ? "1800deg" : "1980deg";
  return (
    <div className="pointer-events-none absolute inset-0 z-40 flex flex-col items-center justify-center bg-[#050805]/62">
      <p className="mono text-[10px] tracking-[0.34em] text-[#f0ead6]/55 uppercase">жеребьёвка</p>

      <div className="coin-stage mt-4">
        {/* Нейтральное свечение во время подброса — цвет выпавшей стороны
            не выдаётся, пока монета не приземлилась. */}
        <div className="coin-glow" style={{ background: "radial-gradient(circle, rgba(255,246,224,0.30), transparent 68%)" }} />
        {/* Цвет выпавшей стороны проявляется только после приземления монеты. */}
        <div
          className="coin-glow"
          style={{
            background: `radial-gradient(circle, ${rgbaOf(colors[winner], 0.5)}, transparent 68%)`,
            opacity: settled ? 1 : 0,
            transition: "opacity 0.6s ease 0.05s",
            animation: "none",
          }}
        />
        <div className="coin-flipper" style={{ ["--coin-end" as string]: end }}>
          <CoinFace color={colors[0]} side={0} />
          <CoinFace color={colors[1]} side={1} back />
        </div>
        <div className="coin-shadow" />
        {settled && <span className="coin-ring" style={{ borderColor: colors[winner] }} />}
        {settled && (
          <span className="coin-sparks">
            {Array.from({ length: 12 }, (_, i) => (
              <i key={i} style={{ ["--a" as string]: `${i * 30}deg`, background: colors[winner], animationDelay: `${i * 0.025}s` }} />
            ))}
          </span>
        )}
      </div>

      <p className="toss-text display mt-6 text-[18px] tracking-[0.16em]" style={{ color: colors[winner], textShadow: `0 0 26px ${rgbaOf(colors[winner], 0.5)}` }}>
        {labelSide(hud, winner)} начинает
      </p>
    </div>
  );
}

/** Одна сторона монеты: золотой гурт с насечкой, чеканный мяч, блик. */
function CoinFace({ color, side, back }: { color: string; side: 0 | 1; back?: boolean }) {
  const rim = `coin-rim-${side}`;
  const disc = `coin-disc-${side}`;
  return (
    <svg className={cn("coin-face", back && "coin-face-back")} viewBox="0 0 100 100" aria-hidden>
      <defs>
        <linearGradient id={rim} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fff8de" />
          <stop offset="0.32" stopColor="#e9c76c" />
          <stop offset="0.6" stopColor="#9d6f1c" />
          <stop offset="0.82" stopColor="#f0d489" />
          <stop offset="1" stopColor="#8a5f14" />
        </linearGradient>
        <radialGradient id={disc} cx="0.34" cy="0.28" r="0.9">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.92" />
          <stop offset="0.42" stopColor={color} />
          <stop offset="1" stopColor="#08110e" />
        </radialGradient>
      </defs>

      {/* гурт */}
      <circle cx="50" cy="50" r="48" fill={`url(#${rim})`} />
      <circle cx="50" cy="50" r="46" fill="none" stroke="rgba(88,58,10,0.5)" strokeWidth="2.4" strokeDasharray="1.7 2.3" />
      <circle cx="50" cy="50" r="43" fill="none" stroke="rgba(255,247,214,0.55)" strokeWidth="1" />
      {/* поле монеты */}
      <circle cx="50" cy="50" r="41" fill={`url(#${disc})`} />
      <circle cx="50" cy="50" r="41" fill="none" stroke="rgba(255,255,255,0.4)" strokeWidth="1.1" />
      <circle cx="50" cy="50" r="34.5" fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth="0.9" strokeDasharray="3 4.5" />
      {/* чеканка мяча */}
      <g>
        <circle cx="50" cy="50" r="19.5" fill="rgba(6,12,10,0.5)" stroke="rgba(255,255,255,0.8)" strokeWidth="1.7" />
        <path d="M50 39 L59 45.5 L55.6 56.2 L44.4 56.2 L41 45.5 Z" fill="rgba(255,255,255,0.92)" />
        <path
          d="M50 39 V30.5 M59 45.5 L67 41.5 M55.6 56.2 L60.8 63.8 M44.4 56.2 L39.2 63.8 M41 45.5 L33 41.5"
          stroke="rgba(255,255,255,0.72)"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </g>
      {/* блик */}
      <ellipse cx="35" cy="28" rx="21" ry="12" fill="rgba(255,255,255,0.2)" transform="rotate(-28 35 28)" />
      {/* мягкая тень по нижнему краю гурта — дуга идёт строго по окружности,
          ничего не выступает под монету и не создаёт тёмного нароста */}
      <path d="M 26 91.6 A 48 48 0 0 0 74 91.6" fill="none" stroke="rgba(0,0,0,0.18)" strokeWidth="3" />
    </svg>
  );
}

function LobbyOverlay({
  hud,
  director,
  copied,
  setCopied,
}: {
  hud: HudState;
  director: Director;
  copied: boolean;
  setCopied: (b: boolean) => void;
}) {
  const onCopy = async () => {
    sound.unlock();
    sound.ui();
    try {
      await navigator.clipboard.writeText(hud.roomCode ?? "");
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked */
    }
  };
  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-[#050805]/82 p-4 backdrop-blur-sm">
      <div className="glass anim-rise w-full max-w-[430px] rounded-2xl p-6 text-center">
        <p className="mono text-[10px] tracking-[0.3em] text-[#5ad2ff] uppercase">сеть</p>
        <h2 className="display mt-2 text-[27px]">Комната создана</h2>
        <p className="mt-1 text-[12.5px] text-[#f0ead6]/60">Отправь код другу — он подключится с главного экрана.</p>
        <p className="display mt-5 text-[54px] leading-none tracking-[0.22em] text-[#f0ead6]">{hud.roomCode}</p>
        <div className="mt-5 flex gap-2">
          <button onClick={onCopy} className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-[#9fe870] px-3 py-2.5 text-[12.5px] font-bold text-[#050805] transition hover:brightness-105">
            {copied ? <Share2 size={14} /> : <Copy size={14} />} {copied ? "скопировано" : "копировать"}
          </button>
          <button onClick={() => director.quitToMenu()} className="rounded-xl border border-[#f0ead6]/15 px-3 py-2.5 text-[12.5px] font-bold text-[#f0ead6]/70 transition hover:border-[#f0ead6]/40">
            отмена
          </button>
        </div>
        <p className="mono mt-4 flex items-center justify-center gap-2 text-[11px] text-[#f0ead6]/45">
          <Radio size={12} className={hud.peerConnected ? "text-[#9fe870]" : "pulse-dot text-[#ff6a2a]"} />
          {hud.peerConnected ? "соперник в сети" : "ждём соперника…"}
        </p>
      </div>
    </div>
  );
}

function MatchOverOverlay({ hud, director, colors }: { hud: HudState; director: Director; colors: [string, string] }) {
  const title =
    hud.winner === null
      ? "НИЧЬЯ"
      : hud.mode === "online"
        ? hud.winner === hud.mySide
          ? "ПОБЕДА!"
          : "ПОРАЖЕНИЕ"
        : hud.mode === "bot"
          ? hud.winner === 0
            ? "ПОБЕДА!"
            : "ПОРАЖЕНИЕ"
          : `ПОБЕДА — ${hud.names[hud.winner].toUpperCase()}`;
  const subtitle = hud.winner === null ? null : `${hud.names[hud.winner]} побеждает`;
  const color = hud.winner === null ? "#f0ead6" : colorOf(hud.winner, colors);
  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-[#050805]/80 p-4 backdrop-blur-sm">
      <div className="glass anim-rise w-full max-w-[460px] rounded-2xl p-6 text-center">
        <p className="mono text-[10px] tracking-[0.3em] text-[#f0ead6]/40 uppercase">{hud.mode === "bot" ? "матч с ботом" : "матч окончен"}</p>
        <h2 className="display anim-goal mt-2 text-[40px] leading-none" style={{ color }}>
          {title}
        </h2>
        {subtitle && hud.mode !== "local" && <p className="mt-2 text-[13px] text-[#f0ead6]/65">{subtitle}</p>}
        <p className="display mt-4 text-[30px] tracking-[0.06em]">
          <span style={{ color: colors[0] }}>{hud.scores[0]}</span> : <span style={{ color: colors[1] }}>{hud.scores[1]}</span>
        </p>
        <p className="mono mt-1 text-[10.5px] tracking-[0.14em] text-[#f0ead6]/40 uppercase">
          матч до {hud.cfg.winScore} · {hud.moveCount} линий
        </p>
        <div className="mt-5 flex gap-2">
          <button onClick={() => director.rematch()} className="display flex flex-1 items-center justify-center gap-2 rounded-xl bg-[#9fe870] px-3 py-2.5 text-[15px] text-[#050805] transition hover:brightness-105">
            <RotateCcw size={15} /> реванш
          </button>
          {hud.mode !== "online" && (
            <button onClick={() => director.forfeit()} className="rounded-xl border border-[#f0ead6]/12 px-3 py-2.5 text-[12px] font-bold text-[#f0ead6]/60 transition hover:border-[#ff3366]/50 hover:text-[#ff3366]">
              сдаться
            </button>
          )}
          <button onClick={() => director.quitToMenu()} className="rounded-xl border border-[#f0ead6]/12 px-3 py-2.5 text-[12px] font-bold text-[#f0ead6]/60 transition hover:border-[#f0ead6]/40">
            меню
          </button>
        </div>
      </div>
    </div>
  );
}

/* ================= menu bits ================= */

function ModeCard({
  active,
  onPick,
  icon,
  title,
  hint,
  children,
}: {
  active: boolean;
  onPick: () => void;
  icon: React.ReactNode;
  title: string;
  hint?: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onPick}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          onPick();
        }
      }}
      className={cn("mode-card glass w-full rounded-xl p-4 text-left outline-none", active ? "border-[#9fe870]/50" : "border-[#f0ead6]/10")}
    >
      <span className="flex items-center gap-2.5">
        <span className={cn("rounded-lg border p-2", active ? "border-[#9fe870]/50 text-[#9fe870]" : "border-[#f0ead6]/12 text-[#f0ead6]/55")}>{icon}</span>
        <span>
          <span className="display block text-[18px] leading-none">{title}</span>
          {hint && <span className="mono block text-[11px] tracking-[0.08em] text-[#f0ead6]/40 uppercase">{hint}</span>}
        </span>
        <span className={cn("ml-auto h-2.5 w-2.5 rounded-full transition", active ? "bg-[#9fe870] shadow-[0_0_12px_#9fe870]" : "bg-[#f0ead6]/15")} />
      </span>
      {active && <div className="mt-0.5">{children}</div>}
    </div>
  );
}

/** Превью арены — настоящее поле без узловых точек: чистая разметка,
 *  ворота, флаги и живая фактура выбранного типа поверхности. */
function ArenaPreview({
  arenaId,
  cols,
  rows,
  active,
}: {
  arenaId: string;
  cols: number;
  rows: number;
  active: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const aspect = (cols - 1) / (rows - 1);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let lastW = 0;
    let lastH = 0;
    const bake = () => {
      const rect = canvas.getBoundingClientRect();
      const cssW = Math.max(20, Math.round(rect.width));
      const cssH = Math.max(20, Math.round(rect.height));
      if (cssW === lastW && cssH === lastH) return;
      lastW = cssW;
      lastH = cssH;
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      const W = Math.max(2, Math.round(cssW * dpr));
      const H = Math.max(2, Math.round(cssH * dpr));
      canvas.width = W;
      canvas.height = H;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, W, H);
      try {
        // Рендерим на достаточном разрешении (>=360px), чтобы мел и штанги не
        // истончались в субпиксельную кашу, затем downsample с высоким сглаживанием:
        // результат получается кристально чётким и резким!
        const bakeW = Math.max(W, 360);
        const bakeH = Math.round(bakeW / aspect);
        const L = computeLayout(bakeW, bakeH, cols, rows, {
          topInset: 0,
          bottomPad: 0,
          compact: true,
          phone: false,
        });
        const tex = buildField({ ...L, w: bakeW, h: bakeH }, arenaId, { hideDots: true });
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(tex, 0, 0, W, H);
      } catch {
        ctx.fillStyle = "#0d1a12";
        ctx.fillRect(0, 0, W, H);
      }
    };
    bake();
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(bake);
      ro.observe(canvas);
    }
    window.addEventListener("resize", bake);
    window.addEventListener("orientationchange", bake);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", bake);
      window.removeEventListener("orientationchange", bake);
    };
  }, [arenaId, cols, rows, aspect]);

  return (
    <canvas
      ref={canvasRef}
      className={cn(
        "arena-prev rounded-[5px] shadow-[0_10px_26px_-14px_rgba(0,0,0,.85)] ring-1 ring-inset transition-[filter,box-shadow] duration-300 group-hover:brightness-[1.08] group-hover:saturate-[1.07]",
        active ? "ring-[#9fe870]/70" : "ring-black/45 group-hover:ring-black/25",
      )}
      style={{ ["--ar" as string]: aspect }}
      aria-hidden
    />
  );
}

/** Имя и цвет каждой команды.
 *  Если выбрать цвет, который уже носит соперник, — команды меняются цветами,
 *  поэтому две одинаковые формы на поле невозможны. */
function TeamSetup({
  names,
  colors,
  onName,
  onColor,
}: {
  names: [string, string];
  colors: [string, string];
  onName: (side: 0 | 1, value: string) => void;
  onColor: (side: 0 | 1, hex: string) => void;
}) {
  return (
    <div className="mt-3.5 grid grid-cols-2 gap-2.5">
      {([0, 1] as const).map((side) => {
        const color = colors[side];
        return (
          <div key={side}>
            <div className="mb-1 flex items-center gap-1.5">
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-white/30"
                style={{ background: color, boxShadow: `0 0 10px ${rgbaOf(color, 0.8)}` }}
              />
              <span className="mono truncate text-[9.5px] tracking-[0.16em] text-[#f0ead6]/40 uppercase">
                {side === 0 ? "твоя команда" : "соперник"}
              </span>
            </div>
            <input
              value={names[side]}
              maxLength={14}
              onChange={(e) => onName(side, e.target.value)}
              placeholder="название команды"
              className="w-full rounded-lg border border-[#f0ead6]/10 bg-black/40 px-2.5 py-1.5 text-[13px] text-[#f0ead6] outline-none transition placeholder:text-[#f0ead6]/30 focus:border-[#9fe870]/60"
            />
            <div className="mt-1.5 flex flex-wrap gap-1">
              {TEAM_SWATCHES.map((s) => {
                const on = color === s.hex;
                return (
                  <button
                    key={s.id}
                    type="button"
                    title={s.name}
                    aria-label={s.name}
                    aria-pressed={on}
                    onClick={() => onColor(side, s.hex)}
                    className={cn(
                      "h-[19px] w-[19px] rounded-full ring-1",
                      on ? "ring-2 ring-white/90" : "ring-black/50 hover:ring-white/45",
                    )}
                    style={{ background: s.hex, boxShadow: on ? `0 0 12px ${rgbaOf(s.hex, 0.85)}` : "none" }}
                  />
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ================= rules ================= */

function RulesModal({ onClose }: { onClose: () => void }) {
  const rules: [string, string][] = [
    ["ЦЕЛЬ", "Загони мяч в ворота соперника — прямоугольный створ его цвета: синие атакуют красные ворота (сверху), красные — синие (снизу). Матч — до выбранного числа голов."],
    ["ЖЕРЕБЬЁВКА", "Как в настоящем футболе, первый ход решает бросок монетки — перед каждым матчем и реваншем."],
    ["ХОД", "Проведи 1–3 линии от мяча к соседним узлам — 8 направлений. После первой или второй нажми «Пас», если хочешь передать мяч; после третьей ход передаётся автоматически."],
    ["ОТСКОК", "Попал на узел, где уже есть линии, или на борт? Мяч отскакивает и ход продолжается от этого узла. Отскок не обновляет лимит линий на новые три хода. По самой боковой линии проехаться нельзя."],
    ["ЗАПРЕТ", "Дважды одну и ту же линию провести нельзя. Пересечение диагоналей внутри клетки — разрешено."],
    ["ПЕНАЛЬТИ", "Тупик — нет ни одного легального хода: мяч возвращается на центральную точку, удар получает соперник."],
    ["АВТОГОЛ", "Мяч в твоих воротах — очко сопернику. После гола поле очищается, начинает пропустивший."],
  ];
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-[#050805]/88 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="glass anim-rise max-h-full w-full max-w-[620px] overflow-y-auto scroll-thin rounded-2xl p-5 sm:p-7" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4">
          <h2 className="display text-[30px] leading-none">Правила</h2>
          <button onClick={onClose} className="rounded-lg border border-[#f0ead6]/12 p-1.5 text-[#f0ead6]/60 transition hover:border-[#f0ead6]/40 hover:text-[#f0ead6]">
            <X size={15} />
          </button>
        </div>
        <dl className="mt-4 space-y-3">
          {rules.map(([t, d]) => (
            <div key={t} className="grid grid-cols-[76px_1fr] gap-3 border-t border-[#f0ead6]/8 pt-3">
              <dt className="mono text-[10px] leading-tight tracking-[0.12em] text-[#9fe870] uppercase">{t}</dt>
              <dd className="text-[13px] leading-relaxed text-[#f0ead6]/75">{d}</dd>
            </div>
          ))}
        </dl>
        <p className="mono mt-5 border-t border-[#f0ead6]/8 pt-3 text-[10.5px] leading-relaxed text-[#f0ead6]/40">
          <span className="text-[#ff6a2a]">engine core</span>
          <br />
          shared/engine — чистые правила, поля 15/19/23. shared/ai — minimax α-β до прямоугольных ворот.
          render — процедурный PBR-газон, частицы, динамический свет. net — socket-контракт поверх комнат с серверной валидацией цепочек ходов.
        </p>
      </div>
    </div>
  );
}
