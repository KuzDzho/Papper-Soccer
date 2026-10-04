/* ============================================================
 * PAPER SOCCER — particle systems & camera juice (client-only)
 * Units: node coordinates (1.0 = one cell). Rendered by Renderer.
 * ============================================================ */

export type ParticleKind =
  | "blade"
  | "dust"
  | "confetti"
  | "spark"
  | "mud"
  | "snow"
  | "sand"
  | "ink"
  | "fibre";

export interface Particle {
  kind: ParticleKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vr: number;
  life: number;
  ttl: number;
  size: number;
  color: string;
  z: number; // fake height for parabolic hops
  vz: number;
}

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const BLADE_COLORS = ["#3f8f3a", "#57a84b", "#2f7a31", "#6fbf5a", "#4b9440"];
const MUD_COLORS = ["#5d4a33", "#6e5a3e", "#4a3a28"];
const CONFETTI = ["#f5f1e6", "#ff6a2a", "#9fe870", "#ffd166", "#5ad2ff", "#ff4d6d"];
const SNOW_COLORS = ["#ffffff", "#f0f8ff", "#e6f2ff", "#d9ecff", "#eef6fc"];
const SAND_COLORS = ["#e6cf9a", "#dcc182", "#d2b46e", "#efdcae", "#c9a86a", "#e0c48a"];
const INK_COLORS = ["#2f3f7a", "#3a4d8f", "#26335f", "#41549b", "#1f2a4d"];
const FIBRE_COLORS = ["#fffdf4", "#f6f1e2", "#e9e3d1", "#fdfaf0"];

export class Particles {
  list: Particle[] = [];
  private cap = 900;

  clear() {
    this.list = [];
  }

  private push(p: Particle) {
    if (this.list.length >= this.cap) this.list.splice(0, this.list.length - this.cap + 1);
    this.list.push(p);
  }

  /** Torn grass, mud, or snow kicked up by the rolling ball depending on arena. */
  trail(x: number, y: number, dirX: number, dirY: number, n = 2, arena = "stadium") {
    if (arena === "winter") {
      // Exploding powder snow and ice specks kicking up from underneath the winter ball
      for (let i = 0; i < n * 2; i++) {
        const isClump = Math.random() < 0.35;
        this.push({
          kind: "snow",
          x: x + (Math.random() - 0.5) * 0.24,
          y: y + (Math.random() - 0.5) * 0.24,
          vx: -dirX * (0.8 + Math.random() * 2.2) + (Math.random() - 0.5) * 1.6,
          vy: -dirY * (0.8 + Math.random() * 2.2) + (Math.random() - 0.5) * 1.6,
          rot: Math.random() * Math.PI * 2,
          vr: (Math.random() - 0.5) * 18,
          life: 0,
          ttl: 0.45 + Math.random() * 0.55,
          size: isClump ? 0.04 + Math.random() * 0.045 : 0.02 + Math.random() * 0.03,
          color: SNOW_COLORS[(Math.random() * SNOW_COLORS.length) | 0],
          z: 0.02,
          vz: 1.8 + Math.random() * 2.6,
        });
      }
      return;
    }

    if (arena === "beach") {
      // Loose sand grains sprayed up as the ball ploughs across the beach
      for (let i = 0; i < n * 2; i++) {
        this.push({
          kind: "sand",
          x: x + (Math.random() - 0.5) * 0.22,
          y: y + (Math.random() - 0.5) * 0.22,
          vx: -dirX * (0.7 + Math.random() * 1.9) + (Math.random() - 0.5) * 1.5,
          vy: -dirY * (0.7 + Math.random() * 1.9) + (Math.random() - 0.5) * 1.5,
          rot: Math.random() * Math.PI * 2,
          vr: (Math.random() - 0.5) * 10,
          life: 0,
          ttl: 0.38 + Math.random() * 0.42,
          size: 0.014 + Math.random() * 0.03,
          color: SAND_COLORS[(Math.random() * SAND_COLORS.length) | 0],
          z: 0.01,
          vz: 1.4 + Math.random() * 2.2,
        });
      }
      return;
    }

    if (arena === "paper") {
      // Ink droplets flick off the ball and paper fibres / eraser crumbs flutter up
      for (let i = 0; i < n * 2; i++) {
        const ink = Math.random() < 0.6;
        this.push({
          kind: ink ? "ink" : "fibre",
          x: x + (Math.random() - 0.5) * 0.2,
          y: y + (Math.random() - 0.5) * 0.2,
          vx: -dirX * (0.75 + Math.random() * 1.7) + (Math.random() - 0.5) * 1.3,
          vy: -dirY * (0.75 + Math.random() * 1.7) + (Math.random() - 0.5) * 1.3,
          rot: Math.random() * Math.PI * 2,
          vr: (Math.random() - 0.5) * 12,
          life: 0,
          ttl: ink ? 0.4 + Math.random() * 0.4 : 0.7 + Math.random() * 0.6,
          size: ink ? 0.022 + Math.random() * 0.036 : 0.016 + Math.random() * 0.022,
          color: ink ? INK_COLORS[(Math.random() * INK_COLORS.length) | 0] : FIBRE_COLORS[(Math.random() * FIBRE_COLORS.length) | 0],
          z: 0.01,
          vz: ink ? 1.3 + Math.random() * 2.1 : 0.9 + Math.random() * 1.5,
        });
      }
      return;
    }

    for (let i = 0; i < n; i++) {
      const blade = Math.random() < 0.7;
      this.push({
        kind: blade ? "blade" : "mud",
        x: x + (Math.random() - 0.5) * 0.22,
        y: y + (Math.random() - 0.5) * 0.22,
        vx: -dirX * (0.6 + Math.random() * 1.6) + (Math.random() - 0.5) * 1.4,
        vy: -dirY * (0.6 + Math.random() * 1.6) + (Math.random() - 0.5) * 1.4,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 14,
        life: 0,
        ttl: 0.5 + Math.random() * 0.6,
        size: blade ? 0.045 + Math.random() * 0.05 : 0.03 + Math.random() * 0.04,
        color: blade
          ? BLADE_COLORS[(Math.random() * BLADE_COLORS.length) | 0]
          : MUD_COLORS[(Math.random() * MUD_COLORS.length) | 0],
        z: 0,
        vz: 2.2 + Math.random() * 2.4,
      });
    }
  }

  /** Chalk dust puffed when a line is etched or the ball rebounds. */
  burst(x: number, y: number, n = 10, color = "rgba(245,241,230,0.85)") {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 0.6 + Math.random() * 2.6;
      this.push({
        kind: "dust",
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        rot: 0,
        vr: 0,
        life: 0,
        ttl: 0.45 + Math.random() * 0.5,
        size: 0.05 + Math.random() * 0.12,
        color,
        z: 0.05,
        vz: 0.6 + Math.random() * 0.9,
      });
    }
  }

  goalConfetti(x: number, y: number) {
    for (let i = 0; i < 160; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.4;
      const sp = 3 + Math.random() * 7;
      this.push({
        kind: "confetti",
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 20,
        life: 0,
        ttl: 1.6 + Math.random() * 1.4,
        size: 0.05 + Math.random() * 0.09,
        color: CONFETTI[(Math.random() * CONFETTI.length) | 0],
        z: 0.2,
        vz: 4 + Math.random() * 6,
      });
    }
  }

  update(dt: number) {
    const g = 9.8;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      p.life += dt;
      if (p.life >= p.ttl) {
        this.list[i] = this.list[this.list.length - 1];
        this.list.pop();
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      if (p.kind === "confetti") {
        p.vz -= g * 0.6 * dt;
        p.vx *= 1 - 1.6 * dt;
        p.vy *= 1 - 1.6 * dt;
        p.z += p.vz * dt;
        p.x += Math.sin(p.life * 9 + p.rot) * dt * 0.5; // flutter
        if (p.z < 0) {
          p.z = 0;
          p.vz *= -0.3;
        }
      } else if (p.kind === "snow") {
        p.vz -= g * 0.85 * dt;
        p.z += p.vz * dt;
        p.vx *= 1 - 2.8 * dt;
        p.vy *= 1 - 2.8 * dt;
        // slight turbulent swirl as snow sprays outward
        p.x += Math.cos(p.rot) * 0.3 * dt;
        p.y += Math.sin(p.rot) * 0.3 * dt;
        if (p.z < 0) {
          p.z = 0;
          p.vz *= -0.22;
          p.vx *= 0.5;
          p.vy *= 0.5;
        }
      } else if (p.kind === "ink") {
        // Heavy ink: drops fast, splats and stays put
        p.vz -= g * 1.1 * dt;
        p.z += p.vz * dt;
        p.vx *= 1 - 3.4 * dt;
        p.vy *= 1 - 3.4 * dt;
        if (p.z < 0) {
          p.z = 0;
          p.vz = 0;
          p.vx *= 0.25;
          p.vy *= 0.25;
        }
      } else if (p.kind === "fibre") {
        // Light paper fluff: floats, flutters, drifts down slowly
        p.vz -= g * 0.3 * dt;
        p.z += p.vz * dt;
        p.vx *= 1 - 1.2 * dt;
        p.vy *= 1 - 1.2 * dt;
        p.x += Math.sin(p.life * 8 + p.rot) * dt * 0.35;
        if (p.z < 0) {
          p.z = 0;
          p.vz *= -0.25;
        }
      } else {
        p.vz -= g * dt;
        p.z += p.vz * dt;
        if (p.z < 0) {
          p.z = 0;
          p.vz *= -0.35;
          p.vx *= 0.6;
          p.vy *= 0.6;
        }
        p.vx *= 1 - 2.2 * dt;
        p.vy *= 1 - 2.2 * dt;
      }
    }
  }
}

/** Decaying trauma-based screen shake. */
export class Shake {
  trauma = 0;
  add(amount: number) {
    this.trauma = Math.min(1, this.trauma + amount);
  }
  update(dt: number) {
    this.trauma = Math.max(0, this.trauma - dt * 1.4);
  }
  offset(t: number): { x: number; y: number; r: number } {
    const s = this.trauma * this.trauma;
    return {
      x: Math.sin(t * 91.7) * 14 * s,
      y: Math.cos(t * 83.3) * 12 * s,
      r: Math.sin(t * 67.1) * 0.006 * s,
    };
  }
}
