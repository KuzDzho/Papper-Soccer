/* ============================================================
 * PAPER SOCCER — цвета команд (клиентская настройка)
 *
 * Renderer, угловые флаги и неоновые чернила читают цвета из общего
 * объекта TEAM (field.ts). Здесь мы лишь пишем в него выбранные значения,
 * поэтому смена цвета не требует перепекать текстуру поля: линии, узлы,
 * флаги и подсветка берут TEAM уже на следующем кадре.
 * ============================================================ */

import { TEAM } from "./field";
import { storageGetJSON, storageSetJSON } from "./storage";
import type { PlayerIdx } from "./engine";

export interface Swatch {
  id: string;
  name: string;
  hex: string;
}

export const TEAM_SWATCHES: Swatch[] = [
  { id: "cyan", name: "Циан", hex: "#00d4ff" },
  { id: "coral", name: "Коралл", hex: "#ff3366" },
  { id: "lime", name: "Лайм", hex: "#9fe870" },
  { id: "amber", name: "Янтарь", hex: "#ffb020" },
  { id: "blaze", name: "Пламя", hex: "#ff6a2a" },
  { id: "teal", name: "Бирюза", hex: "#2fd6b0" },
  { id: "rose", name: "Роза", hex: "#ff7ad9" },
  { id: "chalk", name: "Мел", hex: "#f0ead6" },
];

export const DEFAULT_TEAM_COLORS: [string, string] = ["#00d4ff", "#ff3366"];

const KEY = "ps.teams";

export function hexToRgb(hex: string): [number, number, number] {
  const v = hex.replace("#", "");
  const full = v.length === 3 ? v.split("").map((c) => c + c).join("") : v;
  const int = parseInt(full, 16) || 0;
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}

export function rgbaOf(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** Цвет команды, осветлённый к белому — «горячее ядро» неонового штриха. */
export function inkHighlight(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  const mix = (v: number) => Math.round(v + (255 - v) * 0.72);
  return `rgb(${mix(r)},${mix(g)},${mix(b)})`;
}

export function loadTeamColors(): [string, string] {
  const saved = storageGetJSON<{ home?: string; away?: string }>(KEY);
  const known = (v?: string) => (v && TEAM_SWATCHES.some((s) => s.hex === v) ? v : null);
  const home = known(saved?.home) ?? DEFAULT_TEAM_COLORS[0];
  const away = known(saved?.away) ?? DEFAULT_TEAM_COLORS[1];
  // две команды в одном цвете не играют: откатываем второй на дефолт
  return [home, away === home ? (home === DEFAULT_TEAM_COLORS[1] ? DEFAULT_TEAM_COLORS[0] : DEFAULT_TEAM_COLORS[1]) : away];
}

export function saveTeamColors(colors: [string, string]) {
  storageSetJSON(KEY, { home: colors[0], away: colors[1] });
}

/** Пишет выбранные цвета в общий TEAM-объект поля. */
export function applyTeamColors(home: string, away: string) {
  TEAM.home = home;
  TEAM.away = away;
  TEAM.homeGlow = rgbaOf(home, 0.38);
  TEAM.awayGlow = rgbaOf(away, 0.38);
}

export function colorOf(side: PlayerIdx, colors: [string, string]): string {
  return side === 0 ? colors[0] : colors[1];
}
