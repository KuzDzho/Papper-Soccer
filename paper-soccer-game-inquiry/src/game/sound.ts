/* ============================================================
 * PAPER SOCCER — procedural audio (client-only)
 * Everything is synthesized with WebAudio: no assets.
 * ============================================================ */

import { storageGet, storageSet } from "./storage";

class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  muted = false;

  constructor() {
    // Crash-proof read: localStorage throws outright in private/embedded modes.
    this.muted = storageGet("ps_muted") === "1";
  }

  unlock() {
    if (this.ctx) {
      if (this.ctx.state === "suspended") {
        try {
          void this.ctx.resume();
        } catch {
          // Audio blocked — the game stays silent but playable.
        }
      }
      return;
    }
    let AC: typeof AudioContext | undefined;
    try {
      AC =
        typeof window !== "undefined"
          ? window.AudioContext ??
            (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
          : undefined;
    } catch {
      AC = undefined;
    }
    if (!AC) return;
    try {
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.9;
      this.master.connect(this.ctx.destination);
      // 2s of white-ish noise for kicks / crowd / dust
      const len = this.ctx.sampleRate * 2;
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      let last = 0;
      for (let i = 0; i < len; i++) {
        const white = Math.random() * 2 - 1;
        last = (last + 0.02 * white) / 1.02; // pinkish
        d[i] = last * 3.2;
      }
    } catch {
      // AudioContext creation can fail (too many contexts, blocked autoplay
      // policy, headless quirks). Drop back to silence instead of crashing.
      this.ctx = null;
      this.master = null;
      this.noiseBuf = null;
    }
  }

  setMuted(m: boolean) {
    this.muted = m;
    storageSet("ps_muted", m ? "1" : "0");
    if (this.master && this.ctx) {
      this.master.gain.linearRampToValueAtTime(m ? 0 : 0.9, this.ctx.currentTime + 0.05);
    }
  }

  private env(gain: GainNode, t0: number, peak: number, attack: number, decay: number) {
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t0 + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
  }

  /** Boot thump — pitch drop + body noise. */
  kick(strength = 1) {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(150 + strength * 40, t);
    osc.frequency.exponentialRampToValueAtTime(42, t + 0.11);
    const g = this.ctx.createGain();
    this.env(g, t, 0.5 * strength, 0.004, 0.14);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.2);
    if (this.noiseBuf) {
      const n = this.ctx.createBufferSource();
      n.buffer = this.noiseBuf;
      const f = this.ctx.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.value = 900;
      const ng = this.ctx.createGain();
      this.env(ng, t, 0.16 * strength, 0.002, 0.05);
      n.connect(f).connect(ng).connect(this.master);
      n.start(t, Math.random());
      n.stop(t + 0.09);
    }
  }

  /** Tock off a wall / old ink. */
  bounce(i = 0) {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = "triangle";
    const f = 620 + (i % 5) * 90;
    osc.frequency.setValueAtTime(f, t);
    osc.frequency.exponentialRampToValueAtTime(f * 0.55, t + 0.06);
    const g = this.ctx.createGain();
    this.env(g, t, 0.14, 0.002, 0.07);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.1);
  }

  deny() {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = "square";
    osc.frequency.setValueAtTime(140, t);
    const g = this.ctx.createGain();
    this.env(g, t, 0.06, 0.003, 0.09);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.12);
  }

  ui() {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, t);
    const g = this.ctx.createGain();
    this.env(g, t, 0.07, 0.002, 0.05);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.08);
  }

  /** Coin toss — metallic ting with a couple of flip chirps. */
  coin() {
    if (!this.ctx || !this.master) return;
    const t0 = this.ctx.currentTime;
    // flip flutters
    for (let k = 0; k < 3; k++) {
      const t = t0 + k * 0.16;
      const osc = this.ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(1900 + k * 320, t);
      osc.frequency.exponentialRampToValueAtTime(3400, t + 0.05);
      const g = this.ctx.createGain();
      this.env(g, t, 0.09, 0.002, 0.06);
      osc.connect(g).connect(this.master);
      osc.start(t);
      osc.stop(t + 0.1);
    }
    // final ting
    const t = t0 + 0.5;
    for (const [f, peak, dec] of [
      [2500, 0.16, 0.5],
      [3760, 0.1, 0.38],
    ] as [number, number, number][]) {
      const osc = this.ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(f, t);
      osc.frequency.exponentialRampToValueAtTime(f * 1.004, t + dec);
      const g = this.ctx.createGain();
      this.env(g, t, peak, 0.003, dec);
      osc.connect(g).connect(this.master);
      osc.start(t);
      osc.stop(t + dec + 0.06);
    }
  }

  /** Referee whistle — vibrato sawtooth burst(s). */
  whistle(times = 1) {
    if (!this.ctx || !this.master) return;
    for (let k = 0; k < times; k++) {
      const t = this.ctx.currentTime + k * 0.34;
      const dur = k === times - 1 ? 0.42 : 0.2;
      const osc = this.ctx.createOscillator();
      osc.type = "square";
      osc.frequency.setValueAtTime(2300, t);
      const lfo = this.ctx.createOscillator();
      lfo.frequency.value = 34;
      const lfoG = this.ctx.createGain();
      lfoG.gain.value = 160;
      lfo.connect(lfoG).connect(osc.frequency);
      const bp = this.ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 2300;
      bp.Q.value = 6;
      const g = this.ctx.createGain();
      this.env(g, t, 0.16, 0.01, dur);
      osc.connect(bp).connect(g).connect(this.master);
      osc.start(t);
      lfo.start(t);
      osc.stop(t + dur + 0.05);
      lfo.stop(t + dur + 0.05);
    }
  }

  /** Stadium roar — filtered noise swell. */
  crowd(big = 1) {
    if (!this.ctx || !this.master || !this.noiseBuf) return;
    const t = this.ctx.currentTime;
    const n = this.ctx.createBufferSource();
    n.buffer = this.noiseBuf;
    n.loop = true;
    const bp = this.ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.setValueAtTime(500, t);
    bp.frequency.linearRampToValueAtTime(950, t + 0.7);
    bp.frequency.linearRampToValueAtTime(420, t + 2.4 * big);
    bp.Q.value = 0.9;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.4, t + 0.5);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.6 * big);
    n.connect(bp).connect(g).connect(this.master);
    n.start(t, Math.random());
    n.stop(t + 2.8 * big);
  }
}

export const sound = new SoundEngine();
