// ============================================================
// physics.js — shared capsule movement & world collision
// ctx = { hashWorld, hashBuilds, heightAt }
// entity = { pos:Vector3(feet), vel:Vector3, r, h, grounded }
// ============================================================
import { heightAt } from "./world.js";
import { radiusAtY } from "./utils.js";

const GRAV = 23;
const _query = [];
const _query2 = [];

export function gravity() { return GRAV; }

// Walking surface height of a sloped ramp at world (x,z); -1 if outside footprint.
export function rampSurfaceAt(it, x, z, r = 0) {
  const s = Math.sin(it.yaw), c = Math.cos(it.yaw);
  const dx = x - it.x, dz = z - it.z;
  const lx = c * dx - s * dz;          // lateral (across the ramp)
  const lz = s * dx + c * dz;          // along the run (rises toward +lz)
  const half = it.half || 2;           // half-run of THIS tile
  const halfLat = it.halfLat != null ? it.halfLat : half;
  const latOff = it.latOff || 0;
  const runOff = it.runOff || 0;
  if (Math.abs(lx - latOff) > halfLat + r) return -1;
  if (Math.abs(lz - runOff) > half + 0.1 + r * 0.5) return -1;
  // surface follows the FULL ramp plane, clamped to this tile's run span
  const l = Math.max(runOff - half, Math.min(runOff + half, lz));
  return it.cy + 0.15 + (it.slope || 0.775) * l;
}

// Standable top surface of an ellipsoid rock at (x,z); -1 if outside.
export function sphereTopAt(it, x, z) {
  const dx = x - it.x, dz = z - it.z;
  const d2 = dx * dx + dz * dz;
  if (d2 >= it.r * it.r) return -1;
  return it.y + it.ry * Math.sqrt(1 - d2 / (it.r * it.r));
}

// Best walkable ground height at (x,z) for an entity whose feet are near feetY
export function groundAt(x, z, feetY, r, ctx) {
  let g = heightAt(x, z);
  const step = 1.15;
  for (const hash of [ctx.hashWorld, ctx.hashBuilds]) {
    if (!hash) continue;
    const items = hash.query(x, z, r + 0.6, _query);
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.alive === false) continue;
      if (it.kind === "box") {
        if (x > it.minX - r && x < it.maxX + r && z > it.minZ - r && z < it.maxZ + r) {
          if (it.maxY <= feetY + step && it.maxY > g) g = it.maxY;
        }
      } else if (it.kind === "ramp") {
        const surf = rampSurfaceAt(it, x, z, r);
        if (surf >= 0 && surf <= feetY + step && surf > g) g = surf;
      } else if (it.kind === "sphere" && it.blockMove !== false) {
        const top = sphereTopAt(it, x, z);
        if (top >= 0 && top <= feetY + step && top > g) g = top;
      }
    }
  }
  return g;
}

// Downhill gradient of the walkable surface at (x,z).
// Returns dh/dx, dh/dz — the vector points UPHILL.
export function groundSlopeAt(x, z, feetY, r, ctx, out) {
  const e = 0.5;
  const hx1 = groundAt(x + e, z, feetY, r, ctx);
  const hx0 = groundAt(x - e, z, feetY, r, ctx);
  const hz1 = groundAt(x, z + e, feetY, r, ctx);
  const hz0 = groundAt(x, z - e, feetY, r, ctx);
  out.x = (hx1 - hx0) / (2 * e);
  out.z = (hz1 - hz0) / (2 * e);
  // clamp absurd gradients at surface seams
  const m = Math.hypot(out.x, out.z);
  if (m > 2.2) { out.x = (out.x / m) * 2.2; out.z = (out.z / m) * 2.2; }
  return out;
}

const STEP = 1.15;

// Lowest blocking surface above `feetY` within the entity's column (ceiling test).
export function ceilingAt(x, z, feetY, headY, r, ctx) {
  let c = Infinity;
  for (const hash of [ctx.hashWorld, ctx.hashBuilds]) {
    if (!hash) continue;
    const items = hash.query(x, z, r + 0.4, _query);
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.alive === false) continue;
      if (it.kind === "box") {
        // must horizontally overlap the entity column
        if (x < it.minX - r || x > it.maxX + r || z < it.minZ - r || z > it.maxZ + r) continue;
        // underside must be above the feet (so it's a ceiling, not a floor we stand on)
        if (it.minY >= headY - 0.05 && it.minY < c && it.maxY > feetY) c = it.minY;
      } else if (it.kind === "ramp") {
        const surf = rampSurfaceAt(it, x, z, r);
        if (surf < 0) continue;
        const under = surf - 0.34;
        if (under >= headY - 0.05 && under < c && surf > feetY) c = under;
      }
    }
  }
  return c;
}

// Ray vs sloped ramp slab (top & bottom faces). Returns t or -1.
export function rayRamp(ox, oy, oz, dx, dy, dz, it, maxT) {
  const s = Math.sin(it.yaw), c = Math.cos(it.yaw);
  const olx = c * (ox - it.x) - s * (oz - it.z);
  const olz = s * (ox - it.x) + c * (oz - it.z);
  const dlx = c * dx - s * dz;
  const dlz = s * dx + c * dz;
  const slope = it.slope || 0.775;
  const half = it.half || 2;
  const halfLat = it.halfLat != null ? it.halfLat : half;
  const latOff = it.latOff || 0;
  const runOff = it.runOff || 0;
  // slab mid-plane: y = cy + slope * lz
  const f0 = oy - it.cy - slope * olz;
  const fd = dy - slope * dlz;
  if (Math.abs(fd) < 1e-7) return -1;
  let best = -1;
  for (const off of [0.17, -0.17]) { // top face, underside
    const t = (off - f0) / fd;
    if (t < 0 || t > maxT) continue;
    const lx = olx + dlx * t, lz = olz + dlz * t;
    if (Math.abs(lx - latOff) <= halfLat + 0.02 && Math.abs(lz - runOff) <= half + 0.05) {
      if (best < 0 || t < best) best = t;
    }
  }
  return best;
}

export function moveEntity(e, dt, ctx) {
  // gravity
  e.vel.y -= GRAV * dt;
  if (e.vel.y < -48) e.vel.y = -48;

  const startY = e.pos.y;
  const wasGroundedStart = e.grounded;

  // --- horizontal ---
  const nx = e.pos.x + e.vel.x * dt;
  const nz = e.pos.z + e.vel.z * dt;
  e.pos.x = nx; e.pos.z = nz;

  const feet = e.pos.y;
  const head = feet + e.h;

  // resolve push-out twice for corners
  for (let pass = 0; pass < 2; pass++) {
    let pushed = false;
    for (const hash of [ctx.hashWorld, ctx.hashBuilds]) {
      if (!hash) continue;
      const items = hash.query(e.pos.x, e.pos.z, e.r + 1.2, _query);
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.alive === false) continue;
        if (it.kind === "box") {
          // step-able? skip push, but only when there is headroom above the step
          if (it.maxY - e.pos.y <= STEP && it.maxY > e.pos.y - 0.5) {
            const ceil = ceilingAt(e.pos.x, e.pos.z, it.maxY, it.maxY + 0.2, e.r * 0.8, ctx);
            if (ceil - it.maxY >= e.h * 0.92) continue;
          }
          // vertical overlap?
          if (it.maxY <= e.pos.y + 0.02 || it.minY >= head) continue;
          // circle vs AABB
          const cx = Math.max(it.minX, Math.min(e.pos.x, it.maxX));
          const cz = Math.max(it.minZ, Math.min(e.pos.z, it.maxZ));
          let dx = e.pos.x - cx, dz = e.pos.z - cz;
          let d2 = dx * dx + dz * dz;
          if (d2 < e.r * e.r) {
            if (d2 < 1e-9) {
              // center inside box — push along smallest axis
              const pxl = e.pos.x - it.minX, pxr = it.maxX - e.pos.x;
              const pzl = e.pos.z - it.minZ, pzr = it.maxZ - e.pos.z;
              const m = Math.min(pxl, pxr, pzl, pzr);
              if (m === pxl) e.pos.x = it.minX - e.r;
              else if (m === pxr) e.pos.x = it.maxX + e.r;
              else if (m === pzl) e.pos.z = it.minZ - e.r;
              else e.pos.z = it.maxZ + e.r;
            } else {
              const d = Math.sqrt(d2);
              const push = (e.r - d) / d;
              e.pos.x += dx * push;
              e.pos.z += dz * push;
            }
            pushed = true;
          }
        } else if (it.kind === "circle" || it.kind === "cone" || it.kind === "sphere") {
          if (it.blockMove === false) continue; // e.g. tree canopies: block shots, not steps
          // sample the shape's true radius across the body's vertical span
          const bodyLo = e.pos.y + 0.12, bodyHi = e.pos.y + e.h * 0.92;
          let shapeR = 0;
          for (let k = 0; k <= 3; k++) {
            const sy = bodyLo + (bodyHi - bodyLo) * (k / 3);
            const rr = radiusAtY(it, sy);
            if (rr > shapeR) shapeR = rr;
          }
          // a rock you're standing on top of shouldn't shove you sideways
          if (it.kind === "sphere") {
            const top = sphereTopAt(it, e.pos.x, e.pos.z);
            if (top >= 0 && e.pos.y >= top - 0.12) continue;
          }
          if (shapeR <= 0.001) continue;
          const dx = e.pos.x - it.x, dz = e.pos.z - it.z;
          const rr = e.r + shapeR;
          const d2 = dx * dx + dz * dz;
          if (d2 < rr * rr && d2 > 1e-9) {
            const d = Math.sqrt(d2);
            const push = (rr - d) / d;
            e.pos.x += dx * push;
            e.pos.z += dz * push;
            pushed = true;
          }
        }
      }
    }
    if (!pushed) break;
  }

  // --- vertical (SWEPT: prevents tunnelling up through thin floors/slabs) ---
  const prevFeet = startY;
  const prevHead = startY + e.h;
  e.pos.y += e.vel.y * dt;
  const wasGrounded = e.grounded;
  e.bonkedHead = false;

  if (e.vel.y > 0) {
    // Find the lowest underside the HEAD crosses during this step.
    const newHead = e.pos.y + e.h;
    let lowest = Infinity;
    const rr = e.r * 0.8;
    for (const hash of [ctx.hashWorld, ctx.hashBuilds]) {
      if (!hash) continue;
      const items = hash.query(e.pos.x, e.pos.z, rr + 0.5, _query);
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.alive === false) continue;
        if (it.kind === "box") {
          if (e.pos.x < it.minX - rr || e.pos.x > it.maxX + rr || e.pos.z < it.minZ - rr || e.pos.z > it.maxZ + rr) continue;
          // underside crossed by the head this frame, and slab is above our feet
          if (it.minY >= prevHead - 0.06 && it.minY <= newHead && it.maxY > prevFeet + 0.06 && it.minY < lowest) lowest = it.minY;
        } else if (it.kind === "ramp") {
          const surf = rampSurfaceAt(it, e.pos.x, e.pos.z, rr);
          if (surf < 0) continue;
          const under = surf - 0.32;
          if (under >= prevHead - 0.06 && under <= newHead && surf > prevFeet + 0.06 && under < lowest) lowest = under;
        }
      }
    }
    if (lowest < Infinity) {
      e.pos.y = lowest - e.h - 0.02;
      e.vel.y = 0;
      e.bonkedHead = true;
    }
  } else {
    // Falling: catch any surface the FEET cross so fast drops can't tunnel.
    const rr = e.r * 0.85;
    let highest = -Infinity;
    for (const hash of [ctx.hashWorld, ctx.hashBuilds]) {
      if (!hash) continue;
      const items = hash.query(e.pos.x, e.pos.z, rr + 0.5, _query);
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.alive === false) continue;
        if (it.kind === "box") {
          if (e.pos.x < it.minX - rr || e.pos.x > it.maxX + rr || e.pos.z < it.minZ - rr || e.pos.z > it.maxZ + rr) continue;
          if (it.maxY <= prevFeet + 0.06 && it.maxY >= e.pos.y && it.maxY > highest) highest = it.maxY;
        } else if (it.kind === "ramp") {
          const surf = rampSurfaceAt(it, e.pos.x, e.pos.z, rr);
          if (surf < 0) continue;
          if (surf <= prevFeet + 0.06 && surf >= e.pos.y && surf > highest) highest = surf;
        }
      }
    }
    if (highest > -Infinity) { e.pos.y = highest; e.vel.y = 0; }
  }

  const g = groundAt(e.pos.x, e.pos.z, Math.max(feet, e.pos.y), e.r * 0.85, ctx);

  if (e.pos.y <= g) {
    e.pos.y = g;
    if (e.vel.y < 0) e.vel.y = 0;
    e.grounded = true;
  } else {
    // walking up a step?
    if (e.grounded && e.vel.y <= 0.01 && g - e.pos.y <= STEP && g > e.pos.y) {
      e.pos.y = g;
      e.vel.y = 0;
      e.grounded = true;
    } else if (wasGroundedStart && e.vel.y <= 0.01 && e.pos.y - g <= 0.55 && startY - g <= 0.6) {
      // snap down small drops (stairs/ramps) instead of launching into the air
      e.pos.y = g;
      e.vel.y = 0;
      e.grounded = true;
    } else {
      e.grounded = e.pos.y - g < 0.02;
    }
  }
  e.groundH = g;
  e.justLanded = !wasGrounded && e.grounded;

  // coyote time — brief grace to still count as grounded after walking off a ledge
  if (e.grounded) e.coyote = 0.11;
  else if (e.coyote > 0) e.coyote = Math.max(0, e.coyote - dt);
  e.canJump = e.grounded || (e.coyote > 0 && e.vel.y <= 0.01);
  return e;
}

// Cheap LOS check: terrain march + collider samples. Blocked => true.
export function losBlocked(ax, ay, az, bx, by, bz, ctx) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dist < 0.001) return false;
  const inv = 1 / dist;
  const nx = dx * inv, ny = dy * inv, nz = dz * inv;
  // terrain march
  const steps = Math.ceil(dist / 5);
  for (let i = 1; i < steps; i++) {
    const t = (i / steps) * dist;
    const x = ax + nx * t, y = ay + ny * t, z = az + nz * t;
    if (heightAt(x, z) > y + 0.3) return true;
  }
  // collider march (coarse): sample query circles along the segment
  const cs = Math.ceil(dist / 6);
  for (let i = 1; i < cs; i++) {
    const t = (i / cs) * dist;
    const x = ax + nx * t, z = az + nz * t;
    for (const hash of [ctx.hashWorld, ctx.hashBuilds]) {
      if (!hash) continue;
      const items = hash.query(x, z, 1.5, _query);
      for (let k = 0; k < items.length; k++) {
        const it = items[k];
        if (it.alive === false) continue;
        if (it.tag === "crate" || it.tag === "tree" || it.tag === "rock" || it.tag === "chest") continue; // small stuff doesn't fully block sight
        // does ray pass near this sample point through the collider?
        if (it.kind === "box") {
          const tHit = rayAABBLocal(ax, ay, az, nx, ny, nz, it, Math.min(dist, t + 4));
          if (tHit >= 0 && tHit < dist) return true;
        } else if (it.kind === "ramp") {
          const tHit = rayRamp(ax, ay, az, nx, ny, nz, it, Math.min(dist, t + 4));
          if (tHit >= 0 && tHit < dist) return true;
        }
      }
    }
  }
  return false;
}

function rayAABBLocal(ox, oy, oz, dx, dy, dz, b, maxT) {
  let tmin = 0, tmax = maxT;
  const axes = [
    [ox, dx, b.minX, b.maxX],
    [oy, dy, b.minY, b.maxY],
    [oz, dz, b.minZ, b.maxZ],
  ];
  for (const [o, d, mn, mx] of axes) {
    if (Math.abs(d) < 1e-8) { if (o < mn || o > mx) return -1; continue; }
    let t1 = (mn - o) / d, t2 = (mx - o) / d;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  return tmin;
}
export { rayAABBLocal as rayAABB };
