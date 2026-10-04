/* ============================================================
 * PAPER SOCCER — arena themes (shared/visual)
 * Each arena is a palette + a few surface flags. The renderer stays
 * one code path; only colours, stripes and wear change.
 * ============================================================ */

export type ArenaId = "stadium" | "night" | "winter" | "beach" | "paper";

export interface Arena {
  id: ArenaId;
  name: string;
  tagline: string;
  /** base surface gradient stops */
  base: [string, string, string];
  /** mow-stripe light / dark overlays */
  stripeLight: string;
  stripeDark: string;
  stripes: boolean;
  /** speckle hue band (grass blades) */
  speckleHue: [number, number];
  speckleSat: number;
  speckleLight: [number, number];
  /** chalk line colour (rgb tuple) */
  chalk: [number, number, number];
  /** mud/wear colour + strength (0 disables) */
  mud: [number, number, number];
  mudStrength: number;
  /** node grid tint */
  grid: string;
  /** post-processing */
  sheenTop: string;
  vignette: number;
  /** grass-bounce light under the ball */
  bounceLight: string;
  /** menu swatch (CSS gradient) */
  swatch: string;
}

export const ARENAS: Arena[] = [
  {
    id: "stadium",
    name: "Стадион",
    tagline: "Классический газон, дневной свет",
    base: ["#2c7434", "#246829", "#1a5222"],
    stripeLight: "rgba(255,255,255,0.05)",
    stripeDark: "rgba(0,0,0,0.055)",
    stripes: true,
    speckleHue: [104, 130],
    speckleSat: 42,
    speckleLight: [18, 58],
    chalk: [252, 252, 246],
    mud: [101, 79, 50],
    mudStrength: 1,
    grid: "240,234,214",
    sheenTop: "rgba(255,255,240,0.075)",
    vignette: 0.42,
    bounceLight: "110,190,90",
    swatch: "linear-gradient(135deg,#2c7434 0%,#246829 50%,#1a5222 100%)",
  },
  {
    id: "night",
    name: "Ночной матч",
    tagline: "Мачты прожекторов, мягкие лучи, 4 тени и ночной туман",
    base: ["#0e3223", "#09271b", "#051811"],
    stripeLight: "rgba(180,240,220,0.035)",
    stripeDark: "rgba(0,0,0,0.06)",
    stripes: true,
    speckleHue: [145, 170],
    speckleSat: 22,
    speckleLight: [8, 24],
    chalk: [230, 248, 255],
    mud: [25, 35, 30],
    mudStrength: 0.65,
    grid: "180,235,225",
    sheenTop: "rgba(195,238,255,0.12)",
    vignette: 0.65,
    bounceLight: "70,185,160",
    swatch: "linear-gradient(135deg,#0e3223 0%,#09271b 50%,#051811 100%)",
  },
  {
    id: "winter",
    name: "Зимний",
    tagline: "Снегопад, позёмка, сугробы, искрящийся лёд и снежный след мяча",
    base: ["#dfe8ee", "#cfdbe3", "#b9c8d2"],
    stripeLight: "rgba(255,255,255,0.12)",
    stripeDark: "rgba(120,150,170,0.05)",
    stripes: true,
    speckleHue: [195, 215],
    speckleSat: 18,
    speckleLight: [70, 96],
    chalk: [70, 110, 150],
    mud: [110, 130, 120],
    mudStrength: 0.55,
    grid: "60,90,120",
    sheenTop: "rgba(255,255,255,0.28)",
    vignette: 0.25,
    bounceLight: "200,225,240",
    swatch: "linear-gradient(135deg,#eef3f6 0%,#cfdbe3 50%,#b9c8d2 100%)",
  },
  {
    id: "beach",
    name: "Пляж",
    tagline: "Тёплый песок, прибой, пена и чайки",
    base: ["#ecd6a2", "#e0c68c", "#caa96f"],
    stripeLight: "rgba(255,250,225,0.07)",
    stripeDark: "rgba(150,118,68,0.05)",
    stripes: true,
    speckleHue: [32, 52],
    speckleSat: 26,
    speckleLight: [60, 92],
    chalk: [255, 252, 238],
    mud: [146, 113, 66], // wet compacted sand
    mudStrength: 0.8,
    grid: "150,118,74",
    sheenTop: "rgba(255,242,200,0.13)",
    vignette: 0.28,
    bounceLight: "246,214,148",
    swatch: "linear-gradient(135deg,#ecd6a2 0%,#e0c68c 50%,#caa96f 100%)",
  },
  {
    id: "paper",
    name: "Тетрадный лист",
    tagline: "Клетка, ручка и школьная перемена",
    base: ["#f7f3e6", "#f1ecdc", "#e9e3d1"],
    stripeLight: "rgba(255,255,255,0.0)",
    stripeDark: "rgba(0,0,0,0.0)",
    stripes: false,
    speckleHue: [40, 50],
    speckleSat: 14,
    speckleLight: [70, 92],
    chalk: [50, 70, 130],
    mud: [120, 100, 70],
    mudStrength: 0.25,
    grid: "90,120,190",
    sheenTop: "rgba(255,255,255,0.12)",
    vignette: 0.22,
    bounceLight: "240,235,220",
    swatch: "linear-gradient(135deg,#faf6ea 0%,#f1ecdc 50%,#e9e3d1 100%)",
  },
];

export const DEFAULT_ARENA: ArenaId = "stadium";

export function getArena(id: string | null | undefined): Arena {
  // legacy ids kept as aliases so previously saved choices still resolve
  const alias: Record<string, ArenaId> = { street: "beach" };
  const key = id ? (alias[id] ?? id) : "";
  return ARENAS.find((a) => a.id === key) ?? ARENAS[0];
}
