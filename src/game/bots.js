// ============================================================
// bots.js — AI combatants: roam, fight, strafe, build, shoot
// ============================================================
import * as THREE from "three";
import { BOT_NAMES, rand, randInt, pick, clamp, TAU, angleLerp } from "./utils.js";
import { WEAPONS } from "./weapons.js";
import { moveEntity, losBlocked } from "./physics.js";
import { heightAt } from "./world.js";

// ---------- shared geometry/materials (built once) ----------
let _shared = null;
function sharedAssets() {
  if (_shared) return _shared;
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const _c = new THREE.Color();

  function colored(geo, hex) {
    _c.setHex(hex);
    const n = geo.attributes.position.count;
    const cols = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { cols[i * 3] = _c.r; cols[i * 3 + 1] = _c.g; cols[i * 3 + 2] = _c.b; }
    geo.setAttribute("color", new THREE.BufferAttribute(cols, 3));
    return geo;
  }

  // torso bundle: chest + head + pack (merged via group-less manual merge)
  function makeTorso(bodyHex, trimHex, headHex) {
    const parts = [];
    const add = (geo, hex, x, y, z) => { geo.translate(x, y, z); parts.push(colored(geo, hex)); };
    add(new THREE.BoxGeometry(0.62, 0.66, 0.38), bodyHex, 0, 1.02, 0);       // chest
    add(new THREE.BoxGeometry(0.36, 0.36, 0.34), headHex, 0, 1.56, 0);        // head
    add(new THREE.BoxGeometry(0.5, 0.14, 0.42), trimHex, 0, 1.38, 0);         // collar
    add(new THREE.BoxGeometry(0.44, 0.5, 0.2), trimHex, 0, 1.0, -0.3);        // backpack
    add(new THREE.BoxGeometry(0.18, 0.44, 0.2), bodyHex, -0.42, 1.1, 0);      // arm L
    add(new THREE.BoxGeometry(0.18, 0.44, 0.2), bodyHex, 0.42, 1.1, 0);       // arm R
    // manual merge (all BoxGeometry: compatible attributes)
    let total = 0;
    for (const p of parts) total += p.attributes.position.count;
    const posA = new Float32Array(total * 3);
    const norA = new Float32Array(total * 3);
    const colA = new Float32Array(total * 3);
    const idx = [];
    let vo = 0;
    for (const p of parts) {
      const pa = p.attributes.position, na = p.attributes.normal, ca = p.attributes.color;
      posA.set(pa.array, vo * 3);
      norA.set(na.array, vo * 3);
      colA.set(ca.array, vo * 3);
      const ia = p.index.array;
      for (let i = 0; i < ia.length; i++) idx.push(ia[i] + vo);
      vo += pa.count;
      p.dispose();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(posA, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(norA, 3));
    g.setAttribute("color", new THREE.BufferAttribute(colA, 3));
    g.setIndex(idx);
    return g;
  }

  const legGeo = new THREE.BoxGeometry(0.24, 0.56, 0.26);
  legGeo.translate(0, -0.28, 0); // pivot at hip
  colored(legGeo, 0x2e3444);

  const gunGeo = new THREE.BoxGeometry(0.12, 0.16, 0.72);
  gunGeo.translate(0, 0, 0.28);
  colored(gunGeo, 0x22262e);

  const schemes = [
    { body: 0x5a6ee0, trim: 0x2c3670, head: 0xe8b88a },
    { body: 0xe05a5a, trim: 0x743030, head: 0xd8a878 },
    { body: 0x4fae62, trim: 0x2a5c38, head: 0xf0c49a },
    { body: 0xd8a23f, trim: 0x6e5420, head: 0xc89870 },
    { body: 0x9a5ad8, trim: 0x4e2c70, head: 0xe8b88a },
    { body: 0x3fa8b8, trim: 0x20565e, head: 0xd8a878 },
  ];
  const eliteScheme = { body: 0xff7f2a, trim: 0x603010, head: 0xffe0b0 };

  _shared = {
    mat,
    legGeo,
    gunGeo,
    torsoGeos: schemes.map((s) => makeTorso(s.body, s.trim, s.head)),
    eliteGeo: makeTorso(eliteScheme.body, eliteScheme.trim, eliteScheme.head),
  };
  return _shared;
}

const BOT_R = 0.42;
const BOT_H = 1.78;

export class BotManager {
  constructor(game) {
    this.game = game;
    this.scene = game.scene;
    this.bots = [];
    this.shared = sharedAssets();
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._dir = new THREE.Vector3();
  }

  reset() {
    for (const b of this.bots) this.scene.remove(b.group);
    this.bots.length = 0;
  }

  spawnAll(count, diff, playerSpawn) {
    this.reset();
    const world = this.game.world;
    const names = [...BOT_NAMES].sort(() => Math.random() - 0.5);
    const spots = [...world.spawnPoints].sort(() => Math.random() - 0.5);
    let placed = 0;
    const used = [];
    const MIN_PLAYER_D = 60; // nobody spawns in your lap — even on Legend
    const okSpot = (s, dMin, dMax) => {
      const dp = Math.hypot(s.x - playerSpawn.x, s.z - playerSpawn.z);
      if (dp < dMin || dp > dMax) return false;
      for (const u of used) if ((u.x - s.x) ** 2 + (u.z - s.z) ** 2 < 49) return false;
      return true;
    };
    for (let i = 0; i < count; i++) {
      // a handful of bots seed mid-range so there's early action (but never close)
      const wantClose = i < Math.min(6, Math.max(0, count - 2));
      const dMin = wantClose ? 65 : MIN_PLAYER_D;
      const dMax = wantClose ? 130 : Infinity;
      let spot = null;
      // 1) draw from the precomputed pool
      for (let tries = 0; tries < 50 && spots.length; tries++) {
        const idx = (Math.random() * spots.length) | 0;
        const s = spots[idx];
        if (okSpot(s, dMin, dMax)) { spot = s; spots.splice(idx, 1); break; }
      }
      // 2) brute-force a fresh point anywhere valid on the island
      if (!spot) {
        for (let tries = 0; tries < 90; tries++) {
          const a = rand(0, TAU), r = Math.sqrt(rand(0, 1)) * 274;
          const x = Math.cos(a) * r, z = Math.sin(a) * r;
          const h = heightAt(x, z);
          if (h < 0.9) continue;
          const s = { x, z, y: h };
          if (okSpot(s, MIN_PLAYER_D, Infinity)) { spot = s; break; }
        }
      }
      // 3) last resort: relax crowding but never the player distance
      if (!spot) {
        for (let tries = 0; tries < 90; tries++) {
          const a = rand(0, TAU), r = Math.sqrt(rand(0, 1)) * 274;
          const x = Math.cos(a) * r, z = Math.sin(a) * r;
          const h = heightAt(x, z);
          if (h < 0.7) continue;
          if (Math.hypot(x - playerSpawn.x, z - playerSpawn.z) < 45) continue;
          spot = { x, z, y: h };
          break;
        }
      }
      if (!spot) continue;
      used.push(spot);
      const elite = Math.random() < (diff.eliteRate ?? 0.12);
      this._makeBot(spot, names[i % names.length] + (i >= names.length ? "-" + (((i / names.length) | 0) + 1) : ""), elite, diff);
      placed++;
    }
    return placed;
  }

  _makeBot(spot, name, elite, diff) {
    const S = this.shared;
    const group = new THREE.Group();
    const torso = new THREE.Mesh(elite ? S.eliteGeo : pick(S.torsoGeos), S.mat);
    torso.castShadow = true;
    const legL = new THREE.Mesh(S.legGeo, S.mat);
    legL.position.set(-0.17, 0.62, 0);
    const legR = new THREE.Mesh(S.legGeo, S.mat);
    legR.position.set(0.17, 0.62, 0);
    const gun = new THREE.Mesh(S.gunGeo, S.mat);
    gun.position.set(0.3, 1.22, 0.15);
    group.add(torso, legL, legR, gun);
    const y = heightAt(spot.x, spot.z);
    group.position.set(spot.x, y, spot.z);
    this.scene.add(group);

    const bot = {
      id: this.bots.length,
      name, elite, diff,
      pos: new THREE.Vector3(spot.x, y, spot.z),
      vel: new THREE.Vector3(),
      r: BOT_R, h: BOT_H, grounded: true, groundH: y, justLanded: false,
      yaw: rand(0, TAU), targetYaw: 0, walkPhase: rand(0, 10),
      hp: 100, shield: elite ? 50 : 0, alive: true, dying: 0,
      state: "roam", moveTarget: null, moveTimeout: 0,
      thinkT: rand(0, 0.3), target: null, targetT: 0,
      reactionT: -1, fireT: rand(0.5, 1.5), burstLeft: 0,
      strafeDir: Math.random() < 0.5 ? -1 : 1, strafeT: rand(0.4, 1),
      buildT: rand(0, 2), structT: rand(3, 9), climbT: 0, climbing: false, stuckT: 0, jumpT: rand(2, 6),
      path: null, pathI: 0, pathT: 0, pathGoal: null, breakTarget: null, navFailT: 0,
      lastAttacker: null, lastAttackerT: -9, lastDamageT: -9,
      losT: 0, losOk: false,
      group, torso, legL, legR, gun,
      muzzle: new THREE.Vector3(),
      stepT: 0,
      matchKills: 0,
      wpn: elite ? pick([WEAPONS.ar, WEAPONS.dmr, WEAPONS.sniper, WEAPONS.shotgun])
                 : pick([WEAPONS.pistol, WEAPONS.ar, WEAPONS.ar, WEAPONS.smg, WEAPONS.smg, WEAPONS.shotgun, WEAPONS.dmr]),
    };
    bot.targetYaw = bot.yaw;
    this.bots.push(bot);
    return bot;
  }

  aliveCount() {
    let n = 0;
    for (const b of this.bots) if (b.alive) n++;
    return n;
  }

  // ================= think (staggered, ~7Hz per bot) =================
  think(bot) {
    const game = this.game;
    const diff = bot.diff;
    const px = bot.pos.x, pz = bot.pos.z;

    // storm check
    const s = game.storm;
    const dZone = Math.hypot(px - s.x, pz - s.z);
    const zoneUrgent = dZone > s.r - 4;

    // --- target scan ---
    let best = null, bestD = diff.spotRange;
    const eyeY = bot.pos.y + 1.55;
    const consider = (t, eye) => {
      const d = Math.hypot(t.pos.x - px, t.pos.z - pz);
      if (d > bestD) return;
      if (!losBlocked(px, eyeY, pz, t.pos.x, eye, t.pos.z, game.ctx)) { best = t; bestD = d; }
    };
    if (game.player.alive && game.matchTime > 2.4) consider(game.player, game.player.pos.y + 1.55);
    for (const o of this.bots) {
      if (o === bot || !o.alive) continue;
      // only consider reasonably close — full scan cost guard
      const d2 = (o.pos.x - px) ** 2 + (o.pos.z - pz) ** 2;
      if (d2 > bestD * bestD) continue;
      consider(o, o.pos.y + 1.55);
    }

    if (best) {
      if (bot.target !== best) {
        bot.target = best;
        bot.reactionT = diff.reaction * rand(0.6, 1.5);
      }
      bot.targetT = game.time;
      bot.state = "fight";
    } else {
      const stale = !bot.target || (game.time - bot.targetT > 2.2) || (bot.target && !bot.target.alive);
      if (stale) { bot.target = null; bot.reactionT = -1; bot.state = zoneUrgent ? "zone" : "roam"; }
      else bot.state = "fight";
    }

    // --- zone urge overrides destination but not targeting ---
    if (zoneUrgent && (bot.state !== "fight" || bot.pos.y < -0.2 || dZone > s.r + 12)) {
      const a = rand(0, TAU);
      const rr = Math.max(0, s.nextR * rand(0.2, 0.7));
      bot.moveTarget = { x: s.nextX + Math.cos(a) * rr, z: s.nextZ + Math.sin(a) * rr };
      bot.moveTimeout = 0;
    }

    // --- reactive building ---
    if (bot.buildT <= 0 && game.time - bot.lastDamageT < 1.1 && bot.lastAttacker && Math.random() < diff.buildChance) {
      const from = bot.lastAttacker === game.player ? game.player.pos : (bot.lastAttacker.pos || null);
      if (from) {
        const ang = Math.atan2(from.x - px, from.z - pz);
        const gx = px + Math.sin(ang) * 2.1;
        const gz = pz + Math.cos(ang) * 2.1;
        game.builds.placeWallFor(bot, gx, gz, ang);
        bot.buildT = rand(2.2, 4.2);
      }
    }
    // aggressive ramp push
    if (bot.state === "fight" && bot.target && bot.buildT <= 0 && Math.random() < diff.buildChance * 0.22) {
      const tp = bot.target.pos;
      const ang = Math.atan2(tp.x - px, tp.z - pz);
      const dist = Math.hypot(tp.x - px, tp.z - pz);
      if (dist > 24) {
        game.builds.placeRampFor(bot, px + Math.sin(ang) * 2.2, pz + Math.cos(ang) * 2.2, ang);
        bot.buildT = rand(3, 5);
      }
    }

    // --- GOD tier: real A* pathing toward the target ---
    if (diff.pathfind) this._repath(bot);

    // --- GOD tier: raise real structures (bunkers, towers, houses) ---
    if (diff.structures) {
      // SKY-BASE CHASE: if the target is above, stack ramps straight up to them.
      const tgt = bot.target;
      if (tgt && tgt.alive) {
        const dy = tgt.pos.y - bot.pos.y;
        const flat = Math.hypot(tgt.pos.x - px, tgt.pos.z - pz);
        if (dy > 4.0 && flat < 90) {
          // Lock a cardinal ascent direction toward the target and keep it,
          // so the staircase stays straight and the bot can follow it.
          if (!bot.climbing) {
            const ang = Math.atan2(tgt.pos.x - px, tgt.pos.z - pz);
            bot.climbDir = ((Math.round(ang / (Math.PI / 2)) % 4) + 4) % 4;
          }
          bot.climbing = true;
          if (bot.climbT <= 0) {
            const levels = Math.min(4, Math.max(2, Math.ceil(dy / 3.1)));
            const n = game.builds.buildStructure(bot, px, bot.pos.y, pz, "stack", {
              levels, yawIdx: bot.climbDir, rails: bot.hp < 70,
            });
            bot.climbT = n > 0 ? rand(0.5, 0.85) : rand(1.3, 2.0);
          }
          // Always drive forward along the ascent direction so it WALKS the ramp.
          const DIRS = [[0, 1], [1, 0], [0, -1], [-1, 0]];
          const [sx, sz] = DIRS[bot.climbDir || 0];
          bot.moveTarget = { x: px + sx * 16, z: pz + sz * 16 };
        } else {
          bot.climbing = false;
        }
      } else bot.climbing = false;

      if (bot.structT <= 0 && !bot.climbing) {
        const hurt = game.time - bot.lastDamageT < 1.6;
        const lowHp = bot.hp < 55;
        if (bot.state === "fight" && (hurt || lowHp || Math.random() < 0.3)) {
          const kind = lowHp || hurt ? "box" : (Math.random() < 0.45 ? "tower" : "house");
          const n = game.builds.buildStructure(bot, px, bot.pos.y, pz, kind);
          bot.structT = n > 0 ? rand(7, 12) : rand(2, 4);
          bot.buildT = Math.max(bot.buildT, 2.5);
        }
      }
    }

    // --- roam target selection ---
    if (bot.state === "roam" || (!bot.moveTarget && bot.state !== "fight")) {
      if (!bot.moveTarget || bot.moveTimeout > 7) {
        const world = game.world;
        if (Math.random() < 0.6 && world.lootSpots.length) {
          // pick a loot spot inside zone
          for (let tries = 0; tries < 6; tries++) {
            const ls = pick(world.lootSpots);
            if (Math.hypot(ls.x - s.x, ls.z - s.z) < s.r * 0.95) { bot.moveTarget = { x: ls.x, z: ls.z }; break; }
          }
        }
        if (!bot.moveTarget) {
          const a = rand(0, TAU);
          const rr = Math.max(4, s.r * rand(0.25, 0.85));
          bot.moveTarget = { x: s.x + Math.cos(a) * rr, z: s.z + Math.sin(a) * rr };
        }
        bot.moveTimeout = 0;
      }
    }

    // combat strafe flip
    if (bot.state === "fight") {
      bot.strafeT -= 0.15;
      if (bot.strafeT <= 0) { bot.strafeDir *= -1; bot.strafeT = rand(0.5, 1.3); }
      // jump shots
      bot.jumpT -= 0.15;
      if (bot.jumpT <= 0) {
        bot.jumpT = rand(1.4, 3.6);
        if (bot.grounded && Math.random() < 0.45) { bot.vel.y = 8.3; bot.grounded = false; }
      }
    }
  }

  // ================= A* routing (GOD tier) =================
  _repath(bot) {
    const game = this.game;
    const tgt = bot.target && bot.target.alive ? bot.target : null;
    const goal = tgt ? tgt.pos : (bot.moveTarget ? { x: bot.moveTarget.x, y: bot.pos.y, z: bot.moveTarget.z } : null);
    if (!goal) { bot.path = null; bot.breakTarget = null; return; }

    const dist = Math.hypot(goal.x - bot.pos.x, goal.z - bot.pos.z);
    const dy = (goal.y ?? bot.pos.y) - bot.pos.y;
    // Close + roughly level + clear sight => just walk, no need to route.
    if (dist < 13 && Math.abs(dy) < 3 && bot.losOk) { bot.path = null; bot.breakTarget = null; return; }

    bot.pathT -= 0.15;
    const goalMoved = bot.pathGoal && Math.hypot(bot.pathGoal.x - goal.x, bot.pathGoal.z - goal.z) > 7;
    const exhausted = !bot.path || bot.pathI >= bot.path.length;
    if (bot.pathT > 0 && !goalMoved && !exhausted) return;

    // budget: only a few bots recompute per tick (A* is the expensive part)
    if (BotManager._navBudget <= 0) { bot.pathT = 0.25; return; }
    BotManager._navBudget--;

    const res = game.nav.findPath(bot.pos.x, bot.pos.z, goal.x, goal.z, {
      canBuild: true, canBreak: true, maxNodes: 1400,
    });
    bot.pathGoal = { x: goal.x, z: goal.z };
    bot.pathT = res && res.path.length ? rand(0.6, 1.0) : rand(0.3, 0.6);
    if (res && res.path.length) {
      bot.path = res.path;
      bot.pathI = 0;
      bot.navFailT = 0;
    } else {
      bot.path = null;
      bot.navFailT = (bot.navFailT || 0) + 1;
    }
  }

  // Advance along the path; returns a steering target or null.
  _followPath(bot, dt) {
    const path = bot.path;
    if (!path || bot.pathI >= path.length) return null;
    let node = path[bot.pathI];
    // advance through reached nodes
    let guard = 0;
    while (node && guard++ < 8) {
      const d = Math.hypot(node.x - bot.pos.x, node.z - bot.pos.z);
      const levelOk = Math.abs(node.h - bot.pos.y) < 3.2;
      if (d < 2.6 && levelOk) {
        bot.pathI++;
        node = path[bot.pathI];
      } else break;
    }
    if (!node) { bot.path = null; return null; }

    // --- act on the move kind required to ENTER this node ---
    const rise = node.h - bot.pos.y;
    const dist = Math.hypot(node.x - bot.pos.x, node.z - bot.pos.z);

    if (node.kind === "climb" && rise > 1.0 && dist < 7) {
      // build a ramp staircase toward the node and walk it
      if (bot.climbT <= 0) {
        const ang = Math.atan2(node.x - bot.pos.x, node.z - bot.pos.z);
        const yawIdx = ((Math.round(ang / (Math.PI / 2)) % 4) + 4) % 4;
        const levels = Math.max(1, Math.min(4, Math.ceil(rise / 3.1)));
        const n = this.game.builds.buildStructure(bot, bot.pos.x, bot.pos.y, bot.pos.z, "stack", { levels, yawIdx });
        bot.climbT = n > 0 ? rand(0.5, 0.9) : rand(1.2, 1.8);
        if (n > 0 && bot.grounded) { bot.vel.y = 8.3; bot.grounded = false; }
      }
    } else if (node.kind === "break" && dist < 9) {
      // mark the blocking build so the shooting code can clear it
      bot.breakTarget = { x: node.x, y: node.h - 1.2, z: node.z };
    } else if (bot.breakTarget) {
      const bd = Math.hypot(bot.breakTarget.x - bot.pos.x, bot.breakTarget.z - bot.pos.z);
      if (bd > 11) bot.breakTarget = null;
    }
    return node;
  }

  // ================= per-frame update =================
  update(dt) {
    const game = this.game;
    const s = game.storm;
    const t = game.time;
    // cap how many A* searches may run this frame (keeps 60fps with 100 bots)
    BotManager._navBudget = 3;

    for (const bot of this.bots) {
      // ---- death anim ----
      if (!bot.alive) {
        if (bot.dying > 0) {
          bot.dying -= dt;
          const k = 1 - Math.max(0, bot.dying) / 0.55;
          bot.group.rotation.z = k * Math.PI * 0.5;
          bot.group.position.y = bot.pos.y + Math.sin(k * Math.PI) * 0.2 - k * 0.3;
          bot.group.scale.setScalar(1 - k * 0.25);
          if (bot.dying <= 0) bot.group.visible = false;
        }
        continue;
      }

      // storm damage
      if (game.matchLive) {
        const dZone = Math.hypot(bot.pos.x - s.x, bot.pos.z - s.z);
        if (dZone > s.r) {
          bot.stormAcc = (bot.stormAcc || 0) + dt * s.dmg;
          if (bot.stormAcc >= 1) {
            const dmg = Math.floor(bot.stormAcc);
            bot.stormAcc -= dmg;
            this.damage(bot, dmg, null, false);
            if (!bot.alive) continue;
          }
        }
      }

      // staggered think
      bot.thinkT -= dt;
      if (bot.thinkT <= 0) { bot.thinkT = 0.14 + Math.random() * 0.06; this.think(bot); }
      bot.buildT -= dt;
      if (bot.structT > 0) bot.structT -= dt;
      if (bot.climbT > 0) bot.climbT -= dt;
      if (bot.pathT > 0) bot.pathT -= dt;
      bot.moveTimeout += dt;

      // --------- steering ---------
      let wishX = 0, wishZ = 0, speed = 4.4, pathNode = null;
      if (!game.matchLive) {
        // pre-match idle shuffle
      } else if (bot.diff.pathfind && bot.path && (pathNode = this._followPath(bot, dt))) {
        // A*: steer to the next waypoint. If we're fighting, keep facing the
        // target so the bot shoots while it routes/builds toward you.
        const dx = pathNode.x - bot.pos.x, dz = pathNode.z - bot.pos.z;
        const d = Math.hypot(dx, dz) || 0.001;
        wishX = dx / d; wishZ = dz / d;
        speed = 5.6 * bot.diff.aggro;
        if (bot.target && bot.target.alive && bot.losOk) {
          bot.targetYaw = Math.atan2(bot.target.pos.x - bot.pos.x, bot.target.pos.z - bot.pos.z);
          // weave perpendicular to travel so they aren't a straight line
          const fx = wishX, fz = wishZ;
          wishX = fx - fz * bot.strafeDir * 0.35;
          wishZ = fz + fx * bot.strafeDir * 0.35;
          const wl = Math.hypot(wishX, wishZ) || 1;
          wishX /= wl; wishZ /= wl;
        } else {
          bot.targetYaw = Math.atan2(dx, dz);
        }
      } else if (bot.climbing && bot.moveTarget) {
        // drive straight onto the ramp it just built and keep ascending
        const dx = bot.moveTarget.x - bot.pos.x, dz = bot.moveTarget.z - bot.pos.z;
        const d = Math.hypot(dx, dz) || 0.001;
        wishX = dx / d; wishZ = dz / d;
        speed = 5.4;
        if (bot.target) bot.targetYaw = Math.atan2(bot.target.pos.x - bot.pos.x, bot.target.pos.z - bot.pos.z);
      } else if (bot.state === "fight" && bot.target && bot.target.alive) {
        const tp = bot.target.pos;
        const dx = tp.x - bot.pos.x, dz = tp.z - bot.pos.z;
        const d = Math.hypot(dx, dz) || 0.001;
        const fx = dx / d, fz = dz / d;
        // strafe perpendicular + range correction
        const rangeAdj = clamp((d - 21) / 10, -1, 1);
        wishX = -fz * bot.strafeDir + fx * rangeAdj;
        wishZ = fx * bot.strafeDir + fz * rangeAdj;
        const wl = Math.hypot(wishX, wishZ) || 1;
        wishX /= wl; wishZ /= wl;
        speed = 4.9 * bot.diff.aggro + 0.6;
        bot.targetYaw = Math.atan2(dx, dz);
      } else if (bot.moveTarget) {
        const dx = bot.moveTarget.x - bot.pos.x, dz = bot.moveTarget.z - bot.pos.z;
        const d = Math.hypot(dx, dz);
        if (d < 3.5) { bot.moveTarget = null; }
        else {
          wishX = dx / d; wishZ = dz / d;
          const urgent = Math.hypot(bot.pos.x - s.x, bot.pos.z - s.z) > s.r - 6;
          speed = urgent ? 6.3 : 5.1;
          bot.targetYaw = Math.atan2(dx, dz);
        }
      }

      // separation from other bots
      for (const o of this.bots) {
        if (o === bot || !o.alive) continue;
        const dx = bot.pos.x - o.pos.x, dz = bot.pos.z - o.pos.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < 4.4 && d2 > 0.0001) {
          const d = Math.sqrt(d2);
          wishX += (dx / d) * 0.9; wishZ += (dz / d) * 0.9;
        }
      }

      const accel = bot.grounded ? 10 : 2.5;
      const k = 1 - Math.exp(-accel * dt);
      bot.vel.x += (wishX * speed - bot.vel.x) * k;
      bot.vel.z += (wishZ * speed - bot.vel.z) * k;

      // stuck detection → hop (climbers get a much shorter fuse so they
      // immediately jump onto the lip of the ramp they just placed)
      const spd2 = bot.vel.x * bot.vel.x + bot.vel.z * bot.vel.z;
      const stuckLimit = bot.climbing ? 0.18 : 0.6;
      if (game.matchLive && (wishX !== 0 || wishZ !== 0) && spd2 < (bot.climbing ? 3.2 : 0.4)) {
        bot.stuckT += dt;
        if (bot.stuckT > stuckLimit && bot.grounded) { bot.vel.y = 8.3; bot.grounded = false; bot.stuckT = 0; }
      } else bot.stuckT = 0;

      // physics
      const preY = bot.pos.y;
      const preVy = bot.vel.y;
      moveEntity(bot, dt, game.ctx);
      if (bot.justLanded && preVy < -9) {
        if (game.distToPlayer(bot.pos) < 30) game.effects.landPuff(bot.pos.x, bot.pos.y, bot.pos.z, false);
      }
      void preY;

      // breach island edge safety (shouldn't happen): clamp
      const dc = Math.hypot(bot.pos.x, bot.pos.z);
      if (dc > 350) { bot.pos.multiplyScalar(348 / dc); }

      // footsteps for nearby bots
      const hSpeed = Math.sqrt(spd2);
      if (bot.grounded && hSpeed > 2) {
        bot.stepT -= dt * hSpeed;
        if (bot.stepT <= 0) {
          bot.stepT = 2.4;
          if (game.distToPlayer(bot.pos) < 22) game.effects.footPuff(bot.pos.x, bot.pos.y, bot.pos.z);
        }
      }

      // --------- break through blocking builds ---------
      if (game.matchLive && bot.breakTarget && bot.diff.pathfind) {
        bot.breakFireT = (bot.breakFireT || 0) - dt;
        if (bot.breakFireT <= 0) {
          bot.breakFireT = bot.wpn.botCad * 1.2;
          const eye = this._v.set(bot.pos.x, bot.pos.y + 1.55, bot.pos.z);
          this._dir.set(bot.breakTarget.x - eye.x, bot.breakTarget.y - eye.y, bot.breakTarget.z - eye.z).normalize();
          bot.muzzle.set(0.3, 1.28, 0.75).applyAxisAngle(_Y, bot.yaw).add(bot.pos);
          game.botShoot(bot, eye, this._dir, bot.muzzle);
        }
      }

      // --------- aim/fire ---------
      if (game.matchLive && bot.state === "fight" && bot.target && bot.target.alive) {
        if (bot.reactionT > 0) bot.reactionT -= dt;
        bot.losT -= dt;
        if (bot.losT <= 0) {
          bot.losT = 0.22 + Math.random() * 0.1;
          const tp = bot.target.pos;
          bot.losOk = !losBlocked(bot.pos.x, bot.pos.y + 1.55, bot.pos.z, tp.x, tp.y + 1.5, tp.z, game.ctx);
        }
        if (bot.reactionT <= 0 && bot.losOk) {
          bot.fireT -= dt;
          if (bot.fireT <= 0) {
            const W = bot.wpn;
            if (bot.burstLeft <= 0) {
              // burst length/pacing blends the weapon archetype with difficulty
              const bl = randInt(W.botBurst[0], W.botBurst[1]);
              bot.burstLeft = Math.max(1, Math.round(bl * (0.6 + bot.diff.aggro * 0.5)));
              const gapScale = (bot.diff.burstGap[0] + bot.diff.burstGap[1]) / 1.0;
              bot.fireT = rand(W.botGap[0], W.botGap[1]) * clamp(gapScale, 0.6, 1.5);
            } else {
              bot.fireT = W.botCad;
              bot.burstLeft--;
              this._fireOne(bot);
            }
          }
        } else {
          bot.fireT = Math.max(bot.fireT, 0.12);
        }
      }

      // --------- animation ---------
      bot.yaw = angleLerp(bot.yaw, bot.targetYaw === 0 ? bot.yaw : bot.targetYaw, 1 - Math.exp(-10 * dt));
      bot.walkPhase += dt * (2.2 + hSpeed * 1.9);
      const swing = Math.sin(bot.walkPhase) * (bot.grounded ? clamp(hSpeed / 6, 0, 1) * 0.75 : 0.25);
      bot.legL.rotation.x = swing;
      bot.legR.rotation.x = -swing;
      bot.torso.position.y = Math.abs(Math.sin(bot.walkPhase)) * 0.05 * clamp(hSpeed / 6, 0, 1);
      bot.torso.rotation.x = bot.grounded ? clamp(hSpeed / 6, 0, 1) * 0.08 : 0.16;
      bot.group.position.set(bot.pos.x, bot.pos.y, bot.pos.z);
      bot.group.rotation.y = bot.yaw;
    }
  }

  _fireOne(bot) {
    const game = this.game;
    const target = bot.target;
    if (!target) return;
    const eye = this._v.set(bot.pos.x, bot.pos.y + 1.55, bot.pos.z);
    let aimY;
    if (target === game.player) {
      // aim at centre-mass of the player's CURRENT height — dropping into a
      // slide mid-burst makes their shots sail overhead
      aimY = target.pos.y + (target.h || 1.78) * 0.62 + target.vel.y * 0.12;
    } else {
      aimY = target.pos.y + 1.25;
    }
    const baseDir = this._aim || (this._aim = new THREE.Vector3());
    baseDir.set(target.pos.x - eye.x, aimY - eye.y, target.pos.z - eye.z).normalize();
    // spread: difficulty base, weapon accuracy, target movement penalty
    const W = bot.wpn;
    let sp = bot.diff.aimSpread * (W.spread / 0.011) * 0.8;
    const tv = target.vel;
    sp += Math.min(0.05, Math.hypot(tv.x, tv.z) * 0.004);
    if (!bot.grounded) sp += 0.03;
    bot.muzzle.set(0.3, 1.28, 0.75).applyAxisAngle(_Y, bot.yaw).add(bot.pos);
    const pellets = W.botPellets || 1;
    for (let i = 0; i < pellets; i++) {
      this._dir.copy(baseDir);
      this._dir.x += (Math.random() - 0.5) * 2 * sp;
      this._dir.y += (Math.random() - 0.5) * 2 * sp;
      this._dir.z += (Math.random() - 0.5) * 2 * sp;
      this._dir.normalize();
      game.botShoot(bot, eye, this._dir, bot.muzzle, i === 0);
    }
    // recoil pop
    bot.torso.rotation.x -= 0.05;
  }

  damage(bot, amount, attacker, isHead) {
    if (!bot.alive) return false;
    bot.lastDamageT = this.game.time;
    if (attacker) { bot.lastAttacker = attacker; bot.lastAttackerT = this.game.time; }
    // aggro the attacker
    if (attacker && attacker !== bot && (!bot.target || Math.random() < 0.7)) {
      if (attacker === this.game.player ? this.game.player.alive : attacker.alive) {
        bot.target = attacker;
        bot.targetT = this.game.time;
        if (bot.reactionT < 0) bot.reactionT = bot.diff.reaction * rand(0.5, 1);
        bot.state = "fight";
      }
    }
    let remaining = amount;
    if (bot.shield > 0) {
      const absorbed = Math.min(bot.shield, remaining);
      bot.shield -= absorbed;
      remaining -= absorbed;
    }
    bot.hp -= remaining;
    if (bot.hp <= 0) {
      this.kill(bot, attacker, isHead);
      return true;
    }
    return false;
  }

  kill(bot, attacker, isHead) {
    bot.alive = false;
    bot.dying = 0.55;
    bot.hp = 0;
    this.game.onBotDeath(bot, attacker, isHead);
  }

  getKills(bot) { return bot.matchKills; }
}

const _Y = new THREE.Vector3(0, 1, 0);
