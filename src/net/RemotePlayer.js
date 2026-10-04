// ============================================================
// RemotePlayer.js — visual stand-in for the networked opponent.
//
// Receives ~20Hz snapshots and renders them with a small
// interpolation buffer so motion stays smooth despite jitter.
// Reuses the bot body so it matches the game's art style.
// ============================================================
import * as THREE from "three";
import { angleLerp, lerp, clamp } from "../game/utils.js";

const BUFFER_MS = 110; // render this far in the past to hide jitter

export class RemotePlayer {
  constructor(game, name = "RIVAL") {
    this.game = game;
    this.name = name;
    this.alive = true;
    this.hp = 100;
    this.shield = 0;
    this.h = 1.78;
    this.r = 0.45;

    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.sliding = false;

    this.snaps = [];
    this.walkPhase = 0;

    // body — reuse the bot rig so it looks native
    const S = game.bots.shared;
    const g = new THREE.Group();
    this.torso = new THREE.Mesh(S.eliteGeo, S.mat);
    this.torso.castShadow = true;
    this.legL = new THREE.Mesh(S.legGeo, S.mat);
    this.legL.position.set(-0.17, 0.62, 0);
    this.legR = new THREE.Mesh(S.legGeo, S.mat);
    this.legR.position.set(0.17, 0.62, 0);
    this.gun = new THREE.Mesh(S.gunGeo, S.mat);
    this.gun.position.set(0.3, 1.22, 0.15);
    g.add(this.torso, this.legL, this.legR, this.gun);
    this.group = g;
    this.muzzle = new THREE.Vector3();
    game.scene.add(g);
  }

  // snapshot from the wire
  applyState(d, nowMs) {
    this.snaps.push({
      t: nowMs,
      x: d.x, y: d.y, z: d.z,
      yaw: d.yaw, pitch: d.pitch,
      sl: !!d.sl, gr: !!d.gr,
      sp: d.sp || 0,
    });
    if (this.snaps.length > 24) this.snaps.shift();
    if (typeof d.hp === "number") this.hp = d.hp;
    if (typeof d.sh === "number") this.shield = d.sh;
  }

  setDead(dead) {
    this.alive = !dead;
    this.group.visible = !dead;
  }

  reset(spawn) {
    this.snaps.length = 0;
    this.alive = true;
    this.hp = 100;
    this.shield = 0;
    this.group.visible = true;
    if (spawn) this.pos.set(spawn.x, spawn.y || 0, spawn.z);
  }

  update(dt, nowMs) {
    const target = nowMs - BUFFER_MS;
    const s = this.snaps;
    if (s.length >= 2) {
      // find the pair bracketing `target`
      let i = s.length - 1;
      while (i > 0 && s[i - 1].t > target) i--;
      const b = s[i], a = s[i - 1] || b;
      const span = Math.max(1, b.t - a.t);
      const k = clamp((target - a.t) / span, 0, 1);
      this.pos.set(lerp(a.x, b.x, k), lerp(a.y, b.y, k), lerp(a.z, b.z, k));
      this.yaw = angleLerp(a.yaw, b.yaw, k);
      this.pitch = lerp(a.pitch, b.pitch, k);
      this.sliding = b.sl;
      this.speed = b.sp;
      this.grounded = b.gr;
      // drop stale snapshots
      while (s.length > 2 && s[1].t < target - 400) s.shift();
    } else if (s.length === 1) {
      const o = s[0];
      this.pos.set(o.x, o.y, o.z);
      this.yaw = o.yaw;
      this.pitch = o.pitch;
    }

    // hitbox shrinks while they slide, mirroring the local player
    this.h = lerp(this.h, this.sliding ? 0.95 : 1.78, 1 - Math.exp(-13 * dt));

    // animate
    const sp = this.speed || 0;
    this.walkPhase += dt * (2.2 + sp * 1.9);
    const swing = this.sliding ? 0 : Math.sin(this.walkPhase) * clamp(sp / 6, 0, 1) * 0.75;
    this.legL.rotation.x = swing;
    this.legR.rotation.x = -swing;
    this.torso.rotation.x = this.sliding ? 1.1 : clamp(sp / 6, 0, 1) * 0.08;
    this.torso.position.y = this.sliding ? -0.5 : 0;
    this.gun.position.y = this.sliding ? 0.72 : 1.22;
    this.group.position.copy(this.pos);
    this.group.rotation.y = this.yaw;
    this.muzzle.set(0.3, this.sliding ? 0.78 : 1.28, 0.75).applyAxisAngle(_Y, this.yaw).add(this.pos);
  }

  dispose() {
    this.game.scene.remove(this.group);
  }
}

const _Y = new THREE.Vector3(0, 1, 0);
