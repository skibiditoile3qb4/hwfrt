// ============================================================
// weapons.js — weapon definitions, viewmodels, world pickups
// ============================================================
import * as THREE from "three";
import { pick, rand } from "./utils.js";

export const RARITY = {
  common: { name: "COMMON", color: 0xb8c0cc, css: "#b8c0cc" },
  uncommon: { name: "UNCOMMON", color: 0x52e07a, css: "#52e07a" },
  rare: { name: "RARE", color: 0x4fa8ff, css: "#4fa8ff" },
  epic: { name: "EPIC", color: 0xb464ff, css: "#b464ff" },
  legendary: { name: "LEGENDARY", color: 0xffb23d, css: "#ffb23d" },
};

// dmg = per pellet. fireT = seconds between shots.
export const WEAPONS = {
  pistol: {
    id: "pistol", name: "SIDEARM", short: "PISTOL", rarity: "common",
    dmg: 21, headMul: 2, pellets: 1, fireT: 0.19, auto: false, mag: 15,
    spread: 0.012, adsMul: 0.4, reload: 1.15, range: 130, bloomAdd: 0.005, bloomMax: 0.025,
    recoil: 0.34, kick: 0.0032, shake: 0.04, weight: 14, tracer: 0xffe9a8,
    botDmg: 11, botBurst: [2, 3], botGap: [0.4, 0.8], botCad: 0.19,
  },
  ar: {
    id: "ar", name: "ASSAULT RIFLE", short: "AR", rarity: "uncommon",
    dmg: 16, headMul: 2, pellets: 1, fireT: 0.105, auto: true, mag: 30,
    spread: 0.011, adsMul: 0.42, reload: 1.45, range: 240, bloomAdd: 0.0048, bloomMax: 0.03,
    recoil: 0.42, kick: 0.0042, shake: 0.055, weight: 22, tracer: 0xffe9a8,
    botDmg: 12, botBurst: [3, 6], botGap: [0.3, 0.6], botCad: 0.115,
  },
  smg: {
    id: "smg", name: "SUBMACHINE GUN", short: "SMG", rarity: "uncommon",
    dmg: 11, headMul: 1.7, pellets: 1, fireT: 0.066, auto: true, mag: 35,
    spread: 0.019, adsMul: 0.55, reload: 1.3, range: 110, bloomAdd: 0.005, bloomMax: 0.042,
    recoil: 0.3, kick: 0.0026, shake: 0.04, weight: 20, tracer: 0xfff0c0,
    botDmg: 8, botBurst: [5, 9], botGap: [0.35, 0.7], botCad: 0.07,
  },
  shotgun: {
    id: "shotgun", name: "PUMP SHOTGUN", short: "PUMP", rarity: "rare",
    dmg: 11, headMul: 1.5, pellets: 9, fireT: 0.85, auto: false, mag: 6,
    spread: 0.055, adsMul: 0.72, reload: 2.0, range: 45, bloomAdd: 0, bloomMax: 0,
    recoil: 1.15, kick: 0.012, shake: 0.2, weight: 14, tracer: 0xffd08a,
    botDmg: 6, botPellets: 6, botBurst: [1, 1], botGap: [0.85, 1.3], botCad: 0.85,
  },
  dmr: {
    id: "dmr", name: "MARKSMAN RIFLE", short: "DMR", rarity: "rare",
    dmg: 46, headMul: 2, pellets: 1, fireT: 0.3, auto: false, mag: 10,
    spread: 0.006, adsMul: 0.22, reload: 1.8, range: 300, bloomAdd: 0.004, bloomMax: 0.018,
    recoil: 0.75, kick: 0.008, shake: 0.1, weight: 12, tracer: 0xbfe9ff, zoom: 42,
    botDmg: 20, botBurst: [2, 3], botGap: [0.7, 1.2], botCad: 0.35,
  },
  sniper: {
    id: "sniper", name: "BOLT SNIPER", short: "SNIPER", rarity: "legendary",
    dmg: 105, headMul: 2, pellets: 1, fireT: 1.35, auto: false, mag: 5,
    spread: 0.0025, adsMul: 0.08, reload: 2.5, range: 400, bloomAdd: 0.004, bloomMax: 0.014,
    recoil: 1.4, kick: 0.016, shake: 0.26, weight: 6, tracer: 0x9fdcff, zoom: 22,
    botDmg: 34, botBurst: [1, 1], botGap: [1.3, 2.2], botCad: 1.35,
  },
};

export const STARTER = "pistol";
const LOOT_POOL = Object.values(WEAPONS).filter((w) => w.id !== "pistol");

export function rollWeapon() {
  let total = 0;
  for (const w of LOOT_POOL) total += w.weight;
  let r = Math.random() * total;
  for (const w of LOOT_POOL) { r -= w.weight; if (r <= 0) return w; }
  return WEAPONS.ar;
}

export function makeInstance(def) {
  return { def, ammo: def.mag, reloading: false, reloadT: 0 };
}

// ---------- shared colored-geometry helper ----------
const _c = new THREE.Color();
function tint(geo, hex) {
  _c.setHex(hex);
  const n = geo.attributes.position.count;
  const cols = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { cols[i * 3] = _c.r; cols[i * 3 + 1] = _c.g; cols[i * 3 + 2] = _c.b; }
  geo.setAttribute("color", new THREE.BufferAttribute(cols, 3));
  return geo;
}

let _vmMat = null;
function vmMat() {
  if (!_vmMat) _vmMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  return _vmMat;
}

// ---------- first-person viewmodels ----------
// Returns { group, muzzle: Vector3 (local) }
export function buildViewModel(id) {
  const g = new THREE.Group();
  const M = vmMat();
  const add = (w, h, d, x, y, z, hex) => {
    const m = new THREE.Mesh(tint(new THREE.BoxGeometry(w, h, d), hex), M);
    m.position.set(x, y, z);
    g.add(m);
    return m;
  };
  const DARK = 0x1c202a, MID = 0x39404e, BODY = 0x272c36, ACC = 0x3df5c4;
  let muzzle = new THREE.Vector3(0, 0.02, -0.66);

  if (id === "pistol") {
    add(0.075, 0.115, 0.34, 0, 0, -0.04, BODY);
    add(0.045, 0.045, 0.16, 0, 0.015, -0.26, DARK);
    add(0.065, 0.16, 0.085, 0, -0.12, 0.05, MID);
    add(0.025, 0.04, 0.05, 0, 0.085, -0.12, ACC);
    muzzle.set(0, 0.015, -0.36);
  } else if (id === "smg") {
    add(0.085, 0.12, 0.44, 0, 0, -0.04, BODY);
    add(0.05, 0.05, 0.2, 0, 0.015, -0.34, DARK);
    add(0.06, 0.22, 0.09, 0, -0.16, 0.0, MID);
    add(0.07, 0.1, 0.12, 0, -0.02, 0.22, MID);
    add(0.028, 0.05, 0.07, 0, 0.095, -0.16, ACC);
    muzzle.set(0, 0.015, -0.46);
  } else if (id === "shotgun") {
    add(0.1, 0.135, 0.68, 0, 0, -0.1, 0x5a3a24);
    add(0.07, 0.07, 0.42, 0, 0.035, -0.46, DARK);
    add(0.055, 0.055, 0.3, 0, -0.04, -0.42, MID);
    add(0.085, 0.13, 0.16, 0, -0.03, 0.26, 0x5a3a24);
    add(0.06, 0.06, 0.12, 0, -0.06, -0.2, ACC);
    muzzle.set(0, 0.035, -0.7);
  } else if (id === "dmr") {
    add(0.085, 0.125, 0.72, 0, 0, -0.1, BODY);
    add(0.05, 0.05, 0.36, 0, 0.02, -0.56, DARK);
    add(0.07, 0.15, 0.1, 0, -0.12, 0.04, MID);
    add(0.09, 0.075, 0.2, 0, 0.11, -0.2, DARK);
    add(0.045, 0.045, 0.1, 0, 0.11, -0.34, ACC);
    add(0.08, 0.11, 0.18, 0, -0.02, 0.3, MID);
    muzzle.set(0, 0.02, -0.78);
  } else if (id === "sniper") {
    add(0.085, 0.12, 0.9, 0, 0, -0.16, 0x2b3240);
    add(0.05, 0.05, 0.5, 0, 0.02, -0.75, DARK);
    add(0.07, 0.15, 0.1, 0, -0.12, 0.06, MID);
    add(0.1, 0.09, 0.3, 0, 0.125, -0.24, DARK);
    add(0.05, 0.05, 0.08, 0, 0.125, -0.42, ACC);
    add(0.085, 0.12, 0.22, 0, -0.03, 0.34, 0x2b3240);
    muzzle.set(0, 0.02, -1.0);
  } else {
    // assault rifle (default)
    add(0.09, 0.13, 0.62, 0, 0, -0.1, BODY);
    add(0.05, 0.05, 0.3, 0, 0.02, -0.48, DARK);
    add(0.07, 0.16, 0.1, 0, -0.12, 0.02, MID);
    add(0.03, 0.06, 0.08, 0, 0.1, -0.2, ACC);
    add(0.07, 0.13, 0.09, 0, -0.1, 0.16, DARK);
    add(0.08, 0.11, 0.14, 0, -0.02, 0.26, MID);
    muzzle.set(0, 0.02, -0.66);
  }
  g.traverse((m) => { m.frustumCulled = false; });
  return { group: g, muzzle };
}

// ---------- small world-item mesh (floating ground pickup) ----------
export function buildWorldGun(id, rarityHex) {
  const g = new THREE.Group();
  const M = vmMat();
  const add = (w, h, d, x, y, z, hex) => {
    const m = new THREE.Mesh(tint(new THREE.BoxGeometry(w, h, d), hex), M);
    m.position.set(x, y, z);
    m.castShadow = true;
    g.add(m);
  };
  const BODY = 0x2b3240, DARK = 0x15181f;
  if (id === "shotgun") { add(0.22, 0.3, 1.5, 0, 0, 0, 0x5a3a24); add(0.16, 0.16, 0.9, 0, 0.08, -0.5, DARK); }
  else if (id === "sniper") { add(0.2, 0.28, 2.0, 0, 0, 0, BODY); add(0.12, 0.12, 1.1, 0, 0.05, -0.75, DARK); add(0.24, 0.2, 0.6, 0, 0.28, -0.2, DARK); }
  else if (id === "dmr") { add(0.2, 0.28, 1.65, 0, 0, 0, BODY); add(0.12, 0.12, 0.8, 0, 0.05, -0.6, DARK); add(0.22, 0.18, 0.45, 0, 0.26, -0.15, DARK); }
  else if (id === "smg") { add(0.2, 0.28, 1.0, 0, 0, 0, BODY); add(0.14, 0.5, 0.2, 0, -0.35, 0.05, DARK); }
  else if (id === "pistol") { add(0.18, 0.26, 0.7, 0, 0, 0, BODY); add(0.16, 0.36, 0.2, 0, -0.28, 0.14, DARK); }
  else { add(0.2, 0.3, 1.4, 0, 0, 0, BODY); add(0.14, 0.14, 0.7, 0, 0.04, -0.5, DARK); add(0.16, 0.4, 0.22, 0, -0.3, 0.05, DARK); }
  // rarity glow ring
  const ringGeo = new THREE.TorusGeometry(0.62, 0.05, 6, 20);
  ringGeo.rotateX(Math.PI / 2);
  const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: rarityHex, transparent: true, opacity: 0.85 }));
  ring.position.y = -0.42;
  g.add(ring);
  // light beam
  const beamGeo = new THREE.CylinderGeometry(0.5, 0.62, 5.5, 12, 1, true);
  const beam = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({
    color: rarityHex, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  beam.position.y = 2.4;
  g.add(beam);
  g.scale.setScalar(0.62);
  return g;
}
