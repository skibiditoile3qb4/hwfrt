// ============================================================
// player.js — first-person controller, camera feel, view model
// ============================================================
import * as THREE from "three";
import { clamp, lerp } from "./utils.js";
import { moveEntity, groundSlopeAt } from "./physics.js";
import { heightAt } from "./world.js";
import { buildViewModel } from "./weapons.js";

// slide tuning
const SLIDE_GRAVITY = 30;   // along-surface acceleration from gravity
const SLIDE_FRICTION = 2.5; // base drag on flat ground
const SLIDE_MAX = 26;       // hard speed ceiling
const STAND_HEIGHT = 1.78;
const SLIDE_HEIGHT = 0.95;  // hitbox drops to ~53% while sliding

export class Player {
  constructor(game) {
    this.game = game;
    this.pos = new THREE.Vector3(0, 2, 0);
    this.vel = new THREE.Vector3();
    this.r = 0.42;
    this.h = 1.78;
    this.eye = 1.6;
    this.grounded = true;
    this.groundH = 2;
    this.justLanded = false;

    this.yaw = 0;
    this.pitch = 0;
    this.hp = 100;
    this.shield = 0;
    this.alive = true;

    this.walkT = 0;
    this.landDip = 0;
    this.recoil = 0;
    this.recoilPitch = 0;
    this.rollLean = 0;
    this.stepT = 0;
    this.fov = 75;
    this.airTime = 0;
    this.coyote = 0;
    this.canJump = true;
    this.jumpBuffer = 0;
    // slide state
    this.sliding = false;
    this.slideT = 0;
    this.slideCooldown = 0;
    this.slideDir = new THREE.Vector3();
    this.slideLean = 0;

    this.gun = new THREE.Group();
    this.muzzleLocal = new THREE.Vector3(0, 0.02, -0.66);
    this.gunHome = new THREE.Vector3(0.3, -0.28, -0.52);
    this._vmId = null;
    this.setWeaponModel("pistol");
  }

  // swap the first-person model when the equipped weapon changes
  setWeaponModel(id) {
    if (this._vmId === id) return;
    this._vmId = id;
    for (let i = this.gun.children.length - 1; i >= 0; i--) this.gun.remove(this.gun.children[i]);
    const vm = buildViewModel(id);
    this.gun.add(vm.group);
    this.muzzleLocal.copy(vm.muzzle);
    this.swapAnim = 1;
  }

  attachGun(camera) {
    camera.add(this.gun);
    this.gun.position.copy(this.gunHome);
  }
  detachGun(camera) { camera.remove(this.gun); }

  spawnAt(sp) {
    this.pos.set(sp.x, sp.y ?? heightAt(sp.x, sp.z), sp.z);
    this.vel.set(0, 0, 0);
    this.hp = 100;
    this.shield = 0;
    this.alive = true;
    this.yaw = Math.atan2(sp.x, sp.z); // face inward toward island center
    this.pitch = 0;
    this.recoil = 0;
    this.landDip = 0;
    this.airTime = 0;
    this.sliding = false;
    this.slideT = 0;
    this.slideCooldown = 0;
    this.slideDip = 0;
    this.slideLean = 0;
    this.slideSpeed = 0;
    this.airSlideT = 0;
    this.h = STAND_HEIGHT;
    this.eye = STAND_HEIGHT - 0.18;
  }

  update(dt, frozen) {
    const game = this.game;
    const input = game.input;
    const cam = game.camera;

    // ---- look ----
    if (!frozen && this.alive) {
      const { dx, dy } = input.consumeLook();
      const sens = 0.0021 * game.settings.sensitivity;
      this.yaw -= dx * sens;
      this.pitch = clamp(this.pitch - dy * sens, -1.5, 1.5);
    }

    // ---- movement ----
    let wishX = 0, wishZ = 0;
    let speed = 4.7;
    if (!frozen && this.alive) {
      const mv = input.moveVec();
      const fwdX = -Math.sin(this.yaw), fwdZ = -Math.cos(this.yaw);
      const rgtX = Math.cos(this.yaw), rgtZ = -Math.sin(this.yaw);
      wishX = rgtX * mv.x + fwdX * mv.z;
      wishZ = rgtZ * mv.x + fwdZ * mv.z;
      const sprint = input.sprinting() && mv.z > 0.3 && !input.aimHeld;
      this.sprinting = sprint && (Math.abs(mv.x) > 0.05 || Math.abs(mv.z) > 0.05);
      speed = input.aimHeld ? 3.3 : sprint ? 6.7 : 4.7;
      // wading
      const th = heightAt(this.pos.x, this.pos.z);
      if (th < -0.5 && this.pos.y < 0.6) speed *= 0.55;
    }

    // ---- SLIDE ----
    if (this.slideCooldown > 0) this.slideCooldown -= dt;
    const hSpd = Math.hypot(this.vel.x, this.vel.z);
    if (!frozen && this.alive && input.consumeSlide() && !this.sliding && this.grounded && this.slideCooldown <= 0 && hSpd > 2.2) {
      this.sliding = true;
      this.slideT = 0.72;
      const len = hSpd || 1;
      this.slideDir.set(this.vel.x / len, 0, this.vel.z / len);
      // burst of speed into the slide — bigger if you drop into a descent
      const g0 = groundSlopeAt(this.pos.x, this.pos.z, this.pos.y, this.r * 0.85, game.ctx, this._grad || (this._grad = new THREE.Vector3()));
      const gm0 = Math.hypot(g0.x, g0.z);
      let steep = 0;
      if (gm0 > 0.012) steep = Math.max(0, (-g0.x * this.slideDir.x - g0.z * this.slideDir.z) / gm0) * Math.min(1, gm0);
      const boost = Math.min(13.5, hSpd * 1.42 + 1.6 + steep * 5.5);
      this.vel.x = this.slideDir.x * boost;
      this.vel.z = this.slideDir.z * boost;
      this.airSlideT = 0;
      game.sound.land(false);
      game.effects.spawn(this.pos.x, this.pos.y + 0.1, this.pos.z, {
        count: 16, color: 0xd8cfae, color2: 0xffffff, speed: 3.4, up: 0.8, size: 1.7, life: 0.5, gravity: -3, drag: 3.2,
      });
      game.effects.shake(0.05);
    }
    if (this.sliding) {
      const grad = this._grad || (this._grad = new THREE.Vector3());
      let downhill = 0;
      if (this.grounded) {
        groundSlopeAt(this.pos.x, this.pos.z, this.pos.y, this.r * 0.85, game.ctx, grad);
        const gm = Math.hypot(grad.x, grad.z);
        // Gravity pulls you along the surface: a = G * sin(theta), theta = atan(gm)
        if (gm > 0.012) {
          const inv = 1 / Math.sqrt(1 + gm * gm);
          const sinT = gm * inv;             // sin of slope angle
          const accel = SLIDE_GRAVITY * sinT;
          // unit downhill direction (-gradient)
          const dxn = -grad.x / gm, dzn = -grad.z / gm;
          this.vel.x += dxn * accel * dt;
          this.vel.z += dzn * accel * dt;
          // how aligned is our travel with downhill? (1 = straight down the slope)
          const sp = Math.hypot(this.vel.x, this.vel.z);
          if (sp > 0.001) downhill = (this.vel.x * dxn + this.vel.z * dzn) / sp * sinT;
        }
        // Friction scales with how flat the ground is — steep = slick, flat = drag
        const slick = Math.max(0, downhill);
        const fric = SLIDE_FRICTION * (1 - Math.min(0.92, slick * 2.6));
        const fr = 1 / (1 + fric * dt);
        this.vel.x *= fr;
        this.vel.z *= fr;
        this.airSlideT = 0;
      } else {
        // launched off a lip — keep the slide armed through the air
        this.airSlideT = (this.airSlideT || 0) + dt;
      }
      // limited steering
      this.vel.x += wishX * 4.2 * dt;
      this.vel.z += wishZ * 4.2 * dt;

      // speed cap
      let cur = Math.hypot(this.vel.x, this.vel.z);
      if (cur > SLIDE_MAX) {
        const s = SLIDE_MAX / cur;
        this.vel.x *= s; this.vel.z *= s;
        cur = SLIDE_MAX;
      }
      this.slideSpeed = cur;

      // Downhill barely drains the timer — long, fast descents are the reward
      this.slideT -= dt * (downhill > 0.05 ? 0.12 : 1);

      // dust trail scales with speed
      this._slideDust = (this._slideDust || 0) - dt;
      if (this._slideDust <= 0 && this.grounded) {
        this._slideDust = 0.04;
        const n = cur > 12 ? 4 : 2;
        game.effects.spawn(this.pos.x, this.pos.y + 0.08, this.pos.z, {
          count: n, color: 0xe2d8b6, color2: 0xffffff, speed: 1.2 + cur * 0.1, up: 0.5, size: 1.5, life: 0.45, gravity: -2.5, drag: 3,
        });
      }
      // rumble when really moving
      if (cur > 14) game.effects.shake(0.012);

      const slowed = cur < 2.6;
      const expired = this.slideT <= 0 && cur < 5.5;
      const released = !input.isSlideHeld() && this.slideT < 0.42 && downhill <= 0.05;
      const fellOff = (this.airSlideT || 0) > 0.75;
      if (slowed || expired || released || fellOff) {
        this.sliding = false;
        this.airSlideT = 0;
        this.slideCooldown = 0.32;
      }
    } else {
      this.slideSpeed = 0;
    }

    const accel = this.grounded ? 14 : 4.0;
    const k = this.sliding ? 0 : 1 - Math.exp(-accel * dt);
    const preSpeed = Math.hypot(this.vel.x, this.vel.z);
    this.vel.x += (wishX * speed - this.vel.x) * k;
    this.vel.z += (wishZ * speed - this.vel.z) * k;
    // air control steers but never adds speed (no air-strafe boosting)
    if (!this.grounded) {
      const newSpeed = Math.hypot(this.vel.x, this.vel.z);
      const cap = Math.max(preSpeed, speed);
      if (newSpeed > cap && newSpeed > 0.001) {
        const s = cap / newSpeed;
        this.vel.x *= s; this.vel.z *= s;
      }
    }

    // jump — grounded (or coyote) only, with input buffering. No flying.
    if (!frozen && this.alive && input.consumeJump()) this.jumpBuffer = 0.13;
    else if (this.jumpBuffer > 0) this.jumpBuffer -= dt;
    if (this.jumpBuffer > 0 && this.canJump && this.alive && !frozen) {
      this.jumpBuffer = 0;
      this.coyote = 0;
      this.canJump = false;
      this.vel.y = 8.4;
      this.grounded = false;
      // slide-hopping keeps your momentum — rewards chaining slides
      if (this.sliding) { this.sliding = false; this.slideCooldown = 0.3; }
      game.sound.jump();
      game.effects.spawn(this.pos.x, this.pos.y + 0.05, this.pos.z, { count: 5, color: 0xd8cfae, speed: 1.5, up: 0.5, size: 1.1, life: 0.4, gravity: -2, drag: 3 });
    }

    const preVy = this.vel.y;
    moveEntity(this, dt, game.ctx);

    if (!this.grounded) this.airTime += dt; else this.airTime = 0;

    // landing feedback
    if (this.justLanded) {
      const hard = preVy < -12;
      this.landDip = hard ? 0.22 : 0.1;
      game.sound.land(hard);
      game.effects.landPuff(this.pos.x, this.pos.y, this.pos.z, hard);
      if (hard) game.effects.shake(0.18);
    }

    // footsteps
    const hSpeed = Math.hypot(this.vel.x, this.vel.z);
    if (this.grounded && hSpeed > 1.5 && this.alive && !frozen) {
      this.stepT -= dt * (hSpeed / 4.7);
      if (this.stepT <= 0) {
        this.stepT = 0.42;
        game.sound.step();
        game.effects.footPuff(this.pos.x, this.pos.y, this.pos.z);
      }
    }

    // ---- camera ----
    const moving = hSpeed > 0.6 && this.grounded;
    if (moving) this.walkT += dt * (3.4 + hSpeed * 1.15);
    const bobAmp = clamp(hSpeed / 6.7, 0, 1) * (this.grounded ? 1 : 0);
    const bobY = Math.sin(this.walkT * 2) * 0.032 * bobAmp;
    const bobX = Math.cos(this.walkT) * 0.02 * bobAmp;
    this.landDip = Math.max(0, this.landDip - dt * 0.9);

    // strafe lean (+ extra roll while sliding)
    const sideVel = this.vel.x * Math.cos(this.yaw) + this.vel.z * -Math.sin(this.yaw);
    this.slideLean = lerp(this.slideLean, this.sliding ? 0.075 : 0, 1 - Math.exp(-11 * dt));
    this.rollLean = lerp(this.rollLean, clamp(-sideVel * 0.006, -0.03, 0.03), 1 - Math.exp(-8 * dt));

    // crouch the camera during a slide
    this.slideDip = lerp(this.slideDip || 0, this.sliding ? 0.62 : 0, 1 - Math.exp(-13 * dt));
    // ...and shrink the actual hitbox to match (bots shoot over you)
    this.h = lerp(this.h, this.sliding ? SLIDE_HEIGHT : STAND_HEIGHT, 1 - Math.exp(-13 * dt));
    this.eye = this.h - 0.18;

    // eye already tracks the shrinking hitbox, so don't double-apply slideDip
    cam.position.set(
      this.pos.x + bobX * Math.cos(this.yaw),
      this.pos.y + this.eye + bobY - this.landDip,
      this.pos.z - bobX * Math.sin(this.yaw)
    );
    cam.rotation.order = "YXZ";
    cam.rotation.y = this.yaw;
    cam.rotation.x = this.pitch + this.recoilPitch;
    cam.rotation.z = this.rollLean + this.slideLean;

    // recoil decay
    this.recoil = Math.max(0, this.recoil - dt * 6);
    this.recoilPitch = Math.max(0, this.recoilPitch - dt * 0.35);

    // head bonk feedback
    if (this.bonkedHead) { this.landDip = Math.max(this.landDip, 0.07); game.sound.land(false); }

    // FOV (scoped weapons zoom further; slides punch it out for speed feel)
    const gunDef = game.activeGun && game.activeGun() ? game.activeGun().def : null;
    const adsFov = gunDef && gunDef.zoom ? gunDef.zoom : 58;
    // slide FOV scales with real speed, so fast ramp runs feel genuinely fast
    const slideFov = 80 + clamp(((this.slideSpeed || 0) - 7) / 18, 0, 1) * 22;
    const targetFov = game.input.aimHeld && this.alive ? adsFov : this.sliding ? slideFov : this.sprinting ? 82 : 75;
    this.fov = lerp(this.fov, targetFov, 1 - Math.exp(-9 * dt));
    if (Math.abs(cam.fov - this.fov) > 0.05) { cam.fov = this.fov; cam.updateProjectionMatrix(); }

    // ---- viewmodel ----
    const g = this.gun;
    const aim = game.input.aimHeld && this.alive ? 1 : 0;
    this._aimK = lerp(this._aimK ?? 0, aim, 1 - Math.exp(-12 * dt));
    // weapon swap raise animation
    this.swapAnim = Math.max(0, (this.swapAnim || 0) - dt * 3.4);
    const swapDrop = this.swapAnim * this.swapAnim * 0.45;
    const reloading = gunDef ? game.activeGun().reloading : false;
    const reloadT = gunDef ? game.activeGun().reloadT : 0;
    const targetX = lerp(this.gunHome.x, 0.0, this._aimK);
    const targetY = lerp(this.gunHome.y, -0.2, this._aimK);
    const targetZ = lerp(this.gunHome.z, -0.4, this._aimK);
    g.position.set(
      targetX + Math.cos(this.walkT) * 0.008 * bobAmp,
      targetY + Math.sin(this.walkT * 2) * 0.01 * bobAmp + this.recoil * 0.015 - swapDrop,
      targetZ + this.recoil * 0.09
    );
    g.rotation.x = this.recoil * 0.16 + (reloading ? Math.sin(reloadT * 6) * 0.35 - 0.5 : 0) + swapDrop * 1.4;
    g.rotation.z = this.rollLean * 2;
    g.visible = this.alive;
  }

  muzzleWorld(out) {
    out.copy(this.muzzleLocal);
    this.gun.localToWorld(out);
    return out;
  }
}
