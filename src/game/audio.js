// ============================================================
// audio.js — fully procedural WebAudio sound engine
// ============================================================

export class SoundEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.volume = 0.8;
    this._noiseBuf = null;
    this._stormNodes = null;
    this._stepFlip = false;
  }

  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
      // pre-render a noise buffer
      const len = this.ctx.sampleRate * 1.2;
      this._noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this._noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
    return true;
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  _env(node, t0, a, peak, d, end = 0.0001) {
    node.gain.setValueAtTime(0.0001, t0);
    node.gain.exponentialRampToValueAtTime(peak, t0 + a);
    node.gain.exponentialRampToValueAtTime(end, t0 + a + d);
  }

  _noise(t0, dur, { freq = 1200, q = 1, peak = 0.5, type = "lowpass", sweepTo = null } = {}) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this._noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t0);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t0 + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    this._env(g, t0, 0.004, peak, dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t0);
    src.stop(t0 + dur + 0.08);
  }

  _tone(t0, dur, { freq = 440, type = "sine", peak = 0.25, sweepTo = null, attack = 0.005 } = {}) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (sweepTo) o.frequency.exponentialRampToValueAtTime(Math.max(1, sweepTo), t0 + dur);
    const g = ctx.createGain();
    this._env(g, t0, attack, peak, dur);
    o.connect(g).connect(this.master);
    o.start(t0);
    o.stop(t0 + dur + 0.1);
  }

  // ---------- game SFX ----------
  shoot() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this._noise(t, 0.09, { freq: 3600, sweepTo: 700, peak: 0.32, q: 0.8 });
    this._tone(t, 0.07, { freq: 210, sweepTo: 70, type: "square", peak: 0.16 });
    this._tone(t, 0.05, { freq: 1400, sweepTo: 900, type: "triangle", peak: 0.1 });
  }

  enemyShoot(pan = 0, dist = 30) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const vol = Math.min(0.3, 12 / (dist + 8));
    this._noise(t, 0.08, { freq: 2600, sweepTo: 600, peak: vol, q: 0.7 });
  }

  dryFire() { if (!this.ctx) return; this._tone(this.ctx.currentTime, 0.05, { freq: 900, type: "square", peak: 0.08 }); }

  reload() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this._tone(t, 0.04, { freq: 620, type: "square", peak: 0.1 });
    this._tone(t + 0.16, 0.04, { freq: 480, type: "square", peak: 0.1 });
    this._noise(t + 0.3, 0.06, { freq: 1800, peak: 0.12 });
  }

  hitMarker() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this._tone(t, 0.045, { freq: 1750, type: "triangle", peak: 0.2 });
  }

  headshot() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this._tone(t, 0.05, { freq: 2300, type: "triangle", peak: 0.24 });
    this._tone(t + 0.02, 0.06, { freq: 1500, type: "triangle", peak: 0.14 });
  }

  kill() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this._tone(t, 0.09, { freq: 620, type: "triangle", peak: 0.3 });
    this._tone(t + 0.08, 0.16, { freq: 930, type: "triangle", peak: 0.3 });
    this._tone(t + 0.08, 0.2, { freq: 1240, type: "sine", peak: 0.15 });
  }

  damageTaken() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this._tone(t, 0.12, { freq: 190, sweepTo: 90, type: "sawtooth", peak: 0.24 });
    this._noise(t, 0.1, { freq: 500, peak: 0.18 });
  }

  shieldHit() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this._tone(t, 0.08, { freq: 980, sweepTo: 620, type: "sine", peak: 0.18 });
  }

  build() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this._noise(t, 0.07, { freq: 900, type: "bandpass", q: 1.6, peak: 0.3 });
    this._tone(t, 0.09, { freq: 170, sweepTo: 110, type: "sine", peak: 0.28 });
  }

  buildBreak() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this._noise(t, 0.16, { freq: 1400, sweepTo: 300, peak: 0.3, q: 0.6 });
    this._tone(t, 0.14, { freq: 140, sweepTo: 60, type: "triangle", peak: 0.2 });
  }

  jump() { if (!this.ctx) return; this._noise(this.ctx.currentTime, 0.07, { freq: 700, peak: 0.06 }); }
  land(hard = false) {
    if (!this.ctx) return;
    this._noise(this.ctx.currentTime, 0.1, { freq: 420, peak: hard ? 0.2 : 0.1 });
  }

  step() {
    if (!this.ctx) return;
    this._stepFlip = !this._stepFlip;
    this._noise(this.ctx.currentTime, 0.05, { freq: this._stepFlip ? 480 : 400, peak: 0.05, q: 0.6 });
  }

  pickup() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this._tone(t, 0.07, { freq: 780, type: "sine", peak: 0.18 });
    this._tone(t + 0.06, 0.12, { freq: 1170, type: "sine", peak: 0.16 });
  }

  countTick() { if (!this.ctx) return; this._tone(this.ctx.currentTime, 0.09, { freq: 700, type: "square", peak: 0.12 }); }
  countGo() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this._tone(t, 0.28, { freq: 660, type: "square", peak: 0.16 });
    this._tone(t, 0.3, { freq: 990, type: "triangle", peak: 0.2 });
  }

  streak() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this._tone(t, 0.08, { freq: 880, type: "triangle", peak: 0.2 });
    this._tone(t + 0.07, 0.08, { freq: 1100, type: "triangle", peak: 0.2 });
    this._tone(t + 0.14, 0.14, { freq: 1320, type: "triangle", peak: 0.22 });
  }

  win() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const seq = [523, 659, 784, 1046, 784, 1046];
    seq.forEach((f, i) => this._tone(t + i * 0.13, 0.24, { freq: f, type: "triangle", peak: 0.22 }));
  }

  lose() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const seq = [392, 330, 262, 196];
    seq.forEach((f, i) => this._tone(t + i * 0.16, 0.3, { freq: f, type: "triangle", peak: 0.2 }));
  }

  uiClick() { if (!this.ctx) return; this._tone(this.ctx.currentTime, 0.05, { freq: 1100, type: "triangle", peak: 0.1 }); }

  // Looping storm ambience — gain follows how deep in the storm you are.
  setStorm(intensity) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    if (!this._stormNodes && intensity > 0.01) {
      const src = this.ctx.createBufferSource();
      src.buffer = this._noiseBuf;
      src.loop = true;
      const f = this.ctx.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.value = 320;
      const g = this.ctx.createGain();
      g.gain.value = 0.0001;
      src.connect(f).connect(g).connect(this.master);
      src.start();
      this._stormNodes = { src, g };
    }
    if (this._stormNodes) {
      this._stormNodes.g.gain.setTargetAtTime(Math.min(0.4, intensity * 0.4), t, 0.3);
      if (intensity <= 0.01) {
        const nodes = this._stormNodes;
        setTimeout(() => { try { nodes.src.stop(); } catch (e) {} }, 600);
        this._stormNodes = null;
      }
    }
  }

  stopAll() {
    if (this._stormNodes) {
      try { this._stormNodes.src.stop(); } catch (e) {}
      this._stormNodes = null;
    }
  }
}
