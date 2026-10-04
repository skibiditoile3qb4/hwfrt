// ============================================================
// world.js — island terrain, sky, ocean, forests, towns
// ============================================================
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { SpatialHash, terrainNoise, clamp, lerp, rand, randInt, pick, setSeed, resetSeed, WORLD_SEED } from "./utils.js";

export const ISLAND_R = 300;

// ---------- terrain height (single source of truth) ----------
export function heightAt(x, z) {
  const d = Math.sqrt(x * x + z * z);
  const f = clamp(1 - Math.pow(d / ISLAND_R, 2.6), 0, 1);
  const hills = terrainNoise(x * 0.6, z * 0.6) * 4.6 + terrainNoise(x * 2.2 + 57, z * 2.2 - 31) * 1.35;
  const centerLift = Math.exp(-(d * d) / (2 * 90 * 90)) * 3.2;
  let h = (hills + 1.6 + centerLift) * f - (1 - f) * 9.0;
  return h;
}

// ---------- geometry helpers ----------
const _m4 = new THREE.Matrix4();
const _col = new THREE.Color();

function coloredBox(list, w, h, d, x, y, z, ry, hex) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.rotateY(ry);
  g.translate(x, y, z);
  _col.setHex(hex);
  const n = g.attributes.position.count;
  const cols = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { cols[i * 3] = _col.r; cols[i * 3 + 1] = _col.g; cols[i * 3 + 2] = _col.b; }
  g.setAttribute("color", new THREE.BufferAttribute(cols, 3));
  list.push(g);
}

// ============================================================
// addSolid — the ONLY way structures should be built.
// Emits the visual box AND an exactly-matching AABB collider, so a
// hitbox can never drift from what you see. Rotation is restricted to
// 90° steps (quarter turns) because AABBs cannot represent other angles.
// ============================================================
function addSolid(statics, world, w, h, d, x, y, z, hex, tag, quarterTurns = 0) {
  const q = ((quarterTurns % 4) + 4) % 4;
  const ry = q * (Math.PI / 2);
  const swap = q === 1 || q === 3;
  const cw = swap ? d : w;
  const cd = swap ? w : d;
  coloredBox(statics, w, h, d, x, y, z, ry, hex);
  addBoxCollider(world, x, y, z, cw, h, cd, tag);
}

function addBoxCollider(world, cx, cy, cz, w, h, d, tag) {
  const box = {
    kind: "box", tag,
    minX: cx - w / 2, maxX: cx + w / 2,
    minY: cy - h / 2, maxY: cy + h / 2,
    minZ: cz - d / 2, maxZ: cz + d / 2,
  };
  world.colliders.insertTracked(box, box.minX, box.minZ, box.maxX, box.maxZ);
  return box;
}

// ============================================================
// STRUCTURE GENERATORS
// Every piece goes through addSolid(), so visuals and hitboxes are
// generated from the same numbers and can never disagree.
// Staircases always rise in <=0.8 steps (step limit is 1.15) and
// every landing is reachable from the step below it.
// ============================================================

// Solid staircase ASCENDING toward (tx,tz) and finishing flush with deckY.
// Steps are generated from the TOP down, so the flight always lands exactly
// on the deck and the lowest step is only `rise` above the base — meaning
// every flight is guaranteed climbable (rise must stay under the 1.15 step cap).
// Blocks extend to groundY so nothing is ever hollow underneath.
function addStairs(statics, world, deckX, deckY, deckZ, outX, outZ, steps, stepRun, width, hex, tag, groundY) {
  const rise = null; // derived below
  const baseY = groundY != null ? groundY : heightAt(deckX, deckZ);
  const stepRise = (deckY - baseY) / steps;
  for (let i = 0; i < steps; i++) {
    // i = 0 is the step adjacent to the deck (tallest)
    const top = deckY - stepRise * i;
    const cx = deckX + outX * (i + 0.5) * stepRun;
    const cz = deckZ + outZ * (i + 0.5) * stepRun;
    const w = outX !== 0 ? stepRun : width;
    const d = outX !== 0 ? width : stepRun;
    const bottom = baseY - 4;
    addSolid(statics, world, w, top - bottom, d, cx, (top + bottom) / 2, cz, hex, tag);
  }
  void rise;
  return stepRise;
}

// Hollow room: 4 walls on a slab with a doorway gap on the -Z side.
function addRoom(statics, world, cx, baseY, cz, W, D, H, t, hex, roofHex, tag, doorW = 1.8) {
  // floor slab
  addSolid(statics, world, W, 0.4, D, cx, baseY + 0.2, cz, 0xb9a98d, tag);
  const wy = baseY + 0.4 + H / 2;
  // back / left / right walls
  addSolid(statics, world, W, H, t, cx, wy, cz + D / 2 - t / 2, hex, tag);
  addSolid(statics, world, t, H, D - t * 2, cx - W / 2 + t / 2, wy, cz, hex, tag);
  addSolid(statics, world, t, H, D - t * 2, cx + W / 2 - t / 2, wy, cz, hex, tag);
  // front wall with a door gap
  const side = (W - doorW) / 2;
  if (side > 0.05) {
    addSolid(statics, world, side, H, t, cx - (doorW / 2 + side / 2), wy, cz - D / 2 + t / 2, hex, tag);
    addSolid(statics, world, side, H, t, cx + (doorW / 2 + side / 2), wy, cz - D / 2 + t / 2, hex, tag);
  }
  // lintel over the door
  const lintel = H * 0.3;
  addSolid(statics, world, doorW, lintel, t, cx, baseY + 0.4 + H - lintel / 2, cz - D / 2 + t / 2, hex, tag);
  // roof (walkable)
  const roofY = baseY + 0.4 + H + 0.18;
  addSolid(statics, world, W + 0.7, 0.36, D + 0.7, cx, roofY, cz, roofHex, tag);
  return roofY + 0.18;
}

// --- THE CITADEL: multi-level keep with real rooms and climbable access ---
function buildCitadel(statics, world, cx, cz) {
  const base = heightAt(cx, cz);
  const STONE = 0x9aa3bd, STONE2 = 0x8690ad, TRIM = 0xb8c0d8, ROOF = 0x6c7793;

  // --- tier 1: solid plinth 26x26, 1.2 tall ---
  addSolid(statics, world, 26, 1.2 + 4, 26, cx, base + 0.6 - 2, cz, STONE, "citadel");
  const t1 = base + 1.2;

  // approach stairs on all four sides, landing flush on the plinth
  addStairs(statics, world, cx, t1, cz - 13, 0, -1, 2, 1.7, 7, TRIM, "citadel", base);
  addStairs(statics, world, cx, t1, cz + 13, 0, 1, 2, 1.7, 7, TRIM, "citadel", base);
  addStairs(statics, world, cx - 13, t1, cz, -1, 0, 2, 1.7, 7, TRIM, "citadel", base);
  addStairs(statics, world, cx + 13, t1, cz, 1, 0, 2, 1.7, 7, TRIM, "citadel", base);

  // --- tier 1 perimeter battlements (cover, with firing gaps) ---
  const bh = 1.5, bt = 0.7;
  for (let i = -2; i <= 2; i++) {
    const off = i * 4.6;
    addSolid(statics, world, 3.2, bh, bt, cx + off, t1 + bh / 2, cz - 12.6, STONE2, "citadel");
    addSolid(statics, world, 3.2, bh, bt, cx + off, t1 + bh / 2, cz + 12.6, STONE2, "citadel");
    addSolid(statics, world, bt, bh, 3.2, cx - 12.6, t1 + bh / 2, cz + off, STONE2, "citadel");
    addSolid(statics, world, bt, bh, 3.2, cx + 12.6, t1 + bh / 2, cz + off, STONE2, "citadel");
  }

  // --- tier 2: inner keep 15x15, reached by stairs from tier 1 ---
  const t2 = t1 + 3.6;
  addSolid(statics, world, 15, 3.6 + 4, 15, cx, t1 + 1.8 - 2, cz, STONE, "citadel");
  // stairs tier1 -> tier2, fitted ON the plinth (5 steps x 0.72 rise)
  addStairs(statics, world, cx - 7.5, t2, cz, -1, 0, 5, 1.05, 4.4, TRIM, "citadel", t1);
  addStairs(statics, world, cx + 7.5, t2, cz, 1, 0, 5, 1.05, 4.4, TRIM, "citadel", t1);

  // tier 2 battlements
  for (let i = -1; i <= 1; i++) {
    const off = i * 5.0;
    addSolid(statics, world, 3.4, bh, bt, cx + off, t2 + bh / 2, cz - 7.2, STONE2, "citadel");
    addSolid(statics, world, 3.4, bh, bt, cx + off, t2 + bh / 2, cz + 7.2, STONE2, "citadel");
    addSolid(statics, world, bt, bh, 3.4, cx - 7.2, t2 + bh / 2, cz + off, STONE2, "citadel");
    addSolid(statics, world, bt, bh, 3.4, cx + 7.2, t2 + bh / 2, cz + off, STONE2, "citadel");
  }

  // --- central tower: a real hollow room you can enter, with a roof deck ---
  const roofDeck = addRoom(statics, world, cx, t2, cz, 9, 9, 3.4, 0.5, TRIM, ROOF, "citadel", 2.2);
  // stairs tier2 -> tower roof, hugging the +Z face (door is on -Z, so clear)
  addStairs(statics, world, cx, roofDeck, cz + 5.0, 0, 1, 6, 0.42, 3.2, STONE2, "citadel", t2);

  // --- crow's nest on top ---
  addSolid(statics, world, 5, 0.4, 5, cx, roofDeck + 0.2, cz, TRIM, "citadel");
  for (const [ox, oz] of [[-2.2, -2.2], [2.2, -2.2], [-2.2, 2.2], [2.2, 2.2]]) {
    addSolid(statics, world, 0.5, 1.3, 0.5, cx + ox, roofDeck + 1.05, cz + oz, STONE2, "citadel");
  }

  world.pois.push({ name: "THE CITADEL", x: cx, z: cz });
  world.lootSpots.push({ x: cx, y: t2 + 1.2, z: cz });
  world.lootSpots.push({ x: cx + 3, y: t1 + 0.9, z: cz - 3 });
  world.lootSpots.push({ x: cx, y: roofDeck + 0.9, z: cz });
  world.lootSpots.push({ x: cx - 9, y: t1 + 0.9, z: cz + 9 });
}

// --- WATCHTOWER: 4 legs, mid platform, top deck, stair access ---
function buildWatchtower(statics, world, cx, cz) {
  const base = heightAt(cx, cz);
  if (base < 1) return;
  const WOOD = 0x9a7850, WOOD2 = 0x7d6140, DECK = 0xb49068;
  const legs = 2.6;
  for (const [ox, oz] of [[-legs, -legs], [legs, -legs], [-legs, legs], [legs, legs]]) {
    addSolid(statics, world, 0.7, 10 + 4, 0.7, cx + ox, base + 5 - 2, cz + oz, WOOD2, "tower");
  }
  // mid platform @ +4.2 and top deck @ +8.4
  addSolid(statics, world, 6.6, 0.4, 6.6, cx, base + 4.2, cz, DECK, "tower");
  addSolid(statics, world, 6.6, 0.4, 6.6, cx, base + 8.4, cz, DECK, "tower");
  // railings on the top deck (with gaps to shoot through)
  for (const i of [-1, 1]) {
    addSolid(statics, world, 6.6, 1.1, 0.35, cx, base + 8.95, cz + i * 3.1, WOOD, "tower");
    addSolid(statics, world, 0.35, 1.1, 6.6, cx + i * 3.1, base + 8.95, cz, WOOD, "tower");
  }
  // ground -> mid deck: a proper flight landing flush at +4.2
  addStairs(statics, world, cx - 3.3, base + 4.2, cz, -1, 0, 6, 1.15, 2.6, WOOD, "tower", base);
  // mid -> top: spiralling landings around the legs, 0.7 apart (steppable)
  const ring = [[3.0, 0], [0, 3.0], [-3.0, 0], [0, -3.0], [3.0, 0], [0, 3.0]];
  for (let i = 0; i < 6; i++) {
    const [ox, oz] = ring[i];
    const y = base + 4.2 + (i + 1) * 0.7;
    if (y > base + 8.4) break;
    addSolid(statics, world, ox === 0 ? 3.4 : 2.2, 0.32, oz === 0 ? 3.4 : 2.2, cx + ox, y, cz + oz, DECK, "tower");
  }
  world.lootSpots.push({ x: cx, y: base + 9.1, z: cz });
  world.lootSpots.push({ x: cx + 1.5, y: base + 4.9, z: cz });
}

// --- CONTAINER YARD: stacked boxes = instant cover + rooftops ---
function buildContainerYard(statics, world, cx, cz) {
  const base = heightAt(cx, cz);
  if (base < 1) return;
  const COLS = [0xc1553f, 0x3f7fc1, 0x4fa05c, 0xd0a53c, 0x8a5fb0];
  const CW = 2.6, CH = 2.5, CD = 6.2;
  const layout = [
    [-5, -4, 0, 0], [-5, 2, 0, 0], [0, -6, 1, 0], [0, 0, 1, 0],
    [5, -3, 0, 0], [5, 3, 0, 0], [-5, -4, 0, 1], [0, 0, 1, 1], [5, 3, 0, 2],
  ];
  for (const [ox, oz, turn, level] of layout) {
    const y = base + 0.1 + CH / 2 + level * CH;
    addSolid(statics, world, CW, CH, CD, cx + ox, y, cz + oz, pick(COLS), "container", turn === 1 ? 1 : 0);
  }
  // stairs onto the stacks (lands flush on the first container roof)
  addStairs(statics, world, cx - 6.4, base + 0.1 + CH, cz - 4, -1, 0, 4, 1.2, 3, 0x8d9199, "container", base);
  world.lootSpots.push({ x: cx, y: base + 2 * CH + 0.9, z: cz });
  world.lootSpots.push({ x: cx + 5, y: base + 0.9, z: cz });
}

// --- BUNKER: squat concrete block with a roof deck and side entries ---
function buildBunker(statics, world, cx, cz) {
  const base = heightAt(cx, cz);
  if (base < 1) return;
  const CON = 0x9c9f98, CON2 = 0x85887f;
  const top = addRoom(statics, world, cx, base, cz, 11, 8, 2.6, 0.7, CON, CON2, "bunker", 2.0);
  // roof parapet with firing slits
  for (const i of [-1, 1]) {
    addSolid(statics, world, 11.7, 0.9, 0.5, cx, top + 0.45, cz + i * 3.9, CON2, "bunker");
  }
  addSolid(statics, world, 0.5, 0.9, 8.7, cx - 5.9, top + 0.45, cz, CON2, "bunker");
  addSolid(statics, world, 0.5, 0.9, 8.7, cx + 5.9, top + 0.45, cz, CON2, "bunker");
  // external stairs to the roof (lands flush on the deck)
  addStairs(statics, world, cx + 6.2, top, cz, 1, 0, 5, 1.15, 2.6, CON, "bunker", base);
  world.lootSpots.push({ x: cx, y: base + 1.1, z: cz });
  world.lootSpots.push({ x: cx - 2, y: top + 0.9, z: cz });
}

// --- SILO: tall round-ish tower with an external spiral of landings ---
function buildSilo(statics, world, cx, cz) {
  const base = heightAt(cx, cz);
  if (base < 1) return;
  const MET = 0xc3c7cc, MET2 = 0x9aa0a8, CAP = 0xa8552f;
  // body (octagon approximated by two rotated boxes = still exact AABB each)
  addSolid(statics, world, 6.4, 12 + 4, 6.4, cx, base + 6 - 2, cz, MET, "silo");
  addSolid(statics, world, 4.6, 12.4 + 4, 8.2, cx, base + 6.2 - 2, cz, MET2, "silo");
  // cap
  addSolid(statics, world, 7.2, 0.8, 7.2, cx, base + 12.4, cz, CAP, "silo");
  // landings spiralling up, each reachable from the one below (1.0 rise)
  const ring = [[0, -5.2, 0], [5.2, 0, 1], [0, 5.2, 2], [-5.2, 0, 3]];
  for (let i = 0; i < 9; i++) {
    const [ox, oz] = ring[i % 4];
    const y = base + 1.6 + i * 1.0;
    addSolid(statics, world, ox === 0 ? 5.2 : 3.4, 0.35, oz === 0 ? 5.2 : 3.4, cx + ox, y, cz + oz, MET2, "silo");
  }
  // stairs up to the first landing (base + 1.6)
  addStairs(statics, world, cx, base + 1.6, cz - 5.2, 0, -1, 3, 1.1, 3.2, MET2, "silo", base);
  world.lootSpots.push({ x: cx, y: base + 12.9, z: cz });
  world.lootSpots.push({ x: cx + 5.2, y: base + 4.0, z: cz });
}

// --- ARENA: tiered stone rings around an open floor (close-quarters POI) ---
function buildArena(statics, world, cx, cz) {
  const base = heightAt(cx, cz);
  if (base < 1) return;
  const S1 = 0xcbb89a, S2 = 0xb7a384, S3 = 0x9d8b6e;
  const cols = [S1, S2, S3];
  // three concentric tiers of seating, each 0.75 higher (steppable both ways)
  for (let t = 0; t < 3; t++) {
    const inner = 9 + t * 3.0;
    const h = 0.75 * (t + 1);
    const bottom = base - 3;
    const top = base + h;
    const cy = (top + bottom) / 2, hh = top - bottom;
    const half = inner + 1.5;
    const col = cols[t];
    // four slabs forming a square ring (N/S full width, E/W between them)
    addSolid(statics, world, half * 2, hh, 3.0, cx, cy, cz - inner - 1.5, col, "arena");
    addSolid(statics, world, half * 2, hh, 3.0, cx, cy, cz + inner + 1.5, col, "arena");
    addSolid(statics, world, 3.0, hh, inner * 2, cx - inner - 1.5, cy, cz, col, "arena");
    addSolid(statics, world, 3.0, hh, inner * 2, cx + inner + 1.5, cy, cz, col, "arena");
  }
  // four pillars + a partial canopy for verticality
  for (const [ox, oz] of [[-7, -7], [7, -7], [-7, 7], [7, 7]]) {
    addSolid(statics, world, 1.3, 6 + 3, 1.3, cx + ox, base + 3 - 1.5, cz + oz, S3, "arena");
  }
  addSolid(statics, world, 17, 0.45, 4.2, cx, base + 6.2, cz, S2, "arena");
  addSolid(statics, world, 4.2, 0.45, 17, cx, base + 6.2, cz, S2, "arena");
  world.lootSpots.push({ x: cx, y: base + 0.9, z: cz });
  world.lootSpots.push({ x: cx, y: base + 7.0, z: cz });
  world.lootSpots.push({ x: cx + 6, y: base + 0.9, z: cz - 6 });
}

// ---------- sky ----------
function makeSky(scene) {
  const geo = new THREE.SphereGeometry(900, 24, 12);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      top: { value: new THREE.Color(0x4ea8ff) },
      mid: { value: new THREE.Color(0x9fd6ff) },
      bot: { value: new THREE.Color(0xffe3c2) },
      sunDir: { value: new THREE.Vector3(0.4, 0.55, 0.35).normalize() },
    },
    vertexShader: `
      varying vec3 vDir;
      void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `
      varying vec3 vDir;
      uniform vec3 top; uniform vec3 mid; uniform vec3 bot; uniform vec3 sunDir;
      void main(){
        float h = clamp(vDir.y, -0.12, 1.0);
        vec3 c = h < 0.16 ? mix(bot, mid, smoothstep(-0.12, 0.16, h)) : mix(mid, top, smoothstep(0.16, 0.85, h));
        float s = pow(max(dot(vDir, sunDir), 0.0), 90.0);
        c += vec3(1.0, 0.85, 0.55) * s * 0.85;
        float s2 = pow(max(dot(vDir, sunDir), 0.0), 6.0);
        c += vec3(1.0, 0.8, 0.5) * s2 * 0.16;
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const sky = new THREE.Mesh(geo, mat);
  sky.frustumCulled = false;
  scene.add(sky);
  return sky;
}

// ---------- world build ----------
export function buildWorld(scene, seed = WORLD_SEED) {
  // Deterministic generation: identical island on every client (required for
  // multiplayer, and makes the map learnable in singleplayer).
  setSeed(seed);
  const world = {
    colliders: new SpatialHash(9),
    pois: [],
    spawnPoints: [],
    lootSpots: [],
    crates: [],
    chests: [],
    disposables: [],
    cloudMesh: null,
    crateMesh: null,
  };

  // --- lights ---
  const hemi = new THREE.HemisphereLight(0xbfe3ff, 0x6b8f5a, 0.85);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff3dd, 1.9);
  sun.position.set(180, 260, 140);
  sun.castShadow = false; // configured by quality tier
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.near = 40; sun.shadow.camera.far = 700;
  sun.shadow.camera.left = -90; sun.shadow.camera.right = 90;
  sun.shadow.camera.top = 90; sun.shadow.camera.bottom = -90;
  sun.shadow.bias = -0.0015;
  scene.add(sun);
  scene.add(sun.target);
  world.sun = sun;
  world.hemi = hemi;

  world.sky = makeSky(scene);

  scene.fog = new THREE.Fog(0xc6ddf2, 110, 520);

  // --- terrain ---
  const SEG = 140;
  const SIZE = 680;
  const gGeo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
  gGeo.rotateX(-Math.PI / 2);
  const pos = gGeo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const cSand = new THREE.Color(0xdcc286);
  const cGrass = new THREE.Color(0x6fb354);
  const cGrass2 = new THREE.Color(0x4f9548);
  const cRock = new THREE.Color(0x9aa0a8);
  const cDeep = new THREE.Color(0x51725a);
  const tmpC = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const h = heightAt(x, z);
    pos.setY(i, h);
    const n = terrainNoise(x * 3.1 + 11, z * 3.1 - 7);
    if (h < 0.55) tmpC.copy(cSand);
    else if (h < 1.3) tmpC.copy(cSand).lerp(cGrass, (h - 0.55) / 0.75);
    else tmpC.copy(cGrass).lerp(cGrass2, clamp(n * 0.5 + 0.5, 0, 1));
    if (h > 7.2) tmpC.lerp(cRock, clamp((h - 7.2) / 2.5, 0, 0.8));
    if (h < -0.5) tmpC.copy(cDeep).lerp(cSand, clamp((h + 3) / 2.5, 0, 1));
    const shade = 0.94 + terrainNoise(x * 9 + 3, z * 9) * 0.05;
    colors[i * 3] = tmpC.r * shade; colors[i * 3 + 1] = tmpC.g * shade; colors[i * 3 + 2] = tmpC.b * shade;
  }
  gGeo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  gGeo.computeVertexNormals();
  const groundMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const ground = new THREE.Mesh(gGeo, groundMat);
  ground.receiveShadow = true;
  scene.add(ground);
  world.disposables.push(gGeo, groundMat);

  // --- ocean ---
  const wGeo = new THREE.CircleGeometry(900, 48);
  wGeo.rotateX(-Math.PI / 2);
  const wMat = new THREE.MeshPhongMaterial({ color: 0x3f8fd4, transparent: true, opacity: 0.82, shininess: 90, specular: 0x88ccff });
  const water = new THREE.Mesh(wGeo, wMat);
  water.position.y = -0.55;
  scene.add(water);
  world.disposables.push(wGeo, wMat);
  world.water = water;

  // --- merge all static structures ---
  const statics = [];
  const POI_DEFS = [
    { name: "TILTED BARN", x: -88, z: -74, n: 5, tint: 0xf2d8b3 },
    { name: "SALTWORKS", x: 96, z: -58, n: 4, tint: 0xc9e4f2 },
    { name: "MOSSY ROW", x: -64, z: 96, n: 5, tint: 0xd4ecc0 },
    { name: "SUNSPIRE DOCKS", x: 108, z: 84, n: 4, tint: 0xf6cdb7 },
    { name: "CRAGPOINT", x: -140, z: 18, n: 4, tint: 0xd9d2ec },
    { name: "EMBER CAMP", x: 42, z: -132, n: 4, tint: 0xf3d9a4 },
    { name: "FROSTHOLLOW", x: -186, z: -140, n: 5, tint: 0xd8e8f4 },
    { name: "GILDED MILL", x: 182, z: -148, n: 4, tint: 0xf5e0b0 },
    { name: "DUSKWATER", x: -176, z: 176, n: 5, tint: 0xc8dcea },
    { name: "THORN MARKET", x: 190, z: 164, n: 5, tint: 0xf0cfc0 },
    { name: "IRONREACH", x: 6, z: 206, n: 4, tint: 0xd4d8e0 },
    { name: "PALE QUARRY", x: -16, z: -210, n: 4, tint: 0xe4dcc8 },
  ];

  const wallCols = [0xf5e6cc, 0xeec9a8, 0xcfe3d4, 0xd6e4f0, 0xf2d0c0, 0xe6ddc4];
  const roofCols = [0xc96f4a, 0x7d8aa0, 0xa15c48, 0x5f7f74];

  for (const poi of POI_DEFS) {
    world.pois.push(poi);
    for (let h = 0; h < poi.n; h++) {
      const ang = (h / poi.n) * Math.PI * 2 + rand(0.5);
      const r = rand(6, 17);
      const hx = poi.x + Math.cos(ang) * r;
      const hz = poi.z + Math.sin(ang) * r;
      const base = heightAt(hx, hz);
      if (base < 0.8) continue;
      const W = rand(5.2, 7), D = rand(5.2, 7), H = rand(3, 3.8);
      const wallC = pick(wallCols), roofC = pick(roofCols);
      const ry = Math.round(rand(0, 3)) * (Math.PI / 2);
      // floor slab
      coloredBox(statics, W + 0.6, 0.4, D + 0.6, hx, base + 0.1, hz, ry, 0xb9a98d);
      // walls (local X length = W, thickness 0.35)
      const t = 0.35, wallY = base + 0.3 + H / 2;
      const doorHalf = 0.85;
      const rot = Math.abs(Math.sin(ry)) > 0.5; // ry is a multiple of 90°
      const mk = (lx, lz, w, d) => {
        // local -> world (rotate by ry)
        const wx = hx + lx * Math.cos(ry) + lz * Math.sin(ry);
        const wz = hz - lx * Math.sin(ry) + lz * Math.cos(ry);
        coloredBox(statics, w, H, d, wx, wallY, wz, ry, wallC);
        addBoxCollider(world, wx, wallY, wz, rot ? d : w, H, rot ? w : d, "house");
      };
      // back wall (full)
      mk(0, -D / 2 + t / 2, W, t);
      // left / right
      mk(-W / 2 + t / 2, 0, t, D - t * 2);
      mk(W / 2 - t / 2, 0, t, D - t * 2);
      // front wall with door gap (two half-walls)
      const fw = (W / 2 - doorHalf);
      mk(-(doorHalf + fw / 2), D / 2 - t / 2, fw, t);
      mk(doorHalf + fw / 2, D / 2 - t / 2, fw, t);
      // lintel above door
      const wx = hx + 0 * Math.cos(ry) + (D / 2 - t / 2) * Math.sin(ry);
      const wz = hz - 0 * Math.sin(ry) + (D / 2 - t / 2) * Math.cos(ry);
      coloredBox(statics, doorHalf * 2, H * 0.35, t, wx, base + 0.3 + H - H * 0.175, wz, ry, wallC);
      // roof slab (walkable)
      const roofY = base + 0.3 + H + 0.18;
      coloredBox(statics, W + 0.9, 0.36, D + 0.9, hx, roofY, hz, ry, roofC);
      addBoxCollider(world, hx, roofY, hz, rot ? D + 0.9 : W + 0.9, 0.36, rot ? W + 0.9 : D + 0.9, "roof");
      // loot spot inside
      world.lootSpots.push({ x: hx, y: base + 0.95, z: hz });
      world.lootSpots.push({ x: hx + 1.5, y: base + 0.95, z: hz - 1 });
    }
  }

  // --- THE CITADEL (central POI, rebuilt from exact-hitbox solids) ---
  buildCitadel(statics, world, 0, 0);

  // --- extra landmark structures spread over the island ---
  buildWatchtower(statics, world, -104, 6);
  buildWatchtower(statics, world, 118, -14);
  buildWatchtower(statics, world, -22, 128);
  buildWatchtower(statics, world, 36, -92);
  buildWatchtower(statics, world, -168, -58);
  buildWatchtower(statics, world, 158, 92);

  buildContainerYard(statics, world, 108, 84);
  buildContainerYard(statics, world, -176, 176);
  buildContainerYard(statics, world, 190, 164);

  buildBunker(statics, world, -88, -74);
  buildBunker(statics, world, 96, -58);
  buildBunker(statics, world, 6, 206);
  buildBunker(statics, world, -16, -210);

  buildSilo(statics, world, 182, -148);
  buildSilo(statics, world, -186, -140);
  buildSilo(statics, world, -64, 96);

  buildArena(statics, world, -140, 18);
  buildArena(statics, world, 42, -132);

  // --- ruins scatter ---
  for (let i = 0; i < 24; i++) {
    const a = rand(0, Math.PI * 2), r = rand(40, 255);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const base = heightAt(x, z);
    if (base < 1) continue;
    const nw = (rand() < 0.5 ? 2 : 3);
    for (let w = 0; w < nw; w++) {
      const wx = x + rand(-4, 4), wz = z + rand(-4, 4);
      const ww = rand(2.5, 5), wh = rand(1.6, 3.2);
      const wy = heightAt(wx, wz) + wh / 2 - 0.2;
      // quarter-turns only so the AABB collider matches the rendered box
      addSolid(statics, world, ww, wh, 0.4, wx, wy, wz, 0xb6b2a4, "ruin", randInt(0, 3));
    }
  }

  const staticGeo = mergeGeometries(statics, false);
  statics.forEach((s) => s.dispose());
  const staticMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const staticMesh = new THREE.Mesh(staticGeo, staticMat);
  staticMesh.castShadow = true;
  staticMesh.receiveShadow = true;
  scene.add(staticMesh);
  world.disposables.push(staticGeo, staticMat);

  // --- trees (instanced pines) ---
  const treeCount = 560;
  const trunkGeo = new THREE.CylinderGeometry(0.22, 0.34, 1.7, 5);
  trunkGeo.translate(0, 0.85, 0);
  const trunkMat = new THREE.MeshLambertMaterial({ color: 0x7a5236 });
  const trunkMesh = new THREE.InstancedMesh(trunkGeo, trunkMat, treeCount);
  trunkMesh.castShadow = true;
  trunkMesh.frustumCulled = false; // instances span the island; origin-based culling hides them

  const cone1 = new THREE.ConeGeometry(1.6, 2.6, 6); cone1.translate(0, 2.6, 0);
  const cone2 = new THREE.ConeGeometry(1.15, 2.0, 6); cone2.translate(0, 4.1, 0);
  const canopyGeo = mergeGeometries([cone1, cone2], false);
  cone1.dispose(); cone2.dispose();
  // DoubleSide so the view is still blocked if the camera clips a canopy
  const canopyMat = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  const canopyMesh = new THREE.InstancedMesh(canopyGeo, canopyMat, treeCount);
  canopyMesh.castShadow = true;
  canopyMesh.frustumCulled = false;

  const treeCols = [0x2f7d4f, 0x3f9458, 0x4c9e5f, 0x2b6e49, 0x63a44e];
  let ti = 0;
  const dummy = new THREE.Object3D();
  while (ti < treeCount) {
    const a = rand(0, Math.PI * 2), r = Math.sqrt(rand(0, 1)) * (ISLAND_R - 12);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const h = heightAt(x, z);
    if (h < 1.1) continue;
    let nearPoi = false;
    for (const p of POI_DEFS) if ((x - p.x) ** 2 + (z - p.z) ** 2 < 625) { nearPoi = true; break; }
    if (nearPoi || (x * x + z * z < 400)) continue;
    const s = rand(0.8, 1.5);
    dummy.position.set(x, h - 0.15, z);
    dummy.scale.setScalar(s);
    dummy.rotation.y = rand(0, Math.PI * 2);
    dummy.updateMatrix();
    trunkMesh.setMatrixAt(ti, dummy.matrix);
    canopyMesh.setMatrixAt(ti, dummy.matrix);
    _col.setHex(pick(treeCols)).multiplyScalar(rand(0.85, 1.1));
    canopyMesh.setColorAt(ti, _col);
    // Shape-accurate tree: a THIN trunk you collide with, plus a tapered
    // canopy cone that stops bullets/sight but lets you walk underneath.
    const trunkR = 0.34 * s;
    world.colliders.insertTracked(
      { kind: "cone", tag: "tree", x, z, y0: h - 1, y1: h + 1.75 * s, r0: trunkR, r1: 0.23 * s },
      x - trunkR - 0.2, z - trunkR - 0.2, x + trunkR + 0.2, z + trunkR + 0.2
    );
    const canR = 1.62 * s;
    world.colliders.insertTracked(
      { kind: "cone", tag: "tree", blockMove: false, x, z, y0: h + 1.25 * s, y1: h + 5.15 * s, r0: canR, r1: 0.04 },
      x - canR - 0.2, z - canR - 0.2, x + canR + 0.2, z + canR + 0.2
    );
    ti++;
  }
  trunkMesh.instanceMatrix.needsUpdate = true;
  canopyMesh.instanceMatrix.needsUpdate = true;
  if (canopyMesh.instanceColor) canopyMesh.instanceColor.needsUpdate = true;
  scene.add(trunkMesh); scene.add(canopyMesh);
  world.disposables.push(trunkGeo, trunkMat, canopyGeo, canopyMat);

  // --- rocks (instanced) ---
  const rockCount = 190;
  const rockGeo = new THREE.IcosahedronGeometry(1, 0);
  const rockMat = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  const rockMesh = new THREE.InstancedMesh(rockGeo, rockMat, rockCount);
  rockMesh.castShadow = true;
  rockMesh.receiveShadow = true;
  rockMesh.frustumCulled = false;
  let ri = 0;
  while (ri < rockCount) {
    const a = rand(0, Math.PI * 2), r = Math.sqrt(rand(0, 1)) * (ISLAND_R - 8);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const h = heightAt(x, z);
    if (h < 0.4) continue;
    const s = rand(0.7, 3.1);
    const yf = rand(0.7, 1.1);
    const cyR = h + s * 0.25;
    dummy.position.set(x, cyR, z);
    dummy.scale.set(s, s * yf, s);
    dummy.rotation.set(rand(0, 3), rand(0, 3), rand(0, 3));
    dummy.updateMatrix();
    rockMesh.setMatrixAt(ri, dummy.matrix);
    _col.setHSL(0.6, rand(0.02, 0.07), rand(0.5, 0.68));
    rockMesh.setColorAt(ri, _col);
    // Shape-accurate rock: an ellipsoid you can shoot past and stand on top of
    const cr = s * 0.92, cry = s * yf * 0.92;
    world.colliders.insertTracked(
      { kind: "sphere", tag: "rock", x, y: cyR, z, r: cr, ry: cry },
      x - cr, z - cr, x + cr, z + cr
    );
    ri++;
  }
  rockMesh.instanceMatrix.needsUpdate = true;
  if (rockMesh.instanceColor) rockMesh.instanceColor.needsUpdate = true;
  scene.add(rockMesh);
  world.disposables.push(rockGeo, rockMat);

  // --- crates (breakable, instanced with hp tint) ---
  const crateCount = 130;
  const crateGeo = new THREE.BoxGeometry(1.15, 1.15, 1.15);
  const crateMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const crateMesh = new THREE.InstancedMesh(crateGeo, crateMat, crateCount);
  crateMesh.castShadow = true;
  crateMesh.frustumCulled = false;
  world.crateMesh = crateMesh;
  let ci = 0;
  const crateSpots = [];
  for (const p of world.pois) for (let k = 0; k < 8; k++) crateSpots.push({ x: p.x + rand(-16, 16), z: p.z + rand(-16, 16) });
  while (ci < crateCount) {
    let spot;
    if (ci < crateSpots.length) spot = crateSpots[ci];
    else {
      const a = rand(0, Math.PI * 2), r = Math.sqrt(rand(0, 1)) * (ISLAND_R - 16);
      spot = { x: Math.cos(a) * r, z: Math.sin(a) * r };
    }
    const { x, z } = spot;
    const h = heightAt(x, z);
    if (h < 0.7) { if (ci >= crateSpots.length) continue; ci++; continue; }
    const crot = rand(0, Math.PI * 2);
    dummy.position.set(x, h + 0.55, z);
    dummy.scale.setScalar(1);
    dummy.rotation.set(0, crot, 0);
    dummy.updateMatrix();
    crateMesh.setMatrixAt(ci, dummy.matrix);
    _col.setHex(0xc98a4b);
    crateMesh.setColorAt(ci, _col);
    const crate = { kind: "box", tag: "crate", index: ci, hp: 40, alive: true, rot: crot, x, y: h + 0.55, z, minX: x - 0.6, maxX: x + 0.6, minY: h - 0.05, maxY: h + 1.15, minZ: z - 0.6, maxZ: z + 0.6 };
    world.colliders.insertTracked(crate, crate.minX, crate.minZ, crate.maxX, crate.maxZ);
    world.crates.push(crate);
    ci++;
  }
  crateMesh.instanceMatrix.needsUpdate = true;
  if (crateMesh.instanceColor) crateMesh.instanceColor.needsUpdate = true;
  scene.add(crateMesh);
  world.disposables.push(crateGeo, crateMat);

  // --- loot chests ---
  {
    const CHEST_N = 26;
    const bodyGeo = new THREE.BoxGeometry(1.05, 0.62, 0.78);
    bodyGeo.translate(0, 0.31, 0);
    const lidGeo = new THREE.BoxGeometry(1.1, 0.26, 0.84);
    lidGeo.translate(0, 0.13, 0.42); // hinge at back edge (local z +0.42)
    const chestMat = new THREE.MeshLambertMaterial({ color: 0xb98a3c });
    const lidMat = new THREE.MeshLambertMaterial({ color: 0xd8a94e });
    const bodyMesh = new THREE.InstancedMesh(bodyGeo, chestMat, CHEST_N);
    const lidMesh = new THREE.InstancedMesh(lidGeo, lidMat, CHEST_N);
    bodyMesh.castShadow = lidMesh.castShadow = true;
    bodyMesh.frustumCulled = lidMesh.frustumCulled = false;
    bodyMesh.count = lidMesh.count = 0;
    scene.add(bodyMesh, lidMesh);
    world.disposables.push(bodyGeo, lidGeo, chestMat, lidMat);
    world.chestMeshes = { body: bodyMesh, lid: lidMesh };

    // glow marker so chests are findable from a distance
    const glowGeo = new THREE.CylinderGeometry(0.34, 0.5, 4.2, 10, 1, true);
    const glowMat = new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending });
    const glowMesh = new THREE.InstancedMesh(glowGeo, glowMat, CHEST_N);
    glowMesh.count = 0;
    glowMesh.frustumCulled = false;
    scene.add(glowMesh);
    world.chestMeshes.glow = glowMesh;
    world.disposables.push(glowGeo, glowMat);

    const chestSpots = [];
    for (const p of world.pois) for (let k = 0; k < 2; k++) chestSpots.push({ x: p.x + rand(-15, 15), z: p.z + rand(-15, 15) });
    for (let i = 0; i < 26; i++) {
      const a = rand(0, Math.PI * 2), r = Math.sqrt(rand(0, 1)) * (ISLAND_R - 26);
      chestSpots.push({ x: Math.cos(a) * r, z: Math.sin(a) * r });
    }
    chestSpots.sort(() => Math.random() - 0.5);
    let ci2 = 0;
    for (const sp of chestSpots) {
      if (ci2 >= CHEST_N) break;
      const h = heightAt(sp.x, sp.z);
      if (h < 0.9) continue;
      const chest = {
        index: ci2, x: sp.x, y: h, z: sp.z, yaw: rand(0, Math.PI * 2),
        opened: false, lidT: 0,
      };
      world.chests.push(chest);
      const col = { kind: "box", tag: "chest", chest, alive: true, minX: sp.x - 0.58, maxX: sp.x + 0.58, minY: h - 0.1, maxY: h + 0.66, minZ: sp.z - 0.48, maxZ: sp.z + 0.48 };
      world.colliders.insertTracked(col, col.minX, col.minZ, col.maxX, col.maxZ);
      ci2++;
    }
    bodyMesh.count = lidMesh.count = glowMesh.count = world.chests.length;

    const cd = new THREE.Object3D();
    world._writeChest = (c) => {
      cd.position.set(c.x, c.y, c.z);
      cd.rotation.set(0, c.yaw, 0);
      cd.scale.setScalar(1);
      cd.updateMatrix();
      bodyMesh.setMatrixAt(c.index, cd.matrix);
      // lid: rotate open about its hinge
      const open = c.lidT * (Math.PI * 0.62);
      cd.position.set(c.x, c.y + 0.62, c.z);
      cd.rotation.set(0, c.yaw, 0);
      cd.updateMatrix();
      const hinge = new THREE.Matrix4().makeRotationX(open);
      cd.matrix.multiply(hinge);
      lidMesh.setMatrixAt(c.index, cd.matrix);
      // glow fades out once opened
      cd.position.set(c.x, c.y + 2.0, c.z);
      cd.rotation.set(0, 0, 0);
      cd.scale.setScalar(c.opened ? 0.0001 : 1);
      cd.updateMatrix();
      glowMesh.setMatrixAt(c.index, cd.matrix);
      bodyMesh.instanceMatrix.needsUpdate = true;
      lidMesh.instanceMatrix.needsUpdate = true;
      glowMesh.instanceMatrix.needsUpdate = true;
    };
    for (const c of world.chests) world._writeChest(c);

    world.resetChests = () => {
      for (const c of world.chests) { c.opened = false; c.lidT = 0; world._writeChest(c); }
    };
  }

  // --- clouds ---
  const cloudGeo = new THREE.IcosahedronGeometry(1, 0);
  const cloudMat = new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, fog: false });
  const cloudMesh = new THREE.InstancedMesh(cloudGeo, cloudMat, 22);
  cloudMesh.frustumCulled = false;
  world.clouds = [];
  for (let i = 0; i < 22; i++) {
    const a = rand(0, Math.PI * 2), r = rand(60, 420);
    const c = { x: Math.cos(a) * r, y: rand(60, 130), z: Math.sin(a) * r, s: rand(9, 26), spd: rand(0.6, 1.6) };
    world.clouds.push(c);
    dummy.position.set(c.x, c.y, c.z);
    dummy.scale.set(c.s, c.s * 0.36, c.s * 0.7);
    dummy.rotation.y = rand(0, 3);
    dummy.updateMatrix();
    cloudMesh.setMatrixAt(i, dummy.matrix);
  }
  cloudMesh.instanceMatrix.needsUpdate = true;
  scene.add(cloudMesh);
  world.cloudMesh = cloudMesh;
  world.disposables.push(cloudGeo, cloudMat);

  // --- spawn points: dense sampling across the whole landmass ---
  // (the old edge-ring sampling mostly landed below sea level, starving big lobbies)
  for (let i = 0; i < 5000 && world.spawnPoints.length < 340; i++) {
    const a = rand(0, Math.PI * 2), r = Math.sqrt(rand(0, 1)) * (ISLAND_R - 22);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const h = heightAt(x, z);
    if (h > 0.9) world.spawnPoints.push({ x, z, y: h });
  }
  for (const p of world.pois) {
    const h = heightAt(p.x, p.z);
    if (h > 0.8) world.spawnPoints.push({ x: p.x + rand(-10, 10), z: p.z + rand(-10, 10), y: h });
  }

  // extra wild loot spots
  for (let i = 0; i < 40; i++) {
    const a = rand(0, Math.PI * 2), r = Math.sqrt(rand(0, 1)) * (ISLAND_R - 20);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const h = heightAt(x, z);
    if (h > 0.9) world.lootSpots.push({ x, y: h + 0.6, z });
  }

  const _cd = new THREE.Object3D();
  world._cloudDummy = _cd;
  world.update = (dt, t) => {
    // drift clouds
    for (let i = 0; i < world.clouds.length; i++) {
      const c = world.clouds[i];
      c.x += c.spd * dt;
      if (c.x > 480) c.x = -480;
      _cd.position.set(c.x, c.y + Math.sin(t * 0.2 + i) * 2, c.z);
      _cd.scale.set(c.s, c.s * 0.36, c.s * 0.7);
      _cd.rotation.y = i * 1.7;
      _cd.updateMatrix();
      cloudMesh.setMatrixAt(i, _cd.matrix);
    }
    cloudMesh.instanceMatrix.needsUpdate = true;
    // gentle water bob
    water.position.y = -0.55 + Math.sin(t * 0.5) * 0.06;
    // chest lid animations
    for (const c of world.chests) {
      if (c.opened && c.lidT < 1) {
        c.lidT = Math.min(1, c.lidT + dt * 3.4);
        world._writeChest(c);
      }
    }
  };

  // restore every crate (new match / duel start)
  world.resetCrates = () => {
    for (const crate of world.crates) {
      if (crate.alive) continue;
      crate.alive = true;
      crate.hp = 40;
      world.colliders.insertTracked(crate, crate.minX, crate.minZ, crate.maxX, crate.maxZ);
      _cd.position.set(crate.x, crate.y, crate.z);
      _cd.scale.setScalar(1);
      _cd.rotation.set(0, crate.rot || 0, 0);
      _cd.updateMatrix();
      crateMesh.setMatrixAt(crate.index, _cd.matrix);
    }
    crateMesh.instanceMatrix.needsUpdate = true;
  };

  // remove a destroyed crate's collider + hide instance
  world.destroyCrate = (crate) => {
    crate.alive = false;
    world.colliders.remove(crate);
    _cd.position.set(0, -999, 0);
    _cd.scale.setScalar(0.001);
    _cd.rotation.set(0, 0, 0);
    _cd.updateMatrix();
    crateMesh.setMatrixAt(crate.index, _cd.matrix);
    crateMesh.instanceMatrix.needsUpdate = true;
  };

  world.dispose = () => {
    for (const d of world.disposables) d.dispose && d.dispose();
    world.colliders.clear();
    world.crates.length = 0;
  };

  // world is fully generated — hand randomness back to Math.random()
  resetSeed();
  return world;
}
