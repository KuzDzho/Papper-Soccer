/* ============================================================
 * PAPER SOCCER — hyper-real pitch texture (baked to offscreen canvas)
 * Layers: base grass → mow stripes → blade speckle → organic blotch
 * → mud wear (high-traffic zones) → chalk markings → 3D goals (posts,
 * crossbar, net) + corner flags → light sheen → vignette → grain.
 * ============================================================ */

import { mulberry32 } from "./fx";
import { goalHalf } from "./engine";
import { Arena, getArena } from "./arenas";

export interface Layout {
  ox: number; // px of node (0,0)
  oy: number;
  cellW: number; // px per cell, horizontal
  cellH: number; // px per cell, vertical
  cell: number; // min(cellW, cellH) — pitch markings, line widths
  /** Size basis for gameplay UI (ball, hints, arrow). Equals `cell` on
   *  desktop/tablet; on phones it is `cellW`, which is fixed by the screen
   *  width — so the ball stays the same thumb size on every length preset. */
  uiCell: number;
  w: number; // canvas px
  h: number;
  cols: number; // pitch width in nodes
  rows: number; // pitch length in nodes
  compact: boolean; // phone/tablet layout (preserved when baking at HiDPI)
  phone: boolean; // phone-class viewport: rectangular cells allowed
  /** Total scrollable canvas height. > h when a long phone pitch overflows. */
  contentH: number;
}

export interface LayoutOpts {
  /** px reserved at the top for the HUD — the pitch is centred below it. */
  topInset?: number;
  /** px kept clear at the bottom. */
  bottomPad?: number;
  /** Explicit CSS-layout class for HiDPI offscreen rendering. */
  compact?: boolean;
  /** Explicit phone class for HiDPI offscreen rendering. */
  phone?: boolean;
}

/** Max cell stretch on phones (1 = square). Round objects (ball, circles) are
 *  sized by the smaller axis, so only the grid spacing stretches. 1.9 lets a
 *  wide 11-column pitch span the full width of a phone even when the length
 *  preset is short; beyond that the grid starts to read as stripes. */
export const PHONE_CELL_ASPECT_MAX = 1.9;

/** Phone side margin in cells. Enough for the enlarged ball (0.62-cell radius)
 *  plus a sliver of touchline grass — nothing more. */
const PHONE_SIDE_M = 0.42;

/** Floor for cellH/cellW on phones. Below this the pitch scrolls instead of
 *  squeezing: rows stay at least ~86% of a column's width, so the hit area of
 *  every node keeps its thumb-friendly height on the long "marathon" pitch. */
const PHONE_MIN_CELL_ASPECT = 0.86;

export function computeLayout(
  w: number,
  h: number,
  cols: number,
  rows: number,
  opts?: LayoutOpts,
): Layout {
  const spanX = cols - 1;
  const spanY = rows - 1;
  const top = opts?.topInset ?? 0;
  const bot = opts?.bottomPad ?? 0;
  const availH = Math.max(60, h - top - bot);

  // Three layout tiers — desktop and tablet are byte-for-byte identical to the
  // previous square-cell behaviour. Only phones change.
  //
  // Desktop keeps the generous broadcast margins. Tablets trim the padding so
  // the pitch fills the screen. Phones additionally allow RECTANGULAR cells:
  // width and height are fitted independently, so the pitch gets wider at the
  // same row count and every cell gains tappable area. The node COUNT never
  // changes — only the pixels per cell.
  //
  // Margins stay expressed in cells, never raw px: the goal box reaches 1.0
  // cell behind the goal line and corner flags 0.75 cell, so a 1.35-cell end
  // margin guarantees nothing is ever clipped off-canvas.
  const compact = opts?.compact ?? !(w >= 1100 && h >= 700);
  const phone = opts?.phone ?? Math.min(w, h) < 600;
  const sideM = !compact ? 0.9 : phone ? PHONE_SIDE_M : 0.5;
  const endM = 1.35;

  let cellW = w / (spanX + sideM * 2);
  let cellH = availH / (spanY + endM * 2);
  let contentH = h;
  if (!phone) {
    // На широком экране квадратное поле упирается в высоту и оставляет по
    // бокам огромные поля. Даём клетке чуть растянуться вширь (до 1.42× высоты),
    // как на широких трансляциях: число узлов и ходов не меняется, а само поле
    // становится заметно крупнее и шире. На узких и в превью остаётся квадрат.
    const rawW = cellW;
    const rawH = cellH;
    const base = Math.min(rawW, rawH);
    cellW = !compact && rawW > rawH ? Math.min(rawW, rawH * 1.42) : base;
    cellH = base;
  } else {
    // Phones: the WIDTH axis is the priority — the pitch must span the screen
    // so cells (and the ball) are thumb-sized. Cells never shrink below a
    // comfortable floor to make a long pitch fit: instead the pitch grows
    // taller than the screen and the canvas becomes scrollable. A short preset
    // is capped so it does not stretch into stripes.
    if (cellH > cellW * PHONE_CELL_ASPECT_MAX) cellH = cellW * PHONE_CELL_ASPECT_MAX;
    const minCellH = cellW * PHONE_MIN_CELL_ASPECT;
    if (cellH < minCellH) {
      cellH = minCellH;
      contentH = top + cellH * (spanY + endM * 2) + bot;
    }
  }
  const cell = Math.min(cellW, cellH);
  const uiCell = phone ? cellW : cell;
  const bw = cellW * spanX;
  const bh = cellH * spanY;
  // Portrait: sit slightly above centre so the lower rows stay in thumb reach.
  // When the pitch overflows the screen it simply starts below the HUD strip.
  const overflow = contentH > h;
  const centerY = overflow ? 0 : h > w ? 0.42 : 0.5;
  const oyBase = overflow ? top + cellH * endM : top + (availH - bh) * centerY;
  return {
    ox: (w - bw) / 2,
    oy: oyBase,
    cellW,
    cellH,
    cell,
    uiCell,
    w,
    h,
    cols,
    rows,
    compact,
    phone,
    contentH,
  };
}

export interface NightMast {
  x: number;
  y: number;
  ox: number; // support-pylon anchor at the outer canvas corner
  oy: number;
}

/** Responsive positions for the four night floodlight heads.
 *
 * Desktop keeps the original diagonal placement outside all four corners.
 * A portrait phone has almost no horizontal gutter, so its lamps move above
 * and below the pitch. A landscape phone has little vertical room, so the
 * lamps move to the left and right. This keeps the entire LED matrix visible
 * while preserving the visual relationship to its pitch corner. */
export function nightMastPositions(L: Layout): NightMast[] {
  const cw = L.cellW;
  const ch = L.cellH;
  const x0 = L.ox;
  const y0 = L.oy;
  const x1 = x0 + cw * (L.cols - 1);
  const y1 = y0 + ch * (L.rows - 1);
  if (!L.compact) {
    return [
      { x: x0 - cw * 0.72, y: y0 - ch * 0.85, ox: 0, oy: 0 },
      { x: x1 + cw * 0.72, y: y0 - ch * 0.85, ox: L.w, oy: 0 },
      { x: x0 - cw * 0.72, y: y1 + ch * 0.85, ox: 0, oy: L.h },
      { x: x1 + cw * 0.72, y: y1 + ch * 0.85, ox: L.w, oy: L.h },
    ];
  }

  const portrait = L.h > L.w;
  const raw: NightMast[] = portrait
    ? [
        { x: x0 + cw * 0.45, y: y0 - ch * 0.82, ox: 0, oy: 0 },
        { x: x1 - cw * 0.45, y: y0 - ch * 0.82, ox: L.w, oy: 0 },
        { x: x0 + cw * 0.45, y: y1 + ch * 0.82, ox: 0, oy: L.h },
        { x: x1 - cw * 0.45, y: y1 + ch * 0.82, ox: L.w, oy: L.h },
      ]
    : [
        { x: x0 - cw * 0.82, y: y0 + ch * 0.45, ox: 0, oy: 0 },
        { x: x1 + cw * 0.82, y: y0 + ch * 0.45, ox: L.w, oy: 0 },
        { x: x0 - cw * 0.82, y: y1 - ch * 0.45, ox: 0, oy: L.h },
        { x: x1 + cw * 0.82, y: y1 - ch * 0.45, ox: L.w, oy: L.h },
      ];

  // Last-resort clamp for split-screen, browser UI transitions and unusual
  // aspect ratios. The physical gantry head (not just its centre) stays inside.
  const scale = 0.72;
  const halfW = cw * 0.54 * scale * 0.5;
  const halfH = ch * 0.42 * scale * 0.5;
  const flare = L.cell * 0.46;
  const safeX = Math.max(halfW, flare) + 2;
  const safeY = Math.max(halfH, flare) + 2;
  return raw.map((m) => ({
    ...m,
    x: Math.max(safeX, Math.min(L.w - safeX, m.x)),
    y: Math.max(safeY, Math.min(L.h - safeY, m.y)),
  }));
}

export const TEAM = {
  home: "#00d4ff", // HOME — soft electric cyan-blue (neon, high-contrast on grass)
  homeGlow: "rgba(0,212,255,0.38)",
  away: "#ff3366", // AWAY — vibrant neon coral-red
  awayGlow: "rgba(255,51,102,0.38)",
};

function speckleTile(rand: () => number, A: Arena): HTMLCanvasElement {
  const T = 360;
  const c = document.createElement("canvas");
  c.width = T;
  c.height = T;
  const x = c.getContext("2d");
  if (!x) return c;
  for (let i = 0; i < 5200; i++) {
    const px = rand() * T;
    const py = rand() * T;
    const l = A.speckleLight[0] + rand() * (A.speckleLight[1] - A.speckleLight[0]);
    const hue = A.speckleHue[0] + rand() * (A.speckleHue[1] - A.speckleHue[0]);
    const len = 1 + rand() * 2.6;
    const ang = rand() * Math.PI;
    x.strokeStyle = `hsla(${hue}, ${A.speckleSat}%, ${l}%, ${0.16 + rand() * 0.2})`;
    x.lineWidth = 0.8;
    x.beginPath();
    x.moveTo(px, py);
    x.lineTo(px + Math.cos(ang) * len, py + Math.sin(ang) * len);
    x.stroke();
  }
  // dry blades (only on daytime grass; night/winter/beach/paper have their own textures)
  if (A.id === "stadium") {
    for (let i = 0; i < 260; i++) {
      const px = rand() * T;
      const py = rand() * T;
      x.fillStyle = `hsla(${38 + rand() * 14}, 34%, ${26 + rand() * 16}%, ${0.12 + rand() * 0.16})`;
      x.fillRect(px, py, 1.4, 1.4);
    }
  }
  return c;
}

type Ctx = CanvasRenderingContext2D;

let CHALK: [number, number, number] = [252, 252, 246];
const chalkA = (a: number) => `rgba(${CHALK[0]},${CHALK[1]},${CHALK[2]},${a})`;

function chalkPath(ctx: Ctx, pts: [number, number][], cell: number, rand: () => number, close = false) {
  const passes: [number, string, number][] = [
    [cell * 0.16, chalkA(0.34), 0],
    [cell * 0.11, chalkA(0.5), 0],
    [cell * 0.05, chalkA(0.6), 0],
  ];
  for (const [w, style] of passes) {
    ctx.strokeStyle = style;
    ctx.lineWidth = w;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    pts.forEach(([px, py], i) => {
      const jx = px + (rand() - 0.5) * cell * 0.05;
      const jy = py + (rand() - 0.5) * cell * 0.05;
      if (i === 0) ctx.moveTo(jx, jy);
      else ctx.lineTo(jx, jy);
    });
    if (close) ctx.closePath();
    ctx.stroke();
  }
  // chalk crumble along the stroke
  ctx.fillStyle = chalkA(0.4);
  const n = Math.floor(pts.length * cell * 0.55);
  for (let i = 0; i < n; i++) {
    const seg = (rand() * (pts.length - 1)) | 0;
    const t = rand();
    const px = pts[seg][0] + (pts[seg + 1][0] - pts[seg][0]) * t;
    const py = pts[seg][1] + (pts[seg + 1][1] - pts[seg][1]) * t;
    ctx.globalAlpha = 0.1 + rand() * 0.3;
    ctx.beginPath();
    ctx.arc(px + (rand() - 0.5) * cell * 0.22, py + (rand() - 0.5) * cell * 0.22, 0.6 + rand() * 1.1, 0, 7);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function chalkArc(
  ctx: Ctx,
  cx: number,
  cy: number,
  r: number,
  a0: number,
  a1: number,
  cell: number,
  rand: () => number,
) {
  const steps = Math.max(10, Math.floor((a1 - a0) * r / (cell * 0.35)));
  const pts: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const a = a0 + ((a1 - a0) * i) / steps;
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  chalkPath(ctx, pts, cell, rand);
}

let MUD: [number, number, number] = [101, 79, 50];

function mudPatch(ctx: Ctx, x: number, y: number, r: number, strength: number, rand: () => number) {
  if (strength <= 0) return;
  const [mr, mg, mb] = MUD;
  const g = ctx.createRadialGradient(x, y, r * 0.08, x, y, r);
  g.addColorStop(0, `rgba(${mr},${mg},${mb},${0.42 * strength})`);
  g.addColorStop(0.55, `rgba(${mr},${mg},${mb},${0.22 * strength})`);
  g.addColorStop(1, `rgba(${mr},${mg},${mb},0)`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, 7);
  ctx.fill();
  // bare earth speckles
  for (let i = 0; i < r * 2.2 * strength; i++) {
    const a = rand() * Math.PI * 2;
    const d = Math.sqrt(rand()) * r * 0.85;
    ctx.fillStyle = `rgba(${mr},${mg},${mb},${0.1 + rand() * 0.3 * strength})`;
    ctx.beginPath();
    ctx.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, 0.8 + rand() * 2.4, 0, 7);
    ctx.fill();
  }
}

/** Thin node-grid: faint lines between adjacent nodes + tiny dots at every node.
 *  Rendered between the grass speckle and the mud layer so ink/chalk still reads on top. */
function drawNodeGrid(ctx: Ctx, L: Layout, A: Arena, hideDots = false) {
  if (hideDots) return;
  const G = A.grid;
  const { ox, oy, cellW, cellH, cell, cols, rows } = L;
  const spanX = cols - 1;
  const spanY = rows - 1;
  const lineW = Math.max(0.6, cell * 0.014);
  // 1 · fine chalk-grid lines (horizontal + vertical)
  ctx.save();
  ctx.strokeStyle = `rgba(${G},0.075)`;
  ctx.lineWidth = lineW;
  ctx.beginPath();
  for (let y = 0; y < rows; y++) {
    ctx.moveTo(ox, oy + y * cellH);
    ctx.lineTo(ox + spanX * cellW, oy + y * cellH);
  }
  for (let x = 0; x < cols; x++) {
    ctx.moveTo(ox + x * cellW, oy);
    ctx.lineTo(ox + x * cellW, oy + spanY * cellH);
  }
  ctx.stroke();
  // 2 · secondary diagonal guide-lines (very faint, help the eye trace diagonals)
  ctx.strokeStyle = `rgba(${G},0.035)`;
  ctx.lineWidth = Math.max(0.4, cell * 0.009);
  ctx.beginPath();
  for (let y = 0; y < rows - 1; y++) {
    for (let x = 0; x < cols - 1; x++) {
      const px = ox + x * cellW;
      const py = oy + y * cellH;
      ctx.moveTo(px, py);
      ctx.lineTo(px + cellW, py + cellH);
      ctx.moveTo(px + cellW, py);
      ctx.lineTo(px, py + cellH);
    }
  }
  ctx.stroke();
  // 3 · node dots with subtle chalk-glow
  const r = Math.max(1.1, cell * 0.05);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const px = ox + x * cellW;
      const py = oy + y * cellH;
      // halo
      ctx.fillStyle = `rgba(${G},0.06)`;
      ctx.beginPath();
      ctx.arc(px, py, r * 2.3, 0, 7);
      ctx.fill();
      // core
      ctx.fillStyle = `rgba(${G},0.32)`;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, 7);
      ctx.fill();
      // highlight
      ctx.fillStyle = "rgba(255,255,255,0.55)";
      ctx.beginPath();
      ctx.arc(px - r * 0.35, py - r * 0.35, r * 0.38, 0, 7);
      ctx.fill();
    }
  }
  ctx.restore();
}

/** Rectangular 3D goal — posts + crossbar on the line, straight side rails
 *  to a back rail, neutral grey net; width == goal-area rectangle == mouth. */
function buildGoal(ctx: Ctx, L: Layout, top: boolean, A?: Arena) {
  const midN = (L.cols - 1) / 2;
  const gh = goalHalf(L.cols);
  const cw = L.cellW;
  const ch = L.cellH;
  const yLine = top ? L.oy : L.oy + ch * (L.rows - 1);
  const dir = top ? -1 : 1;
  const px0 = L.ox + (midN - gh) * cw; // left post
  const px1 = L.ox + (midN + gh) * cw; // right post
  const cell = L.cell;
  const depth = ch * 1.0;
  const backY = yLine + dir * depth;
  const yMin = Math.min(yLine, backY);

  // ── trampled grass inside the box ────────────────────────────────────
  mudPatch(ctx, (px0 + px1) / 2, yLine + dir * depth * 0.45, cell * 1.05, 0.55, mulberry32(top ? 41 : 42));

  // ── net box (true rectangle) ─────────────────────────────────────────
  ctx.save();
  ctx.beginPath();
  ctx.rect(px0, yMin, px1 - px0, depth);
  ctx.fillStyle = "rgba(8,12,8,0.30)";
  ctx.fill();
  ctx.clip();
  // square mesh
  ctx.strokeStyle = "rgba(232,236,232,0.30)";
  ctx.lineWidth = Math.max(1, cell * 0.016);
  const stepX = cw * 0.2;
  const stepY = ch * 0.2;
  ctx.beginPath();
  for (let x = px0; x <= px1 + 0.5; x += stepX) {
    ctx.moveTo(x, yMin);
    ctx.lineTo(x, yMin + depth);
  }
  for (let y = yMin; y <= yMin + depth + 0.5; y += stepY) {
    ctx.moveTo(px0, y);
    ctx.lineTo(px1, y);
  }
  ctx.stroke();
  // uniform interior shade (no directional sag → reads as a flat rectangle)
  ctx.fillStyle = "rgba(0,0,0,0.14)";
  ctx.fillRect(px0, yMin, px1 - px0, depth);
  ctx.restore();

  // crisp rectangular outline of the net box
  ctx.strokeStyle = "rgba(255,255,255,0.55)";
  ctx.lineWidth = Math.max(1, cell * 0.02);
  ctx.strokeRect(px0, yMin, px1 - px0, depth);

  // ── frame: side rails + back rail (straight, rectangular) ────────────
  ctx.lineCap = "butt";
  ctx.lineJoin = "miter";
  ctx.strokeStyle = "rgba(0,0,0,0.32)";
  ctx.lineWidth = cell * 0.07;
  ctx.beginPath();
  ctx.moveTo(px0 + 1.2, yLine + 1.2);
  ctx.lineTo(px0 + 1.2, backY + 1.2);
  ctx.lineTo(px1 + 1.2, backY + 1.2);
  ctx.lineTo(px1 + 1.2, yLine + 1.2);
  ctx.stroke();
  ctx.strokeStyle = "#f4f5f0";
  ctx.lineWidth = cell * 0.045;
  ctx.beginPath();
  ctx.moveTo(px0, yLine);
  ctx.lineTo(px0, backY);
  ctx.lineTo(px1, backY);
  ctx.lineTo(px1, yLine);
  ctx.stroke();

  // ── crossbar: solid white bar on the goal line ───────────────────────
  ctx.strokeStyle = "rgba(0,0,0,0.38)";
  ctx.lineWidth = cell * 0.12;
  ctx.beginPath();
  ctx.moveTo(px0 - cw * 0.02, yLine + 1.5);
  ctx.lineTo(px1 + cw * 0.02, yLine + 1.5);
  ctx.stroke();
  const barG = ctx.createLinearGradient(0, yLine - ch * 0.06, 0, yLine + ch * 0.06);
  barG.addColorStop(0, "#ffffff");
  barG.addColorStop(0.5, "#f2f3ee");
  barG.addColorStop(1, "#b9beb6");
  ctx.strokeStyle = barG;
  ctx.lineWidth = cell * 0.12;
  ctx.lineCap = "butt";
  ctx.beginPath();
  ctx.moveTo(px0 - cw * 0.06, yLine);
  ctx.lineTo(px1 + cw * 0.06, yLine);
  ctx.stroke();

  // ── posts: white cylinders on the line ───────────────────────────────
  for (const px of [px0, px1]) {
    ctx.fillStyle = "rgba(0,0,0,0.36)";
    ctx.beginPath();
    ctx.ellipse(px + cw * 0.035, yLine + ch * 0.05, cw * 0.14, ch * 0.075, 0, 0, 7);
    ctx.fill();
    const pg = ctx.createRadialGradient(px - cw * 0.04, yLine - ch * 0.04, cell * 0.015, px, yLine, cell * 0.13);
    pg.addColorStop(0, "#ffffff");
    pg.addColorStop(0.65, "#e6e8e1");
    pg.addColorStop(1, "#a3a89f");
    ctx.fillStyle = pg;
    ctx.beginPath();
    ctx.arc(px, yLine, cell * 0.11, 0, 7);
    ctx.fill();
    ctx.strokeStyle = "rgba(20,26,20,0.3)";
    ctx.lineWidth = cell * 0.018;
    ctx.beginPath();
    ctx.arc(px, yLine, cell * 0.11, 0, 7);
    ctx.stroke();
  }

  // Winter snow accumulations on top of goal crossbar and frame
  if (A?.id === "winter") {
    // Soft snow cap along the crossbar
    ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
    ctx.beginPath();
    ctx.moveTo(px0 - cw * 0.06, yLine);
    for (let x = px0 - cw * 0.06; x <= px1 + cw * 0.06; x += cw * 0.2) {
      const bump = Math.sin((x - px0) * 0.4) * ch * 0.025 - ch * 0.035;
      ctx.lineTo(x, yLine + bump);
    }
    ctx.lineTo(px1 + cw * 0.06, yLine);
    ctx.closePath();
    ctx.fill();

    // Snow caps on the posts
    for (const px of [px0, px1]) {
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(px, yLine - ch * 0.03, cell * 0.07, Math.PI, 0);
      ctx.fill();
    }

    // Frost frosting along the back frame rail
    ctx.fillStyle = "rgba(255, 255, 255, 0.75)";
    ctx.fillRect(px0 + cw * 0.05, backY - ch * 0.02, px1 - px0 - cw * 0.1, ch * 0.035);
  }
}

/** Corner flag anchors for the animated renderer layer (baked texture keeps
 *  only the base socket). Flags are drawn per-frame on top of the pitch. */
export interface CornerFlag {
  x: number; // pole base (on the corner node)
  y: number;
  inX: 1 | -1; // pennant points inward
  color: string;
  winter: boolean;
}

export function cornerFlagPositions(L: Layout, arenaId?: string): CornerFlag[] {
  const winter = getArena(arenaId).id === "winter";
  return [
    { x: L.ox, y: L.oy, inX: 1, color: TEAM.away, winter },
    { x: L.ox + L.cellW * (L.cols - 1), y: L.oy, inX: -1, color: TEAM.away, winter },
    { x: L.ox, y: L.oy + L.cellH * (L.rows - 1), inX: 1, color: TEAM.home, winter },
    { x: L.ox + L.cellW * (L.cols - 1), y: L.oy + L.cellH * (L.rows - 1), inX: -1, color: TEAM.home, winter },
  ];
}

/** Small painted socket where the pole meets the grass (baked once). */
function buildFlagSockets(ctx: Ctx, L: Layout) {
  const cw = L.cellW;
  const corners: [number, number][] = [
    [L.ox, L.oy],
    [L.ox + cw * (L.cols - 1), L.oy],
    [L.ox, L.oy + L.cellH * (L.rows - 1)],
    [L.ox + cw * (L.cols - 1), L.oy + L.cellH * (L.rows - 1)],
  ];
  for (const [sx, sy] of corners) {
    // soft grass shadow ring so the pole visibly "stands" on the turf
    ctx.fillStyle = "rgba(0,0,0,0.22)";
    ctx.beginPath();
    ctx.ellipse(sx + cw * 0.05, sy + cw * 0.09, cw * 0.16, cw * 0.09, 0, 0, 7);
    ctx.fill();
    // bright socket ring — high visibility against the chalk lines
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.lineWidth = Math.max(1, cw * 0.03);
    ctx.beginPath();
    ctx.arc(sx, sy, cw * 0.11, 0, 7);
    ctx.stroke();
  }
}

export function buildField(
  L: Layout,
  arenaId?: string,
  opts?: { hideDots?: boolean },
): HTMLCanvasElement {
  const A = getArena(arenaId);
  CHALK = A.chalk;
  MUD = A.mud;
  const c = document.createElement("canvas");
  c.width = Math.max(2, Math.round(L.w));
  c.height = Math.max(2, Math.round(L.h));
  const ctx = c.getContext("2d");
  if (!ctx) return c;
  const rand = mulberry32(1337);
  const x0 = L.ox;
  const y0 = L.oy;
  const cw = L.cellW;
  const ch = L.cellH;
  const x1 = L.ox + cw * (L.cols - 1);
  const y1 = L.oy + ch * (L.rows - 1);
  // Centre of the pitch: width drives X, LENGTH drives Y. On a square pitch the
  // two coincide; on the phone's rectangular pitch using cols for Y would slide
  // the halfway line and centre circle upward.
  const midCol = (L.cols - 1) / 2;
  const midRow = (L.rows - 1) / 2;
  const midX = L.ox + midCol * cw;
  const midY = L.oy + midRow * ch;

  // 1 · base grass
  const base = ctx.createLinearGradient(0, 0, L.w * 0.35, L.h);
  base.addColorStop(0, A.base[0]);
  base.addColorStop(0.45, A.base[1]);
  base.addColorStop(1, A.base[2]);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, L.w, L.h);

  // 2 · mow stripes
  if (A.stripes) {
    const stripeH = L.cell * 2;
    for (let i = 0, y = 0; y < L.h + stripeH; y += stripeH, i++) {
      ctx.fillStyle = i % 2 === 0 ? A.stripeLight : A.stripeDark;
      ctx.fillRect(0, y, L.w, stripeH);
    }
  }

  // 3 · grass blade speckle
  const tile = speckleTile(rand, A);
  const pat = ctx.createPattern(tile, "repeat");
  if (pat) {
    ctx.fillStyle = pat;
    ctx.fillRect(0, 0, L.w, L.h);
  }

  // 4 · organic surface variation — tinted per arena (classic/paper unchanged)
  for (let i = 0; i < 46; i++) {
    const bx = rand() * L.w;
    const by = rand() * L.h;
    const br = L.cell * (1.5 + rand() * 4);
    const g = ctx.createRadialGradient(bx, by, 0, bx, by, br);
    const dark = rand() > 0.5;
    let tint: string;
    if (A.id === "night") tint = dark ? "rgba(2,13,22,0.16)" : "rgba(60,145,130,0.08)";
    else if (A.id === "winter") tint = dark ? "rgba(85,115,135,0.08)" : "rgba(255,255,255,0.17)";
    else if (A.id === "beach") tint = dark ? "rgba(150,116,64,0.12)" : "rgba(255,248,222,0.14)";
    else tint = dark ? "rgba(8,30,10,0.10)" : "rgba(120,190,90,0.06)";
    g.addColorStop(0, tint);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(bx, by, br, 0, 7);
    ctx.fill();
  }

  // 4.2 · arena-specific surface details
  if (A.id === "paper") {
    // notebook squares: light blue ruling at half-cell pitch, one red margin line
    ctx.strokeStyle = "rgba(120,160,220,0.28)";
    ctx.lineWidth = 1;
    const stepX = cw / 2;
    const stepY = ch / 2;
    ctx.beginPath();
    for (let x = (L.ox % stepX); x < L.w; x += stepX) {
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, L.h);
    }
    for (let y = (L.oy % stepY); y < L.h; y += stepY) {
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(L.w, Math.round(y) + 0.5);
    }
    ctx.stroke();
    ctx.strokeStyle = "rgba(220,90,90,0.35)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(Math.round(L.w * 0.06) + 0.5, 0);
    ctx.lineTo(Math.round(L.w * 0.06) + 0.5, L.h);
    ctx.stroke();

    // ── faint pencil doodles + eraser smudge, like an unused margin ──────
    ctx.strokeStyle = "rgba(90,100,120,0.16)";
    ctx.lineWidth = 1;
    for (let i = 0; i < 5; i++) {
      const dx0 = L.ox + mulberry32(1300 + i)() * (x1 - x0);
      const dy0 = L.oy + mulberry32(1400 + i)() * (y1 - y0);
      ctx.beginPath();
      ctx.moveTo(dx0, dy0);
      ctx.quadraticCurveTo(
        dx0 + cw * 0.8,
        dy0 - ch * 0.6,
        dx0 + cw * (1.2 + mulberry32(1500 + i)()),
        dy0 + ch * 0.3,
      );
      ctx.stroke();
    }
    ctx.fillStyle = "rgba(190,190,180,0.13)";
    ctx.beginPath();
    ctx.ellipse(L.w * 0.72, L.h * 0.24, L.cell * 1.3, L.cell * 0.5, 0.5, 0, 7);
    ctx.fill();
  } else if (A.id === "beach") {
    // The sea and the wet sand are built from layered SOLID bands: gradients
    // are avoided for the arena's identity layers so the look is identical in
    // every renderer (they are used only for soft accents elsewhere).
    const wetH = ch * 1.25;
    const surfBottom = y0 - wetH; // top of the wet sand

    if (surfBottom > 4) {
      // deep to shallow water
      const seaColors = ["#0f4f63", "#15617a", "#1c6f86", "#25899c", "#38a2ae", "#5fbcc0", "#93d5d2"];
      const bandH = surfBottom / seaColors.length;
      for (let i = 0; i < seaColors.length; i++) {
        ctx.fillStyle = seaColors[i];
        ctx.fillRect(0, Math.floor(i * bandH), L.w, Math.ceil(bandH) + 1);
      }
      // swell lines rolling in
      ctx.strokeStyle = "rgba(255,255,255,0.18)";
      ctx.lineWidth = 1.2;
      for (let i = 1; i < 10; i++) {
        const wy = (surfBottom / 10) * i + rand() * 3;
        ctx.beginPath();
        ctx.moveTo(0, wy);
        for (let x = 0; x <= L.w; x += L.w / 6) {
          ctx.quadraticCurveTo(x + L.w / 12, wy + (rand() - 0.5) * 5, x + L.w / 6, wy);
        }
        ctx.stroke();
      }
      // sun glitter on the water
      ctx.fillStyle = "rgba(255,255,245,0.8)";
      for (let i = 0; i < 280; i++) {
        ctx.globalAlpha = 0.12 + rand() * 0.45;
        ctx.fillRect(rand() * L.w, rand() * surfBottom, 1 + rand() * 2.2, 1);
      }
      ctx.globalAlpha = 1;
      // foam edge: a bright lace line where the water meets the beach
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.beginPath();
      ctx.moveTo(0, surfBottom + 2);
      for (let x = 0; x <= L.w; x += L.w / 26) {
        ctx.lineTo(x, surfBottom + Math.sin(x * 0.07) * 1.8 - rand() * 2.6);
      }
      ctx.lineTo(L.w, surfBottom + 2);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.5)";
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(0, surfBottom + 3.4);
      for (let x = 0; x <= L.w; x += L.w / 18) {
        ctx.lineTo(x, surfBottom + 3.4 + Math.sin(x * 0.05 + 1.7) * 2.2 + rand() * 1.6);
      }
      ctx.stroke();
    }

    // wet compacted sand: four translucent bands fading up the beach
    const wetBands = [0.52, 0.4, 0.27, 0.14];
    const wetBandH = wetH / wetBands.length;
    for (let i = 0; i < wetBands.length; i++) {
      ctx.fillStyle = `rgba(120,90,50,${wetBands[i]})`;
      ctx.fillRect(0, surfBottom + wetBandH * i, L.w, Math.ceil(wetBandH) + 1);
    }

    // wind ripples across the dry sand
    ctx.lineWidth = 1;
    for (let i = 0; i < 46; i++) {
      const ry = L.oy + rand() * (y1 - y0);
      const rx = L.ox - cw * 0.6 + rand() * (x1 - x0 + cw * 1.2);
      const rw = cw * (1.1 + rand() * 3.4);
      ctx.strokeStyle = rand() > 0.5 ? "rgba(255,250,228,0.16)" : "rgba(150,116,66,0.10)";
      ctx.beginPath();
      ctx.moveTo(rx, ry);
      ctx.quadraticCurveTo(rx + rw / 2, ry + (rand() - 0.5) * ch * 0.28, rx + rw, ry);
      ctx.stroke();
    }

    // cleat prints, mostly around the two goal areas
    for (let i = 0; i < 34; i++) {
      const nearGoal = rand() > 0.45;
      const px = L.ox + rand() * (x1 - x0);
      const py = nearGoal
        ? y0 + Math.pow(rand(), 2) * (y1 - y0) * 0.45 + ch * 0.3
        : y1 - Math.pow(rand(), 2) * (y1 - y0) * 0.45 - ch * 0.3;
      const ang = (rand() - 0.5) * 1.1;
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(ang);
      ctx.fillStyle = "rgba(112,84,46,0.22)";
      for (const dx of [-cw * 0.13, cw * 0.13]) {
        ctx.beginPath();
        ctx.ellipse(dx, 0, L.cell * 0.085, L.cell * 0.115, 0, 0, 7);
        ctx.fill();
      }
      ctx.restore();
    }

    // shells and pebbles
    for (let i = 0; i < 42; i++) {
      const sx = L.ox + rand() * (x1 - x0);
      const sy = L.oy + rand() * (y1 - y0);
      const sr = 1.1 + rand() * 2.4;
      if (rand() > 0.55) {
        // scallop shell
        ctx.fillStyle = "rgba(255,246,232,0.78)";
        ctx.beginPath();
        ctx.moveTo(sx, sy + sr);
        ctx.arc(sx, sy, sr, Math.PI * 0.15, Math.PI * 0.85, true);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = "rgba(190,165,125,0.5)";
        ctx.lineWidth = 0.6;
        for (let k = 1; k <= 2; k++) {
          ctx.beginPath();
          ctx.moveTo(sx, sy + sr);
          ctx.lineTo(sx + (k === 1 ? -sr * 0.5 : sr * 0.5), sy - sr * 0.35);
          ctx.stroke();
        }
      } else {
        ctx.fillStyle = rand() > 0.5 ? "rgba(120,104,86,0.5)" : "rgba(232,220,196,0.6)";
        ctx.beginPath();
        ctx.ellipse(sx, sy, sr, sr * 0.7, rand() * 3, 0, 7);
        ctx.fill();
      }
    }

    // sun-baked patches: subtle darker/warmer discs keep the sand from washing out
    ctx.save();
    ctx.fillStyle = "rgba(176,138,78,0.10)";
    ctx.beginPath();
    ctx.ellipse(L.w * 0.24, L.oy * 1.1, L.w * 0.34, L.oy * 0.66, 0, 0, 7);
    ctx.fill();
    ctx.ellipse(L.w * 0.78, L.oy * 0.62, L.w * 0.3, L.oy * 0.6, 0, 0, 7);
    ctx.fill();
    ctx.fillStyle = "rgba(255,240,196,0.10)";
    ctx.beginPath();
    ctx.ellipse(L.w * 0.55, L.oy * 0.35, L.w * 0.26, L.oy * 0.5, 0, 0, 7);
    ctx.fill();
    ctx.restore();
  } else if (A.id === "winter") {
    // ── Snowbanks and cleared snow mounds along all four outer perimeters ──
    for (const [sx, sy, sw, sh, isHoriz] of [
      [0, 0, L.w, L.oy * 0.95, true],
      [0, L.h - L.oy * 0.95, L.w, L.oy * 0.95, true],
      [0, 0, L.ox * 0.88, L.h, false],
      [L.w - L.ox * 0.88, 0, L.ox * 0.88, L.h, false],
    ] as [number, number, number, number, boolean][]) {
      const g = isHoriz
        ? ctx.createLinearGradient(0, sy, 0, sy + sh)
        : ctx.createLinearGradient(sx, 0, sx + sw, 0);
      if (isHoriz) {
        g.addColorStop(0, sy === 0 ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0)");
        g.addColorStop(1, sy === 0 ? "rgba(255,255,255,0)" : "rgba(255,255,255,0.85)");
      } else {
        g.addColorStop(0, sx === 0 ? "rgba(255,255,255,0.75)" : "rgba(255,255,255,0)");
        g.addColorStop(1, sx === 0 ? "rgba(255,255,255,0)" : "rgba(255,255,255,0.75)");
      }
      ctx.fillStyle = g;
      ctx.fillRect(sx, sy, sw, sh);
    }

    // Textured snow drifts with scalloped wavy mounds around perimeter
    ctx.fillStyle = "rgba(255, 255, 255, 0.45)";
    for (let i = 0; i < 28; i++) {
      const rx = rand() * L.w;
      const ry = rand() < 0.5 ? rand() * (L.oy * 0.8) : L.h - rand() * (L.oy * 0.8);
      const rw = L.cell * (1.2 + rand() * 2.2);
      ctx.beginPath();
      ctx.ellipse(rx, ry, rw, rw * 0.35, 0, 0, 7);
      ctx.fill();
    }

    // Translucent ice patches & frozen glazed crust beneath a skim of snow
    for (let i = 0; i < 16; i++) {
      const ix = L.ox + rand() * (x1 - x0);
      const iy = L.oy + rand() * (y1 - y0);
      const ir = L.cell * (0.65 + rand() * 1.6);
      const ig = ctx.createRadialGradient(ix - ir * 0.3, iy - ir * 0.3, 0, ix, iy, ir);
      ig.addColorStop(0, "rgba(240,253,255,0.42)");
      ig.addColorStop(0.45, "rgba(160,215,240,0.22)");
      ig.addColorStop(0.8, "rgba(110,180,215,0.08)");
      ig.addColorStop(1, "rgba(90,150,185,0)");
      ctx.fillStyle = ig;
      ctx.save();
      ctx.translate(ix, iy);
      ctx.scale(1, 0.45 + rand() * 0.25);
      ctx.beginPath();
      ctx.arc(0, 0, ir, 0, 7);
      ctx.fill();
      ctx.restore();
    }

    // Heavy mechanical snowplough brush streaks and tire treads in the snow
    ctx.strokeStyle = "rgba(255,255,255,0.24)";
    ctx.lineWidth = L.cell * 0.09;
    ctx.lineCap = "round";
    for (let i = 0; i < 40; i++) {
      const yy = L.oy + rand() * (y1 - y0);
      const xx = L.ox + rand() * cw * 1.5;
      ctx.beginPath();
      ctx.moveTo(xx, yy);
      ctx.lineTo(x1 - rand() * cw * 1.2, yy + (rand() - 0.5) * ch * 0.16);
      ctx.stroke();
    }

    // Sharp crystalline frost fractures spreading across the ice crust
    ctx.strokeStyle = "rgba(90,145,185,0.32)";
    ctx.lineWidth = 0.9;
    for (let i = 0; i < 20; i++) {
      let cx = L.ox + rand() * (x1 - x0);
      let cy = L.oy + rand() * (y1 - y0);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      for (let k = 0; k < 5; k++) {
        cx += (rand() - 0.5) * cw * 0.8;
        cy += (rand() - 0.5) * ch * 0.8;
        ctx.lineTo(cx, cy);
      }
      ctx.stroke();
    }

    // Diamond ice sparkle dusting across the entire snowfield
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    for (let i = 0; i < 1100; i++) {
      ctx.globalAlpha = 0.25 + rand() * 0.7;
      ctx.fillRect(rand() * L.w, rand() * L.h, rand() < 0.2 ? 1.6 : 1.1, rand() < 0.2 ? 1.6 : 1.1);
    }
    ctx.globalAlpha = 1;
  } else if (A.id === "night") {
    // Clean, uninterrupted night grass around the pitch: no grandstands,
    // seating tiers, roof silhouettes, spectator dots or LED boards.

    // ── 2. Four Corner Floodlight Masts (Вышки прожекторов) ───────────
    const masts = nightMastPositions(L);
  const compactLights = L.compact;
  const lightScale = compactLights ? 0.72 : 1;

    // Smooth volumetric light pools across the turf (feathered with no harsh wedge cuts)
    for (const m of masts) {
      const poolR = Math.max(L.w, L.h) * 0.72;
      const g = ctx.createRadialGradient(m.x, m.y, L.cell * 0.25, m.x, m.y, poolR);
      g.addColorStop(0, "rgba(225, 248, 255, 0.32)");
      g.addColorStop(0.2, "rgba(180, 230, 252, 0.14)");
      g.addColorStop(0.5, "rgba(130, 205, 245, 0.038)");
      g.addColorStop(1, "rgba(110, 190, 230, 0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, L.w, L.h);
    }

    // Steel lattice support structure for each floodlight tower
    for (const m of masts) {
      const gw = L.cell * 0.54 * lightScale;
      ctx.strokeStyle = "rgba(35, 50, 65, 0.9)";
      ctx.lineWidth = compactLights ? 1.2 : 1.8;
      ctx.beginPath();
      ctx.moveTo(m.ox, m.oy);
      ctx.lineTo(m.x - gw * 0.22, m.y);
      ctx.moveTo(m.ox, m.oy);
      ctx.lineTo(m.x + gw * 0.22, m.y);
      // Lattice cross rungs
      for (let s = 1; s <= 4; s++) {
        const u = s / 5;
        const lx1 = m.ox + (m.x - gw * 0.22 - m.ox) * u;
        const ly1 = m.oy + (m.y - m.oy) * u;
        const lx2 = m.ox + (m.x + gw * 0.22 - m.ox) * u;
        const ly2 = m.oy + (m.y - m.oy) * u;
        ctx.moveTo(lx1, ly1);
        ctx.lineTo(lx2, ly2);
      }
      ctx.stroke();
    }

    // High-tech floodlight gantry head for each mast. On touch-class layouts
    // the complete frame, bulbs and flare are proportionally compacted.
    for (const m of masts) {
      const gw = L.cell * 0.54 * lightScale;
      const gh = L.cell * 0.42 * lightScale;
      ctx.save();
      ctx.translate(m.x, m.y);

      // Steel gantry frame
      ctx.fillStyle = "#121a22";
      ctx.fillRect(-gw / 2, -gh / 2, gw, gh);
      ctx.strokeStyle = "#2c3b48";
      ctx.lineWidth = 1.2;
      ctx.strokeRect(-gw / 2, -gh / 2, gw, gh);

      // Lattice cross-bracing
      ctx.strokeStyle = "rgba(65, 85, 105, 0.7)";
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(-gw / 2, -gh / 2);
      ctx.lineTo(gw / 2, gh / 2);
      ctx.moveTo(gw / 2, -gh / 2);
      ctx.lineTo(-gw / 2, gh / 2);
      ctx.stroke();

      // Array of 4x3 intense LED projector bulbs
      const cols = 4;
      const rows = 3;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const bx = -gw / 2 + (gw / (cols + 1)) * (c + 1);
          const by = -gh / 2 + (gh / (rows + 1)) * (r + 1);
          const bulbR = L.cell * 0.12 * lightScale;
          const lg = ctx.createRadialGradient(bx, by, 0, bx, by, bulbR);
          lg.addColorStop(0, "rgba(255, 255, 255, 1)");
          lg.addColorStop(0.35, "rgba(200, 240, 255, 0.8)");
          lg.addColorStop(1, "rgba(150, 220, 255, 0)");
          ctx.fillStyle = lg;
          ctx.beginPath();
          ctx.arc(bx, by, bulbR, 0, 7);
          ctx.fill();
        }
      }

      // Lens-flare glow: kept fully on-canvas in compact layouts.
      const flareR = L.cell * (compactLights ? 0.46 : 0.85);
      const fg = ctx.createRadialGradient(0, 0, 0, 0, 0, flareR);
      fg.addColorStop(0, "rgba(255, 255, 255, 0.85)");
      fg.addColorStop(0.25, "rgba(205, 240, 255, 0.45)");
      fg.addColorStop(0.65, "rgba(140, 215, 255, 0.10)");
      fg.addColorStop(1, "rgba(100, 190, 245, 0)");
      ctx.fillStyle = fg;
      ctx.beginPath();
      ctx.arc(0, 0, flareR, 0, 7);
      ctx.fill();

      // Horizontal & vertical lens flare spikes
      const spikeX = L.cell * (compactLights ? 0.42 : 0.75);
      const spikeY = L.cell * (compactLights ? 0.34 : 0.6);
      ctx.strokeStyle = "rgba(225, 248, 255, 0.55)";
      ctx.lineWidth = compactLights ? 0.9 : 1.3;
      ctx.beginPath();
      ctx.moveTo(-spikeX, 0);
      ctx.lineTo(spikeX, 0);
      ctx.moveTo(0, -spikeY);
      ctx.lineTo(0, spikeY);
      ctx.stroke();

      ctx.restore();
    }

    // ── 3. Televised night match center pool ──────────────────────────
    const cg = ctx.createRadialGradient(midX, midY, 0, midX, midY, (x1 - x0) * 0.65);
    cg.addColorStop(0, "rgba(125, 225, 200, 0.09)");
    cg.addColorStop(0.55, "rgba(50, 130, 115, 0.03)");
    cg.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = cg;
    ctx.fillRect(0, 0, L.w, L.h);

    // ── 4. Dew glints on wet turf ──────────────────────────────────────
    ctx.fillStyle = "#e0f6ff";
    for (let i = 0; i < 160; i++) {
      const dx = L.ox + rand() * (x1 - x0);
      const dy = L.oy + rand() * (y1 - y0);
      ctx.globalAlpha = 0.12 + rand() * 0.28;
      ctx.beginPath();
      ctx.arc(dx, dy, 0.65, 0, 7);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Damp sheen streaks across the turf under the angled lights
    ctx.strokeStyle = "rgba(190, 235, 245, 0.045)";
    ctx.lineWidth = L.cell * 0.22;
    for (let i = 0; i < 10; i++) {
      const yy = L.oy + rand() * (y1 - y0);
      ctx.beginPath();
      ctx.moveTo(L.ox + rand() * cw * 2.5, yy);
      ctx.lineTo(x1 - rand() * cw * 2.5, yy + (rand() - 0.5) * ch * 0.35);
      ctx.stroke();
    }
  }

  // 4.5 · node grid (faint chalk lines + node dots under the mud and markings)
  drawNodeGrid(ctx, L, A, opts?.hideDots);

  // 5 · mud wear in heavy-traffic zones
  mudPatch(ctx, midX, midY, L.cell * 3.1, 1.0 * A.mudStrength, rand);
  mudPatch(ctx, midX, y0 + ch * 0.7, L.cell * 2.2, 0.9 * A.mudStrength, rand);
  mudPatch(ctx, midX, y1 - ch * 0.7, L.cell * 2.2, 0.9 * A.mudStrength, rand);
  // worn corridors from boxes to centre
  for (const dir of [-1, 1]) {
    for (let i = 0; i < 26; i++) {
      const t = rand();
      const wx = midX + (rand() - 0.5) * cw * 1.6;
      const wy = midY + dir * t * (L.rows - 1) * 0.5 * ch * 0.92;
      ctx.fillStyle = `rgba(${A.mud[0]},${A.mud[1]},${A.mud[2]},${(0.05 + rand() * 0.09) * A.mudStrength})`;
      ctx.beginPath();
      ctx.arc(wx, wy, 1 + rand() * 2.6, 0, 7);
      ctx.fill();
    }
  }

  // 6 · chalk markings — all dims are proportional to the pitch span,
  //    so 15×15 and 23×23 look like the same stadium, scaled.
  const span = L.cols - 1;
  const C = L.cell;
  const circleR = span * C * 0.16; // centre circle (= the "D" radius)
  const penHw = span * cw * 0.24; // penalty box half-width (node-consistent)
  const penD = span * ch * 0.17; // penalty box depth (node-consistent)
  const gaHw = cw * goalHalf(L.cols); // goal area half-width == goal mouth width
  const gaD = span * ch * 0.08;
  const spotOff = penD * 0.72; // penalty spot distance from the line
  const cornerR = span * C * 0.05;
  const cPts = (pts: [number, number][], close = false) => chalkPath(ctx, pts, L.cell, rand, close);
  cPts(
    [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ],
    true,
  );
  cPts([
    [x0, midY],
    [x1, midY],
  ]);
  chalkArc(ctx, midX, midY, circleR, 0, Math.PI * 2, L.cell, rand);
  ctx.fillStyle = chalkA(0.6);
  ctx.beginPath();
  ctx.arc(midX, midY, Math.max(2, L.cell * 0.1), 0, 7);
  ctx.fill();
  // penalty & goal areas
  cPts(
    [
      [midX - penHw, y0],
      [midX - penHw, y0 + penD],
      [midX + penHw, y0 + penD],
      [midX + penHw, y0],
    ],
  );
  cPts(
    [
      [midX - penHw, y1],
      [midX - penHw, y1 - penD],
      [midX + penHw, y1 - penD],
      [midX + penHw, y1],
    ],
  );
  cPts(
    [
      [midX - gaHw, y0],
      [midX - gaHw, y0 + gaD],
      [midX + gaHw, y0 + gaD],
      [midX + gaHw, y0],
    ],
  );
  cPts(
    [
      [midX - gaHw, y1],
      [midX - gaHw, y1 - gaD],
      [midX + gaHw, y1 - gaD],
      [midX + gaHw, y1],
    ],
  );
  // penalty spots + the "D" — drawn ONLY outside the box so the arc meets
  // the box edge but never crosses the rectangle (circle∩edge-line geometry).
  // The "D": circle centred on the spot, drawn only OUTSIDE the box.
  // Canvas angles: 0 = +x (right), +π/2 = +y (DOWN on screen).
  const dy = penD - spotOff; // spot → box edge (always positive)
  const dR = Math.max(circleR, dy * 1.15); // guarantee the circle actually reaches past the edge
  const dxI = Math.sqrt(Math.max(0, dR * dR - dy * dy));
  const aMeet = Math.atan2(dy, dxI); // |angle| where the circle meets the box edge
  for (const [sy, topGoal] of [
    [y0 + spotOff, true],
    [y1 - spotOff, false],
  ] as [number, boolean][]) {
    ctx.fillStyle = chalkA(0.55);
    ctx.beginPath();
    ctx.arc(midX, sy, Math.max(1.6, L.cell * 0.08), 0, 7);
    ctx.fill();
    if (topGoal) {
      // box lies ABOVE the spot (smaller y). Outside = below = positive angles.
      chalkArc(ctx, midX, sy, dR, aMeet, Math.PI - aMeet, L.cell, rand);
    } else {
      // box lies BELOW the spot. Outside = above = negative angles.
      chalkArc(ctx, midX, sy, dR, Math.PI + aMeet, Math.PI * 2 - aMeet, L.cell, rand);
    }
  }
  // corner arcs
  chalkArc(ctx, x0, y0, cornerR, 0, Math.PI / 2, L.cell, rand);
  chalkArc(ctx, x1, y0, cornerR, Math.PI / 2, Math.PI, L.cell, rand);
  chalkArc(ctx, x1, y1, cornerR, Math.PI, Math.PI * 1.5, L.cell, rand);
  chalkArc(ctx, x0, y1, cornerR, Math.PI * 1.5, Math.PI * 2, L.cell, rand);

  // 7 · rectangular goals + corner flags
  buildGoal(ctx, L, true, A);
  buildGoal(ctx, L, false, A);
  buildFlagSockets(ctx, L);

  // 8 · light sheen from top-left (fake PBR key light)
  const sheen = ctx.createLinearGradient(0, 0, L.w, L.h);
  sheen.addColorStop(0, A.sheenTop);
  sheen.addColorStop(0.4, "rgba(255,255,240,0.01)");
  sheen.addColorStop(1, "rgba(0,0,20,0.08)");
  ctx.fillStyle = sheen;
  ctx.fillRect(0, 0, L.w, L.h);

  // 9 · vignette
  const vig = ctx.createRadialGradient(L.w / 2, L.h / 2, Math.min(L.w, L.h) * 0.42, L.w / 2, L.h / 2, Math.max(L.w, L.h) * 0.75);
  vig.addColorStop(0, "rgba(0,0,0,0)");
  vig.addColorStop(1, `rgba(0,0,0,${A.vignette})`);
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, L.w, L.h);

  // 10 · film grain
  for (let i = 0; i < 2600; i++) {
    ctx.fillStyle = `rgba(${rand() > 0.5 ? "255,255,255" : "0,0,0"},${0.02 + rand() * 0.03})`;
    ctx.fillRect(rand() * L.w, rand() * L.h, 1.2, 1.2);
  }
  return c;
}
