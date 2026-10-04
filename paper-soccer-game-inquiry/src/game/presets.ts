/* ============================================================
 * PAPER SOCCER — pitch shape presets (shared)
 *
 * A phone screen is tall and narrow, but a square pitch is limited by the
 * shorter side, so every cell ends up tiny. Phones therefore get a narrower
 * but longer pitch: it matches the screen's aspect ratio, so the same amount
 * of play area is drawn with far larger, thumb-friendly cells.
 *
 * Desktops and tablets keep the classic square pitch.
 * ============================================================ */

export type PitchKind = "sprint" | "classic" | "marathon";

export interface PitchShape {
  cols: number; // width in nodes (odd)
  rows: number; // length in nodes (odd)
}

/** Square pitches for roomy screens (unchanged from the original game). */
const SQUARE: Record<PitchKind, PitchShape> = {
  sprint: { cols: 15, rows: 15 },
  classic: { cols: 19, rows: 19 },
  marathon: { cols: 23, rows: 23 },
};

/** Phone pitches: one fixed column count so every size preset has the SAME
 *  cell width (= screen width / 10) and the same thumb-sized ball. The preset
 *  only changes the pitch LENGTH (rows), i.e. how long the match runs — the
 *  pitch visibly grows taller instead of the cells shrinking. */
const PHONE_COLS = 11;
const TALL: Record<PitchKind, PitchShape> = {
  sprint: { cols: PHONE_COLS, rows: 15 },
  classic: { cols: PHONE_COLS, rows: 19 },
  marathon: { cols: PHONE_COLS, rows: 25 },
};

export const PITCH_KINDS: { kind: PitchKind; label: string; hint: string }[] = [
  { kind: "sprint", label: "S", hint: "Спринт" },
  { kind: "classic", label: "M", hint: "Классика" },
  { kind: "marathon", label: "L", hint: "Марафон" },
];

/** Pitch shape for the device.
 *
 * Phones get a rectangle oriented like the screen — tall in portrait, wide in
 * landscape — because a pitch that fights the screen shape shrinks every cell.
 * Desktops and tablets keep the classic square. */
export function pitchShape(kind: PitchKind, phone: boolean, landscape = false): PitchShape {
  if (!phone) return SQUARE[kind];
  const s = TALL[kind];
  return landscape ? { cols: s.rows, rows: s.cols } : s;
}

/** Phone detection by the shorter viewport edge (600dp is the standard
 *  phone/tablet breakpoint), so it is orientation-independent. */
export function isPhoneViewport(w: number, h: number): boolean {
  return Math.min(w, h) < 600;
}

export function currentIsPhone(): boolean {
  if (typeof window === "undefined") return false;
  return isPhoneViewport(window.innerWidth, window.innerHeight);
}

export function currentIsLandscape(): boolean {
  if (typeof window === "undefined") return false;
  return window.innerWidth > window.innerHeight;
}

/** Label such as "13×21" for the menu. */
export function shapeLabel(s: PitchShape): string {
  return `${s.cols}×${s.rows}`;
}
