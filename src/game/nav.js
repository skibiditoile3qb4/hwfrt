// ============================================================
// nav.js — A* navigation on a coarse world grid.
//
// GOD bots use this to actually ROUTE to a target instead of
// walking straight into walls. The grid is lazily sampled from
// terrain height + collider occupancy, cached per-cell, and
// invalidated locally when builds change.
//
// Cost model understands three move kinds:
//   WALK  — small height delta, no blocker        (cheap)
//   CLIMB — needs a ramp built to get up          (costly, allowed)
//   BREAK — a build is in the way, shoot it down  (costly, allowed)
// That means a bot can plan a route that includes constructing a
// ramp or demolishing a wall, which is what makes them relentless.
// ============================================================
import { heightAt } from "./world.js";

export const NAV_CELL = 4; // matches the build grid (G)
const MAX_NODES = 2600;
const STEP_OK = 1.1;       // walkable height delta
const CLIMB_MAX = 9.0;     // max rise a bot will ramp up to in one hop

const NEI = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [-1, -1, 1.414],
];

export class NavGrid {
  constructor(game) {
    this.game = game;
    this.cache = new Map();     // key -> {h, blocked, stamp}
    this.stamp = 1;
    this._open = [];
    this._gScore = new Map();
    this._from = new Map();
    this._kind = new Map();
    this._closed = new Set();
  }

  key(cx, cz) { return cx * 16384 + cz; }
  toCell(v) { return Math.floor(v / NAV_CELL); }
  toWorld(c) { return (c + 0.5) * NAV_CELL; }

  // Invalidate cached samples near a point (call when builds change)
  invalidate(x, z, r = 6) {
    const c0 = this.toCell(x - r), c1 = this.toCell(x + r);
    const d0 = this.toCell(z - r), d1 = this.toCell(z + r);
    for (let cx = c0; cx <= c1; cx++) for (let cz = d0; cz <= d1; cz++) this.cache.delete(this.key(cx, cz));
  }
  invalidateAll() { this.cache.clear(); }

  // Sample a cell: standable height + whether something blocks a body there.
  sample(cx, cz) {
    const k = this.key(cx, cz);
    let s = this.cache.get(k);
    if (s) return s;
    const x = this.toWorld(cx), z = this.toWorld(cz);
    const terrain = heightAt(x, z);
    let top = terrain;
    let blockedBy = null;
    let solidSpan = 0;

    const ctx = this.game.ctx;
    const probe = this._probe || (this._probe = []);
    for (const hash of [ctx.hashWorld, ctx.hashBuilds]) {
      if (!hash) continue;
      const items = hash.query(x, z, NAV_CELL * 0.5, probe);
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.alive === false) continue;
        if (it.kind === "box") {
          if (x < it.minX - 0.4 || x > it.maxX + 0.4 || z < it.minZ - 0.4 || z > it.maxZ + 0.4) continue;
          // a surface we could stand on
          if (it.maxY > top && it.maxY - terrain < 24) {
            const span = it.maxY - it.minY;
            if (span > solidSpan) solidSpan = span;
            top = it.maxY;
            if (it.tag === "build") blockedBy = it.piece || blockedBy;
          }
        } else if (it.kind === "ramp") {
          const surf = it.cy + 0.15 + (it.slope || 0.775) * 0;
          if (surf > top) { top = surf; }
        } else if (it.kind === "sphere") {
          const dx = x - it.x, dz = z - it.z;
          if (dx * dx + dz * dz < it.r * it.r) {
            const t2 = it.y + it.ry;
            if (t2 > top) top = t2;
          }
        } else if (it.kind === "cone" && it.blockMove !== false) {
          const dx = x - it.x, dz = z - it.z;
          const rr = it.r0;
          if (dx * dx + dz * dz < rr * rr) solidSpan = Math.max(solidSpan, 2);
        }
      }
    }
    s = { h: top, terrain, block: blockedBy, span: solidSpan, water: terrain < -0.4 };
    this.cache.set(k, s);
    return s;
  }

  /**
   * A* from (sx,sz) to (tx,tz).
   * Returns { path:[{x,z,h,kind}], cost } or null.
   * kind on a node describes how you ENTER it: "walk" | "climb" | "break".
   */
  findPath(sx, sz, tx, tz, opts = {}) {
    const maxNodes = opts.maxNodes || MAX_NODES;
    const canBuild = !!opts.canBuild;
    const canBreak = !!opts.canBreak;

    const scx = this.toCell(sx), scz = this.toCell(sz);
    const tcx = this.toCell(tx), tcz = this.toCell(tz);
    if (scx === tcx && scz === tcz) return { path: [], cost: 0 };

    const gScore = this._gScore; gScore.clear();
    const from = this._from; from.clear();
    const kind = this._kind; kind.clear();
    const closed = this._closed; closed.clear();
    const open = this._open; open.length = 0;
    const coords = this._coords || (this._coords = new Map());
    coords.clear();

    const h = (cx, cz) => Math.hypot(cx - tcx, cz - tcz);
    const startK = this.key(scx, scz);
    gScore.set(startK, 0);
    coords.set(startK, [scx, scz]);
    open.push({ cx: scx, cz: scz, f: h(scx, scz), k: startK });

    let expanded = 0;
    let best = null, bestH = Infinity;

    while (open.length && expanded < maxNodes) {
      // pop lowest f (linear scan is fine at this grid size)
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
      const cur = open.splice(bi, 1)[0];
      if (closed.has(cur.k)) continue;
      closed.add(cur.k);
      expanded++;

      const hc = h(cur.cx, cur.cz);
      if (hc < bestH) { bestH = hc; best = cur; }

      if (cur.cx === tcx && cur.cz === tcz) { best = cur; bestH = 0; break; }

      const here = this.sample(cur.cx, cur.cz);
      const g0 = gScore.get(cur.k) ?? Infinity;

      for (const [dx, dz, baseCost] of NEI) {
        const nx = cur.cx + dx, nz = cur.cz + dz;
        const nk = this.key(nx, nz);
        if (closed.has(nk)) continue;
        if (Math.abs(nx) > 90 || Math.abs(nz) > 90) continue;

        const nb = this.sample(nx, nz);
        if (nb.water) continue;

        const rise = nb.h - here.h;
        let moveKind = "walk";
        let cost = baseCost;

        if (rise > STEP_OK) {
          // too tall to step onto
          if (nb.block && canBreak) {
            // a player/bot build is in the way — plan to shoot it down
            moveKind = "break";
            cost = baseCost + 7;
          } else if (canBuild && rise <= CLIMB_MAX) {
            // plan to ramp up it
            moveKind = "climb";
            cost = baseCost + 4 + rise * 0.6;
          } else continue;
        } else if (rise < -7) {
          cost = baseCost + 2.5; // big drop: survivable but discouraged
        } else if (nb.span > 2.2 && nb.block) {
          // solid blocker at body height
          if (canBreak) { moveKind = "break"; cost = baseCost + 7; }
          else continue;
        }

        const tentative = g0 + cost;
        if (tentative < (gScore.get(nk) ?? Infinity)) {
          gScore.set(nk, tentative);
          from.set(nk, cur.k);
          kind.set(nk, moveKind);
          coords.set(nk, [nx, nz]);
          open.push({ cx: nx, cz: nz, f: tentative + h(nx, nz) * 1.08, k: nk });
        }
      }
    }

    if (!best) return null;

    // reconstruct
    const path = [];
    let k = best.k;
    let guard = 0;
    while (k !== undefined && guard++ < 400) {
      const c = coords.get(k);
      if (!c) break;
      const [cx, cz] = c;
      const s = this.sample(cx, cz);
      path.push({ x: this.toWorld(cx), z: this.toWorld(cz), h: s.h, kind: kind.get(k) || "walk" });
      if (k === startK) break;
      k = from.get(k);
    }
    path.reverse();
    if (path.length) path.shift(); // drop the start cell
    return { path, cost: gScore.get(best.k) ?? 0, partial: bestH > 0.1 };
  }
}
