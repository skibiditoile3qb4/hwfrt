// ============================================================
// utils.js — math helpers, RNG, noise, spatial hash, pools
// ============================================================

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;

// ---------- deterministic RNG ----------
// Multiplayer REQUIRES both clients to generate an identical world, so all
// world/match randomness routes through a swappable seeded source instead of
// Math.random(). Call setSeed(n) before generating; resetSeed() restores
// true randomness for cosmetic-only effects.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let _rng = Math.random;
export function setSeed(seed) { _rng = mulberry32(seed >>> 0); }
export function resetSeed() { _rng = Math.random; }
export function random() { return _rng(); }
// Fixed island seed: every client generates the SAME map.
export const WORLD_SEED = 0x5747ba17;

export const rand = (a = 1, b) => (b === undefined ? _rng() * a : a + _rng() * (b - a));
export const randInt = (a, b) => Math.floor(rand(a, b + 1));
export const pick = (arr) => arr[(_rng() * arr.length) | 0];
export const TAU = Math.PI * 2;

export function dist2D(ax, az, bx, bz) {
  const dx = ax - bx, dz = az - bz;
  return Math.sqrt(dx * dx + dz * dz);
}

export function angleLerp(a, b, t) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return a + d * t;
}

// Smooth pseudo-noise from stacked trig octaves — deterministic & fast.
export function terrainNoise(x, z) {
  return (
    Math.sin(x * 0.018 + 1.7) * Math.cos(z * 0.021 - 0.6) * 0.55 +
    Math.sin(x * 0.0063 - z * 0.0077 + 0.4) * 0.9 +
    Math.sin((x + z) * 0.031 + 2.2) * 0.28 +
    Math.cos(x * 0.047 + z * 0.011) * 0.16
  );
}

// ---------- object pool ----------
export class Pool {
  constructor(create, reset, size = 16) {
    this.create = create;
    this.reset = reset;
    this.items = [];
    this.active = [];
    for (let i = 0; i < size; i++) this.items.push(create());
  }
  get() {
    const it = this.items.length ? this.items.pop() : this.create();
    this.active.push(it);
    return it;
  }
  release(it) {
    const i = this.active.indexOf(it);
    if (i >= 0) this.active.splice(i, 1);
    if (this.reset) this.reset(it);
    this.items.push(it);
  }
}
export const RELEASE_ALL = 1;

// ---------- spatial hash for static + dynamic colliders ----------
export class SpatialHash {
  constructor(cell = 8) {
    this.cell = cell;
    this.map = new Map();
  }
  key(cx, cz) { return cx * 73856093 ^ cz * 19349663; }
  clear() { this.map.clear(); }
  insert(item, minx, minz, maxx, maxz) {
    const c = this.cell;
    const x0 = Math.floor(minx / c), x1 = Math.floor(maxx / c);
    const z0 = Math.floor(minz / c), z1 = Math.floor(maxz / c);
    for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
      const k = this.key(cx, cz);
      let arr = this.map.get(k);
      if (!arr) { arr = []; this.map.set(k, arr); }
      arr.push(item);
    }
  }
  // Removes item from all buckets (uses stored cell range if provided)
  remove(item) {
    if (!item._cells) return;
    for (const k of item._cells) {
      const arr = this.map.get(k);
      if (arr) {
        const i = arr.indexOf(item);
        if (i >= 0) arr.splice(i, 1);
      }
    }
    item._cells = null;
  }
  insertTracked(item, minx, minz, maxx, maxz) {
    const c = this.cell;
    const x0 = Math.floor(minx / c), x1 = Math.floor(maxx / c);
    const z0 = Math.floor(minz / c), z1 = Math.floor(maxz / c);
    const cells = [];
    for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
      const k = this.key(cx, cz);
      cells.push(k);
      let arr = this.map.get(k);
      if (!arr) { arr = []; this.map.set(k, arr); }
      arr.push(item);
    }
    item._cells = cells;
  }
  // Gather candidate items near a circle into `out` (deduped via stamp)
  query(x, z, r, out) {
    out.length = 0;
    const c = this.cell;
    const x0 = Math.floor((x - r) / c), x1 = Math.floor((x + r) / c);
    const z0 = Math.floor((z - r) / c), z1 = Math.floor((z + r) / c);
    const stamp = SpatialHash._stamp++;
    for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
      const arr = this.map.get(this.key(cx, cz));
      if (!arr) continue;
      for (let i = 0; i < arr.length; i++) {
        const it = arr[i];
        if (it._q !== stamp) { it._q = stamp; out.push(it); }
      }
    }
    return out;
  }
}
SpatialHash._stamp = 1;

// ---------- ray intersection helpers ----------
// Slab test vs AABB {minX..maxZ}. Returns t in [0..maxT] or -1.
export function rayAABB(ox, oy, oz, dx, dy, dz, b, maxT) {
  let tmin = 0, tmax = maxT;
  // X
  if (Math.abs(dx) < 1e-8) { if (ox < b.minX || ox > b.maxX) return -1; }
  else {
    let t1 = (b.minX - ox) / dx, t2 = (b.maxX - ox) / dx;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
    if (tmin > tmax) return -1;
  }
  // Y
  if (Math.abs(dy) < 1e-8) { if (oy < b.minY || oy > b.maxY) return -1; }
  else {
    let t1 = (b.minY - oy) / dy, t2 = (b.maxY - oy) / dy;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
    if (tmin > tmax) return -1;
  }
  // Z
  if (Math.abs(dz) < 1e-8) { if (oz < b.minZ || oz > b.maxZ) return -1; }
  else {
    let t1 = (b.minZ - oz) / dz, t2 = (b.maxZ - oz) / dz;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
    if (tmin > tmax) return -1;
  }
  return tmin;
}

// Ray vs vertical cylinder (bots / player). Returns t or -1.
export function rayCylinderY(ox, oy, oz, dx, dy, dz, cx, cy, cz, r, h, maxT) {
  const fx = ox - cx, fz = oz - cz;
  const a = dx * dx + dz * dz;
  let t;
  if (a < 1e-8) {
    if (fx * fx + fz * fz > r * r) return -1;
    t = 0;
  } else {
    const b = 2 * (fx * dx + fz * dz);
    const c = fx * fx + fz * fz - r * r;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return -1;
    const sq = Math.sqrt(disc);
    t = (-b - sq) / (2 * a);
    if (t < 0) t = (-b + sq) / (2 * a);
    if (t < 0 || t > maxT) return -1;
  }
  const y = oy + dy * t;
  if (y < cy || y > cy + h) return -1;
  return t;
}

// Ray vs axis-aligned ellipsoid (sphere scaled on Y). Returns t or -1.
export function rayEllipsoid(ox, oy, oz, dx, dy, dz, cx, cy, cz, r, ry, maxT) {
  const k = r / (ry || r);
  const fx = ox - cx, fy = (oy - cy) * k, fz = oz - cz;
  const gy = dy * k;
  const a = dx * dx + gy * gy + dz * dz;
  if (a < 1e-9) return -1;
  const b = 2 * (fx * dx + fy * gy + fz * dz);
  const c = fx * fx + fy * fy + fz * fz - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return -1;
  const sq = Math.sqrt(disc);
  let t = (-b - sq) / (2 * a);
  if (t < 0) t = (-b + sq) / (2 * a);
  if (t < 0 || t > maxT) return -1;
  return t;
}

// Ray vs tapered cylinder / cone frustum (radius lerps r0@y0 -> r1@y1). t or -1.
export function rayTaperedCylinder(ox, oy, oz, dx, dy, dz, cx, cz, y0, y1, r0, r1, maxT) {
  const k = (r1 - r0) / Math.max(1e-6, y1 - y0);
  const fx = ox - cx, fz = oz - cz;
  const A = r0 + k * (oy - y0);
  const B = k * dy;
  const a = dx * dx + dz * dz - B * B;
  const b = 2 * (fx * dx + fz * dz - A * B);
  const c = fx * fx + fz * fz - A * A;
  let best = -1;
  const consider = (t) => {
    if (t < 0 || t > maxT) return;
    const y = oy + dy * t;
    if (y < y0 || y > y1) return;
    if (A + B * t < 0) return; // behind the apex
    if (best < 0 || t < best) best = t;
  };
  if (Math.abs(a) < 1e-9) {
    if (Math.abs(b) > 1e-9) consider(-c / b);
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      consider((-b - sq) / (2 * a));
      consider((-b + sq) / (2 * a));
    }
  }
  // end caps
  for (const [yc, rc] of [[y0, r0], [y1, r1]]) {
    if (Math.abs(dy) < 1e-9 || rc <= 0) continue;
    const t = (yc - oy) / dy;
    if (t < 0 || t > maxT) continue;
    const px = ox + dx * t - cx, pz = oz + dz * t - cz;
    if (px * px + pz * pz <= rc * rc && (best < 0 || t < best)) best = t;
  }
  return best;
}

// Horizontal radius of a collider at world height y (0 if outside its span).
export function radiusAtY(it, y) {
  if (it.kind === "sphere") {
    const dyn = (y - it.y) / it.ry;
    if (dyn <= -1 || dyn >= 1) return 0;
    return it.r * Math.sqrt(1 - dyn * dyn);
  }
  if (it.kind === "cone") {
    if (y < it.y0 || y > it.y1) return 0;
    const t = (y - it.y0) / Math.max(1e-6, it.y1 - it.y0);
    return it.r0 + (it.r1 - it.r0) * t;
  }
  if (it.kind === "circle") {
    if (y < it.y0 || y > it.y1) return 0;
    return it.r;
  }
  return 0;
}

export const BOT_NAMES = [
  "Vex", "Rook", "Nova", "Jinx", "Sable", "Onyx", "Flux", "Blitz", "Echo", "Drift",
  "Havoc", "Pyro", "Wraith", "Gale", "Rune", "Slate", "Ember", "Frost", "Jolt", "Mako",
  "Talon", "Apex", "Zero", "Riot", "Shade", "Bolt", "Comet", "Dagger", "Fable", "Ghost",
  "Havok", "Iris", "Jett", "Koda", "Lux", "Mist", "Nyra", "Orbit", "Punk", "Quill",
  "Razor", "Storm", "Trace", "Umbra", "Volt", "Wisp", "Xeno", "Yara", "Zephyr", "Cinder",
  "Ridge", "Surge",
];

export const STREAK_NAMES = ["", "", "DOUBLE KILL", "TRIPLE KILL", "RAMPAGE", "UNSTOPPABLE", "GODLIKE"];

export const DIFFICULTIES = {
  easy: {
    key: "easy", label: "RECRUIT", tag: "Bots are slow and sloppy. Learn the ropes.",
    reaction: 0.62, aimSpread: 0.115, burstGap: [0.55, 0.9], burstLen: [2, 4],
    dmgMul: 0.6, buildChance: 0.28, aggro: 0.55, spotRange: 80, color: "#3df5c4",
  },
  normal: {
    key: "normal", label: "VETERAN", tag: "A real fight. Bots track, strafe and build.",
    reaction: 0.38, aimSpread: 0.065, burstGap: [0.35, 0.65], burstLen: [3, 6],
    dmgMul: 1.0, buildChance: 0.55, aggro: 0.8, spotRange: 105, color: "#ffd166",
  },
  hard: {
    key: "hard", label: "LEGEND", tag: "Sweaty. Cracked aim, instant builds, no mercy.",
    reaction: 0.2, aimSpread: 0.034, burstGap: [0.22, 0.45], burstLen: [5, 9],
    dmgMul: 1.35, buildChance: 0.85, aggro: 1.0, spotRange: 130, color: "#ff5f6d",
  },
  god: {
    key: "god", label: "GOD", tag: "Inhuman reflexes. They pathfind, build to you, and never stop.",
    reaction: 0.09, aimSpread: 0.016, burstGap: [0.14, 0.3], burstLen: [7, 12],
    dmgMul: 1.6, buildChance: 1.0, aggro: 1.25, spotRange: 165, color: "#b464ff",
    structures: true, pathfind: true, eliteRate: 0.34,
  },
};
