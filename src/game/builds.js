// ============================================================
// builds.js — infinite building on a TRUE global grid, with
// Fortnite-style TILE editing (select sub-tiles, release to apply)
//
// Grid contract:
//   cell(ix,iz) spans x:[ix*G,(ix+1)*G]  z:[iz*G,(iz+1)*G]
//   level L      spans y:[L*WALL_H, (L+1)*WALL_H]
//   FLOOR  -> fills a cell at the BOTTOM of level L
//   WALL   -> sits on a cell EDGE (a grid line), spanning level L
//   RAMP   -> fills a cell, rising L*WALL_H -> (L+1)*WALL_H
//
// Every piece is a GRID OF TILES (wall 3x3, floor 2x2, ramp 2x2).
// Editing = toggling tiles. Geometry AND colliders are generated
// per-tile, so a removed tile is a real hole you can walk/shoot through.
// ============================================================
import * as THREE from "three";
import { SpatialHash } from "./utils.js";

export const G = 4;
export const WALL_H = 3.1;
export const RAMP_SLOPE = WALL_H / G;
const RAMP_LEN = Math.sqrt(G * G + WALL_H * WALL_H);
const T = 0.34; // wall thickness
const FT = 0.3; // floor/ramp thickness

// tile layout per type
export const TILE_DIM = { wall: [3, 3], floor: [2, 2], ramp: [2, 2] };
export const TILE_N = { wall: 9, floor: 4, ramp: 4 };

const CAP_PIECES = { wall: 300, floor: 220, ramp: 220 };
const CAP_TILES = { wall: 300 * 9, floor: 220 * 4, ramp: 220 * 4 };

const TYPE_DEF = {
  wall: { hp: 190, color: 0xd9b98a },
  floor: { hp: 160, color: 0xcdaa78 },
  ramp: { hp: 160, color: 0xdbbc8c },
};

export const cellIX = (x) => Math.floor(x / G);
export const cellCenter = (i) => (i + 0.5) * G;
export const levelOf = (y) => Math.floor(y / WALL_H + 0.28);

// ---- tile local offsets (in piece-local space, pre-yaw) ----
// wall: u along the wall, v vertical.  floor: u/w horizontal.
// ramp: lateral + run (y follows the slope).
export function tileLocal(type, i) {
  if (type === "wall") {
    const iu = i % 3, iv = (i / 3) | 0;
    return { x: -G / 2 + (iu + 0.5) * (G / 3), y: -WALL_H / 2 + (iv + 0.5) * (WALL_H / 3), z: 0 };
  }
  if (type === "floor") {
    const iu = i % 2, iw = (i / 2) | 0;
    return { x: -G / 2 + (iu + 0.5) * (G / 2), y: -FT / 2, z: -G / 2 + (iw + 0.5) * (G / 2) };
  }
  const il = i % 2, ir = (i / 2) | 0;
  const runOff = -G / 2 + (ir + 0.5) * (G / 2);
  return { x: -G / 2 + (il + 0.5) * (G / 2), y: RAMP_SLOPE * runOff, z: runOff };
}

export class Builds {
  constructor(scene, effects, sound) {
    this.scene = scene;
    this.effects = effects;
    this.sound = sound;
    this.nav = null; // set by Game; invalidated on every structural change
    // Multiplayer hooks. Game assigns these; _netMute stops echo loops while
    // we're applying a message that came FROM the peer.
    this.onNetDestroy = null;
    this.onNetDamage = null;
    this._netMute = false;
    this.hash = new SpatialHash(8);
    this.cellMap = new Map();
    this.pieces = { wall: [], floor: [], ramp: [] };
    this.dirty = { wall: true, floor: true, ramp: true };

    // ---- tile geometries (one per type; placement via instance matrix) ----
    const rampTileGeo = new THREE.BoxGeometry(G / 2, FT, RAMP_LEN / 2);
    rampTileGeo.rotateX(-Math.atan2(WALL_H, G));
    this.geos = {
      wall: new THREE.BoxGeometry(G / 3 - 0.012, WALL_H / 3 - 0.012, T),
      floor: new THREE.BoxGeometry(G / 2 - 0.012, FT, G / 2 - 0.012),
      ramp: rampTileGeo,
    };

    this.meshes = {};
    this.mats = {};
    for (const t of ["wall", "floor", "ramp"]) {
      const mat = new THREE.MeshLambertMaterial({ color: TYPE_DEF[t].color });
      const mesh = new THREE.InstancedMesh(this.geos[t], mat, CAP_TILES[t]);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.count = 0;
      mesh.frustumCulled = false; // instances span the island
      scene.add(mesh);
      this.meshes[t] = mesh;
      this.mats[t] = mat;
    }

    // ---- placement ghost: ONE clean solid + a crisp outline (never tiled) ----
    this.ghostMat = new THREE.MeshBasicMaterial({ color: 0x3df5c4, transparent: true, opacity: 0.16, depthWrite: false });
    this.ghostBad = new THREE.MeshBasicMaterial({ color: 0xff5d5d, transparent: true, opacity: 0.14, depthWrite: false });
    this.ghostLineMat = new THREE.LineBasicMaterial({ color: 0x6effd8, transparent: true, opacity: 0.95 });
    this.ghostLineBad = new THREE.LineBasicMaterial({ color: 0xff7a7a, transparent: true, opacity: 0.9 });

    // full-size (untiled) geometry per type, used only for the ghost
    const fullRamp = new THREE.BoxGeometry(G, FT, RAMP_LEN);
    fullRamp.rotateX(-Math.atan2(WALL_H, G));
    this.fullGeos = {
      wall: new THREE.BoxGeometry(G, WALL_H, T),
      floor: new THREE.BoxGeometry(G, FT, G),
      ramp: fullRamp,
    };
    this.edgeGeos = {};
    for (const t of ["wall", "floor", "ramp"]) this.edgeGeos[t] = new THREE.EdgesGeometry(this.fullGeos[t]);

    this.ghostGroup = new THREE.Group();
    this.ghostGroup.visible = false;
    this.ghostGroup.renderOrder = 6;
    scene.add(this.ghostGroup);
    this.ghostMesh = new THREE.Mesh(this.fullGeos.wall, this.ghostMat);
    this.ghostMesh.frustumCulled = false;
    this.ghostLines = new THREE.LineSegments(this.edgeGeos.wall, this.ghostLineMat);
    this.ghostLines.frustumCulled = false;
    this.ghostGroup.add(this.ghostMesh, this.ghostLines);

    // ---- edit overlay (tile selection grid) ----
    this.editMatKeep = new THREE.MeshBasicMaterial({ color: 0x3df5c4, transparent: true, opacity: 0.3, depthWrite: false });
    this.editMatCut = new THREE.MeshBasicMaterial({ color: 0xff5d5d, transparent: true, opacity: 0.42, depthWrite: false });
    this.editMatHover = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6, depthWrite: false });
    this.editGroup = new THREE.Group();
    this.editGroup.visible = false;
    this.editGroup.renderOrder = 6;
    scene.add(this.editGroup);
    this.editTiles = [];
    for (let i = 0; i < 9; i++) {
      const m = new THREE.Mesh(this.geos.wall, this.editMatKeep);
      m.frustumCulled = false;
      m.visible = false;
      this.editGroup.add(m);
      this.editTiles.push(m);
    }

    this._obj = new THREE.Object3D();
    this._col = new THREE.Color();
  }

  reset() {
    for (const t of ["wall", "floor", "ramp"]) {
      this.pieces[t].length = 0;
      this.meshes[t].count = 0;
      this.meshes[t].instanceMatrix.needsUpdate = true;
      this.dirty[t] = true;
    }
    this.cellMap.clear();
    this.hash.clear();
    this.ghostGroup.visible = false;
    this.editGroup.visible = false;
  }

  key(type, a, b, c, d) { return type + ":" + a + ":" + b + ":" + c + ":" + (d ?? 0); }

  transformOf(spec) {
    if (spec.type === "floor") {
      return { x: cellCenter(spec.ix), y: spec.L * WALL_H, z: cellCenter(spec.iz), yaw: 0 };
    }
    if (spec.type === "wall") {
      if (spec.orient === 0) return { x: cellCenter(spec.ix), y: spec.L * WALL_H + WALL_H / 2, z: spec.iz * G, yaw: 0 };
      return { x: spec.ix * G, y: spec.L * WALL_H + WALL_H / 2, z: cellCenter(spec.iz), yaw: Math.PI / 2 };
    }
    return { x: cellCenter(spec.ix), y: spec.L * WALL_H + WALL_H / 2, z: cellCenter(spec.iz), yaw: spec.yaw };
  }

  // local(pre-yaw) -> world, using the same convention as rampSurfaceAt
  localToWorld(tr, l, out) {
    const c = Math.cos(tr.yaw), s = Math.sin(tr.yaw);
    out.x = tr.x + c * l.x + s * l.z;
    out.y = tr.y + l.y;
    out.z = tr.z - s * l.x + c * l.z;
    return out;
  }

  // ---------------- placement resolution ----------------
  specFor(type, aim, eye, dir, feetY) {
    const ix = cellIX(aim.x);
    const iz = cellIX(aim.z);

    if (type === "floor") {
      let L = Math.round(aim.y / WALL_H);
      if (Math.abs(aim.y - feetY) < 0.6) L = levelOf(feetY + 0.35);
      const spec = { type, ix, iz, L };
      spec.key = this.key("floor", ix, iz, L);
      return spec;
    }

    if (type === "wall") {
      const fx = aim.x / G - ix;
      const fz = aim.z / G - iz;
      const dX = Math.min(fx, 1 - fx);
      const dZ = Math.min(fz, 1 - fz);
      let orient, wix = ix, wiz = iz;
      if (dZ <= dX) { orient = 0; wiz = fz < 0.5 ? iz : iz + 1; }
      else { orient = 1; wix = fx < 0.5 ? ix : ix + 1; }
      let L = Math.floor(aim.y / WALL_H);
      if (Math.abs(aim.y - feetY) < 0.9) L = levelOf(feetY + 0.35);
      const spec = { type, ix: wix, iz: wiz, L, orient };
      spec.key = this.key("wall", wix, wiz, L, orient);
      return spec;
    }

    const yawIdx = ((Math.round(Math.atan2(dir.x, dir.z) / (Math.PI / 2)) % 4) + 4) % 4;
    let L = Math.floor(aim.y / WALL_H);
    if (Math.abs(aim.y - feetY) < 0.9) L = levelOf(feetY + 0.35);
    const spec = { type, ix, iz, L, yaw: yawIdx * (Math.PI / 2), yawIdx };
    spec.key = this.key("ramp", ix, iz, L, yawIdx);
    return spec;
  }

  canPlace(spec) {
    if (!spec) return false;
    if (this.cellMap.has(spec.key)) return false;
    if (spec.L < -2 || spec.L > 30) return false;
    const t = this.transformOf(spec);
    if (Math.abs(t.x) > 300 || Math.abs(t.z) > 300) return false;
    return true;
  }

  // ---------------- colliders (per solid tile) ----------------
  _addColliders(p) {
    const list = [];
    const tr = p.tr;
    const n = TILE_N[p.type];
    let allSolid = true;
    for (let i = 0; i < n; i++) if (!p.tiles[i]) { allSolid = false; break; }

    const pushBox = (cx, cy, cz, w, h, d) => {
      const box = {
        kind: "box", tag: "build", piece: p, alive: true,
        minX: cx - w / 2, maxX: cx + w / 2,
        minY: cy - h / 2, maxY: cy + h / 2,
        minZ: cz - d / 2, maxZ: cz + d / 2,
      };
      this.hash.insertTracked(box, box.minX, box.minZ, box.maxX, box.maxZ);
      list.push(box);
    };

    const W = this._tmpW || (this._tmpW = { x: 0, y: 0, z: 0 });

    if (p.type === "wall") {
      const alongX = p.orient === 0;
      if (allSolid) {
        pushBox(tr.x, tr.y, tr.z, alongX ? G : T, WALL_H, alongX ? T : G);
      } else {
        for (let i = 0; i < 9; i++) {
          if (!p.tiles[i]) continue;
          this.localToWorld(tr, tileLocal("wall", i), W);
          pushBox(W.x, W.y, W.z, alongX ? G / 3 : T, WALL_H / 3, alongX ? T : G / 3);
        }
      }
    } else if (p.type === "floor") {
      if (allSolid) {
        pushBox(tr.x, tr.y - FT / 2, tr.z, G, FT, G);
      } else {
        for (let i = 0; i < 4; i++) {
          if (!p.tiles[i]) continue;
          this.localToWorld(tr, tileLocal("floor", i), W);
          pushBox(W.x, W.y, W.z, G / 2, FT, G / 2);
        }
      }
    } else {
      if (allSolid) {
        const col = {
          kind: "ramp", tag: "build", piece: p, alive: true,
          x: tr.x, z: tr.z, yaw: tr.yaw, cy: tr.y, slope: RAMP_SLOPE,
          half: G / 2, halfLat: G / 2, latOff: 0, runOff: 0,
          minX: tr.x - G / 2 - 0.2, maxX: tr.x + G / 2 + 0.2,
          minY: tr.y - WALL_H / 2 - 0.4, maxY: tr.y + WALL_H / 2 + 0.4,
          minZ: tr.z - G / 2 - 0.2, maxZ: tr.z + G / 2 + 0.2,
        };
        this.hash.insertTracked(col, col.minX, col.minZ, col.maxX, col.maxZ);
        list.push(col);
      } else {
        for (let i = 0; i < 4; i++) {
          if (!p.tiles[i]) continue;
          const l = tileLocal("ramp", i);
          const col = {
            kind: "ramp", tag: "build", piece: p, alive: true,
            x: tr.x, z: tr.z, yaw: tr.yaw, cy: tr.y, slope: RAMP_SLOPE,
            half: G / 4, halfLat: G / 4, latOff: l.x, runOff: l.z,
            minX: tr.x - G / 2 - 0.2, maxX: tr.x + G / 2 + 0.2,
            minY: tr.y - WALL_H / 2 - 0.4, maxY: tr.y + WALL_H / 2 + 0.4,
            minZ: tr.z - G / 2 - 0.2, maxZ: tr.z + G / 2 + 0.2,
          };
          this.hash.insertTracked(col, col.minX, col.minZ, col.maxX, col.maxZ);
          list.push(col);
        }
      }
    }
    p.colliders = list;
  }

  _reCollide(p) {
    for (const c of p.colliders || []) { c.alive = false; this.hash.remove(c); }
    this._addColliders(p);
  }

  // ---------------- place / remove ----------------
  place(spec, owner) {
    if (!this.canPlace(spec)) return null;
    const type = spec.type;
    const list = this.pieces[type];
    if (list.length >= CAP_PIECES[type]) this._removePiece(list[0]);
    const n = TILE_N[type];
    const p = {
      type, ix: spec.ix, iz: spec.iz, L: spec.L,
      orient: spec.orient ?? 0, yaw: spec.yaw ?? 0, key: spec.key,
      tiles: new Array(n).fill(true),
      hp: TYPE_DEF[type].hp, alive: true, owner, animT: 0, colliders: null,
    };
    p.tr = this.transformOf(spec);
    list.push(p);
    this.cellMap.set(spec.key, p);
    this._addColliders(p);
    this.dirty[type] = true;
    if (this.nav) this.nav.invalidate(p.tr.x, p.tr.z, G * 1.5);
    this.effects.buildPuff({ x: p.tr.x, y: p.tr.y, z: p.tr.z });
    this.sound.build();
    return p;
  }

  _removePiece(p) {
    if (!p || !p.alive) return;
    // Broadcast EVERY local removal (damage, edit-to-nothing, recycle) so the
    // peer can never be left standing on a piece we already deleted.
    if (!this._netMute && this.onNetDestroy) this.onNetDestroy(p);
    p.alive = false;
    this.cellMap.delete(p.key);
    for (const c of p.colliders || []) { c.alive = false; this.hash.remove(c); }
    p.colliders = null;
    const list = this.pieces[p.type];
    const i = list.indexOf(p);
    if (i >= 0) list.splice(i, 1);
    this.dirty[p.type] = true;
    if (this.nav && p.tr) this.nav.invalidate(p.tr.x, p.tr.z, G * 1.5);
  }

  damageCollider(box, dmg, point) {
    const p = box.piece;
    if (!p || !p.alive) return;
    // Damage is applied as a DELTA so it is order-independent: if both
    // players shoot the same wall, each applies its own hit locally and
    // then the peer's hit, and both arrive at the same HP.
    if (!this._netMute && this.onNetDamage) this.onNetDamage(p, dmg);
    this._applyDamage(p, dmg, point);
  }

  _applyDamage(p, dmg, point) {
    if (!p || !p.alive) return;
    p.hp -= dmg;
    if (point) this.effects.impact(point, "wood");
    if (p.hp <= 0) {
      const t = p.tr;
      this._removePiece(p);
      this.effects.buildPuff({ x: t.x, y: t.y, z: t.z }, 0xc98a4b);
      this.sound.buildBreak();
    } else {
      this.dirty[p.type] = true;
    }
  }

  // Apply a damage delta that arrived from the peer (no re-broadcast).
  netDamage(key, dmg) {
    const p = this.cellMap.get(key);
    if (!p) return;
    this._netMute = true;
    this._applyDamage(p, dmg, { x: p.tr.x, y: p.tr.y, z: p.tr.z });
    this._netMute = false;
  }

  // Force-remove a piece because the peer destroyed it. This is the
  // convergence guarantee: even if HP drifted, the piece disappears on both.
  netDestroy(key) {
    const p = this.cellMap.get(key);
    if (!p) return;
    this._netMute = true;
    const t = p.tr;
    this._removePiece(p);
    this.effects.buildPuff({ x: t.x, y: t.y, z: t.z }, 0xc98a4b);
    this.sound.buildBreak();
    this._netMute = false;
  }

  // Apply an edited tile mask. Returns true if anything changed.
  applyTiles(p, tiles) {
    if (!p || !p.alive) return false;
    let changed = false, anySolid = false;
    for (let i = 0; i < tiles.length; i++) {
      if (tiles[i] !== p.tiles[i]) changed = true;
      if (tiles[i]) anySolid = true;
    }
    if (!changed) return false;
    if (!anySolid) { // edited away entirely -> destroy
      const t = p.tr;
      this._removePiece(p);
      this.effects.buildPuff({ x: t.x, y: t.y, z: t.z }, 0xffd166);
      this.sound.buildBreak();
      return true;
    }
    p.tiles = tiles.slice();
    this._reCollide(p);
    p.animT = 0.6;
    this.dirty[p.type] = true;
    this.effects.buildPuff({ x: p.tr.x, y: p.tr.y, z: p.tr.z }, 0xffd166);
    this.sound.build();
    return true;
  }

  // ---------------- tile picking (ray -> tile index) ----------------
  // Returns tile index under the ray, or -1.
  pickTile(p, ox, oy, oz, dx, dy, dz, maxT = 12) {
    if (!p || !p.alive) return -1;
    const tr = p.tr;
    const c = Math.cos(tr.yaw), s = Math.sin(tr.yaw);
    // world -> local (pre-yaw)
    const rx = ox - tr.x, ry = oy - tr.y, rz = oz - tr.z;
    const lox = c * rx - s * rz, loz = s * rx + c * rz, loy = ry;
    const ldx = c * dx - s * dz, ldz = s * dx + c * dz, ldy = dy;

    if (p.type === "wall") {
      if (Math.abs(ldz) < 1e-6) return -1;
      const t = -loz / ldz;
      if (t < 0 || t > maxT) return -1;
      const u = lox + ldx * t, v = loy + ldy * t;
      if (Math.abs(u) > G / 2 || Math.abs(v) > WALL_H / 2) return -1;
      const iu = Math.min(2, Math.max(0, Math.floor((u + G / 2) / (G / 3))));
      const iv = Math.min(2, Math.max(0, Math.floor((v + WALL_H / 2) / (WALL_H / 3))));
      return iv * 3 + iu;
    }
    if (p.type === "floor") {
      if (Math.abs(ldy) < 1e-6) return -1;
      const t = -loy / ldy;
      if (t < 0 || t > maxT) return -1;
      const u = lox + ldx * t, w = loz + ldz * t;
      if (Math.abs(u) > G / 2 || Math.abs(w) > G / 2) return -1;
      const iu = Math.min(1, Math.max(0, Math.floor((u + G / 2) / (G / 2))));
      const iw = Math.min(1, Math.max(0, Math.floor((w + G / 2) / (G / 2))));
      return iw * 2 + iu;
    }
    // ramp: inclined plane  y = RAMP_SLOPE * z  (local, through centre)
    const fd = ldy - RAMP_SLOPE * ldz;
    if (Math.abs(fd) < 1e-6) return -1;
    const t = (RAMP_SLOPE * loz - loy) / fd;
    if (t < 0 || t > maxT) return -1;
    const u = lox + ldx * t, w = loz + ldz * t;
    if (Math.abs(u) > G / 2 || Math.abs(w) > G / 2) return -1;
    const il = Math.min(1, Math.max(0, Math.floor((u + G / 2) / (G / 2))));
    const ir = Math.min(1, Math.max(0, Math.floor((w + G / 2) / (G / 2))));
    return ir * 2 + il;
  }

  // ---------------- ghosts ----------------
  // Placement preview: a single translucent slab with a bright outline.
  // Deliberately NOT tiled — the tile grid only appears in edit mode.
  updateGhost(type, valid, spec) {
    if (!type || !spec) { this.ghostGroup.visible = false; return; }
    const tr = this.transformOf(spec);
    this.ghostGroup.visible = true;
    this.ghostMesh.geometry = this.fullGeos[type];
    this.ghostMesh.material = valid ? this.ghostMat : this.ghostBad;
    this.ghostLines.geometry = this.edgeGeos[type];
    this.ghostLines.material = valid ? this.ghostLineMat : this.ghostLineBad;
    const y = type === "floor" ? tr.y - FT / 2 : tr.y;
    this.ghostMesh.position.set(tr.x, y, tr.z);
    this.ghostLines.position.set(tr.x, y, tr.z);
    this.ghostMesh.rotation.set(0, tr.yaw, 0);
    this.ghostLines.rotation.set(0, tr.yaw, 0);
  }

  // Show the tile-selection grid while editing.
  // working[] = current mask, hover = index under crosshair (-1 none)
  showEditGrid(p, working, hover) {
    if (!p || !p.alive) { this.editGroup.visible = false; return; }
    const tr = p.tr;
    const n = TILE_N[p.type];
    const W = this._tmpW || (this._tmpW = { x: 0, y: 0, z: 0 });
    this.editGroup.visible = true;
    for (let i = 0; i < this.editTiles.length; i++) {
      const m = this.editTiles[i];
      if (i >= n) { m.visible = false; continue; }
      m.visible = true;
      m.geometry = this.geos[p.type];
      m.material = i === hover ? this.editMatHover : working[i] ? this.editMatKeep : this.editMatCut;
      this.localToWorld(tr, tileLocal(p.type, i), W);
      // nudge the overlay slightly toward the viewer so it never z-fights
      m.position.set(W.x, W.y + (p.type === "wall" ? 0 : 0.03), W.z);
      m.rotation.set(0, tr.yaw, 0);
      const s = i === hover ? 1.06 : 0.97;
      m.scale.set(s, s, i === hover ? 1.5 : 1.12);
    }
  }
  hideEditGrid() { this.editGroup.visible = false; }

  // Does this spec overlap an entity capsule?
  overlapsEntity(spec, pos, r, h) {
    if (!spec) return false;
    const t = this.transformOf(spec);
    let minX, maxX, minZ, maxZ, minY, maxY;
    if (spec.type === "wall") {
      const alongX = spec.orient === 0;
      const w = alongX ? G : T, d = alongX ? T : G;
      minX = t.x - w / 2; maxX = t.x + w / 2;
      minZ = t.z - d / 2; maxZ = t.z + d / 2;
      minY = t.y - WALL_H / 2; maxY = t.y + WALL_H / 2;
    } else if (spec.type === "floor") {
      minX = t.x - G / 2; maxX = t.x + G / 2;
      minZ = t.z - G / 2; maxZ = t.z + G / 2;
      minY = t.y - FT; maxY = t.y;
    } else {
      minX = t.x - G / 2; maxX = t.x + G / 2;
      minZ = t.z - G / 2; maxZ = t.z + G / 2;
      minY = t.y - WALL_H / 2; maxY = t.y + WALL_H / 2;
    }
    if (maxY <= pos.y + 0.08 || minY >= pos.y + h - 0.08) return false;
    const cx = Math.max(minX, Math.min(pos.x, maxX));
    const cz = Math.max(minZ, Math.min(pos.z, maxZ));
    const dx = pos.x - cx, dz = pos.z - cz;
    return dx * dx + dz * dz < r * r;
  }

  // ---------------- bot helpers ----------------
  placeAt(type, x, y, z, yaw, owner, orient) {
    const ix = cellIX(x), iz = cellIX(z);
    const L = levelOf(y + 0.35);
    let spec;
    if (type === "wall") {
      const o = orient ?? (Math.abs(Math.cos(yaw)) > 0.5 ? 0 : 1);
      let wix = ix, wiz = iz;
      if (o === 0) wiz = Math.cos(yaw) > 0 ? iz + 1 : iz;
      else wix = Math.sin(yaw) > 0 ? ix + 1 : ix;
      spec = { type, ix: wix, iz: wiz, L, orient: o, key: this.key("wall", wix, wiz, L, o) };
    } else if (type === "floor") {
      spec = { type, ix, iz, L, key: this.key("floor", ix, iz, L) };
    } else {
      const yawIdx = ((Math.round(yaw / (Math.PI / 2)) % 4) + 4) % 4;
      spec = { type, ix, iz, L, yaw: yawIdx * (Math.PI / 2), yawIdx, key: this.key("ramp", ix, iz, L, yawIdx) };
    }
    if (!this.canPlace(spec)) return null;
    return this.place(spec, owner);
  }

  placeWallFor(bot, x, z, yaw) { return this.placeAt("wall", x, bot.pos.y, z, yaw, bot); }
  placeRampFor(bot, x, z, yaw) { return this.placeAt("ramp", x, bot.pos.y, z, yaw, bot); }

  buildStructure(owner, x, y, z, kind = "box", opts = {}) {
    const ix = cellIX(x), iz = cellIX(z);
    const L = levelOf(y + 0.35);
    let n = 0;
    const put = (t, a, b, lv, extra) => {
      const spec = t === "wall"
        ? { type: "wall", ix: a, iz: b, L: lv, orient: extra, key: this.key("wall", a, b, lv, extra) }
        : t === "floor"
          ? { type: "floor", ix: a, iz: b, L: lv, key: this.key("floor", a, b, lv) }
          : { type: "ramp", ix: a, iz: b, L: lv, yaw: extra * (Math.PI / 2), yawIdx: extra, key: this.key("ramp", a, b, lv, extra) };
      if (this.canPlace(spec) && this.place(spec, owner)) n++;
    };
    if (kind === "stack") {
      const yawIdx = ((opts.yawIdx | 0) % 4 + 4) % 4;
      const DIRS = [[0, 1], [1, 0], [0, -1], [-1, 0]];
      const [sx, sz] = DIRS[yawIdx];
      const levels = Math.max(1, Math.min(5, opts.levels || 3));
      // start ONE CELL AHEAD so the builder walks into the ramp's low edge
      const bx = ix + sx, bz = iz + sz;
      let Lb = Math.round((y - 0.15) / WALL_H);
      while (Lb * WALL_H + 0.15 - y > 1.0) Lb--;
      while (y - (Lb * WALL_H + 0.15) > 2.2) Lb++;
      for (let lv = 0; lv < levels; lv++) {
        const cx = bx + sx * lv, cz = bz + sz * lv;
        put("ramp", cx, cz, Lb + lv, yawIdx);
        if (opts.rails) {
          if (sx === 0) { put("wall", cx, cz, Lb + lv, 1); put("wall", cx + 1, cz, Lb + lv, 1); }
          else { put("wall", cx, cz, Lb + lv, 0); put("wall", cx, cz + 1, Lb + lv, 0); }
        }
      }
      put("floor", bx + sx * levels, bz + sz * levels, Lb + levels);
    } else if (kind === "box") {
      put("wall", ix, iz, L, 0);
      put("wall", ix, iz + 1, L, 0);
      put("wall", ix, iz, L, 1);
      put("wall", ix + 1, iz, L, 1);
      put("floor", ix, iz, L + 1);
    } else if (kind === "tower") {
      put("ramp", ix, iz, L, 0);
      put("wall", ix, iz, L, 1);
      put("wall", ix + 1, iz, L, 1);
      put("floor", ix, iz + 1, L + 1);
      put("wall", ix, iz + 2, L + 1, 0);
    } else {
      for (let k = 0; k < 2; k++) {
        put("wall", ix + k, iz, L, 0);
        put("wall", ix + k, iz + 1, L, 0);
        put("floor", ix + k, iz, L + 1);
      }
      put("wall", ix, iz, L, 1);
      put("wall", ix + 2, iz, L, 1);
    }
    return n;
  }

  // ---------------- frame ----------------
  _rebuild(type) {
    const list = this.pieces[type];
    const mesh = this.meshes[type];
    const o = this._obj;
    const W = this._tmpW || (this._tmpW = { x: 0, y: 0, z: 0 });
    const n = TILE_N[type];
    let k = 0;
    for (let pi = 0; pi < list.length; pi++) {
      const p = list[pi];
      const tr = p.tr;
      const s = p.animT < 1 ? 0.45 + 0.55 * (p.animT * p.animT * (3 - 2 * p.animT)) : 1;
      const hpFrac = Math.max(0, Math.min(1, p.hp / TYPE_DEF[type].hp));
      this._col.setHex(TYPE_DEF[type].color).multiplyScalar(0.55 + 0.45 * hpFrac);
      for (let i = 0; i < n; i++) {
        if (!p.tiles[i]) continue;
        if (k >= CAP_TILES[type]) break;
        this.localToWorld(tr, tileLocal(type, i), W);
        o.position.set(W.x, W.y, W.z);
        o.rotation.set(0, tr.yaw, 0);
        o.scale.set(s, s, s);
        o.updateMatrix();
        mesh.setMatrixAt(k, o.matrix);
        mesh.setColorAt(k, this._col);
        k++;
      }
    }
    mesh.count = k;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.dirty[type] = false;
  }

  update(dt) {
    for (const t of ["wall", "floor", "ramp"]) {
      const list = this.pieces[t];
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        if (p.animT < 1) { p.animT = Math.min(1, p.animT + dt / 0.16); this.dirty[t] = true; }
      }
      if (this.dirty[t]) this._rebuild(t);
    }
  }

  dispose() {
    for (const t of ["wall", "floor", "ramp"]) {
      this.scene.remove(this.meshes[t]);
      this.geos[t].dispose();
      this.mats[t].dispose();
    }
    for (const t of ["wall", "floor", "ramp"]) {
      this.fullGeos[t].dispose();
      this.edgeGeos[t].dispose();
    }
    this.scene.remove(this.ghostGroup);
    this.scene.remove(this.editGroup);
  }
}
