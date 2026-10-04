// ============================================================
// Game.js — orchestrator: render loop, match flow, combat,
// storm, pickups, score, HUD bridge
// ============================================================
import * as THREE from "three";
import { buildWorld, heightAt, ISLAND_R } from "./world.js";
import { Effects } from "./effects.js";
import { SoundEngine } from "./audio.js";
import { Input } from "./input.js";
import { Player } from "./player.js";
import { BotManager } from "./bots.js";
import { Builds } from "./builds.js";
import { clamp, lerp, rand, pick, DIFFICULTIES, STREAK_NAMES, rayCylinderY, rayEllipsoid, rayTaperedCylinder, TAU, setSeed, resetSeed } from "./utils.js";
import { rayAABB, losBlocked, rayRamp } from "./physics.js";
import { WEAPONS, RARITY, STARTER, rollWeapon, makeInstance, buildWorldGun } from "./weapons.js";
import { TILE_N } from "./builds.js";
import { NavGrid } from "./nav.js";
import { RemotePlayer } from "../net/RemotePlayer.js";

const PHASES = [
  { hold: 15, shrink: 27, r: 205, dmg: 2 },
  { hold: 11, shrink: 23, r: 130, dmg: 3.5 },
  { hold: 9, shrink: 19, r: 72, dmg: 6 },
  { hold: 8, shrink: 14, r: 34, dmg: 9 },
  { hold: 7, shrink: 12, r: 14, dmg: 13 },
  { hold: 6, shrink: 10, r: 2.5, dmg: 19 },
];

function makeStormTexture() {
  const c = document.createElement("canvas");
  c.width = 256; c.height = 128;
  const ctx = c.getContext("2d");
  ctx.clearRect(0, 0, 256, 128);
  for (let i = 0; i < 90; i++) {
    const x = Math.random() * 256, y = Math.random() * 128;
    const h = 20 + Math.random() * 70;
    const grad = ctx.createLinearGradient(x, y, x + 12, y + h);
    grad.addColorStop(0, "rgba(200,140,255,0)");
    grad.addColorStop(0.5, `rgba(200,140,255,${0.16 + Math.random() * 0.22})`);
    grad.addColorStop(1, "rgba(200,140,255,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, 4 + Math.random() * 10, h);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

export class Game {
  constructor({ container, hudRoot, hooks, isTouch, prefs }) {
    this.container = container;
    this.hooks = hooks;
    this.isTouch = isTouch;
    this.settings = { sensitivity: 1, volume: 0.8, quality: "high", ...prefs };

    // state
    this.state = "boot"; // menu | countdown | live | paused | over
    this.time = 0;
    this.matchTime = 0;
    this.diff = DIFFICULTIES.normal;
    this.diffKey = "normal";
    this.score = 0;
    this.killStreak = 0;
    this.streakT = 0;
    this.pings = [];
    this._result = null;

    // three
    const w = container.clientWidth, h = container.clientHeight;
    this.renderer = new THREE.WebGLRenderer({ antialias: !isTouch, powerPreference: "high-performance" });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, isTouch ? 1.6 : 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.06;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);
    this.canvas = this.renderer.domElement;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x9fd6ff);
    this.camera = new THREE.PerspectiveCamera(75, w / h, 0.035, 1500);
    this.scene.add(this.camera);

    this.sound = new SoundEngine();
    this.sound.setVolume(this.settings.volume);
    this.input = new Input();
    this.effects = new Effects(this.scene, hudRoot);

    // world
    this.world = buildWorld(this.scene);
    this.builds = new Builds(this.scene, this.effects, this.sound);
    this.player = new Player(this);
    this.player.attachGun(this.camera);
    this.player.gun.visible = false;
    this.bots = new BotManager(this);

    this.ctx = { hashWorld: this.world.colliders, hashBuilds: this.builds.hash };
    this.nav = new NavGrid(this);
    this.builds.nav = this.nav;

    // weapon: shared state + 2-slot loadout
    this.weapon = { fireT: 0, bloom: 0, mode: 0, placeT: 0 };
    this.loadout = [makeInstance(WEAPONS[STARTER]), null];
    this.slot = 0;
    this.groundItems = [];
    this._itemRoot = new THREE.Group();
    this.scene.add(this._itemRoot);
    this.nearItem = null;
    this.nearChest = null;
    this.edit = null;
    this.editTarget = null;

    // storm
    this.storm = { x: 0, z: 0, r: 260, nextX: 0, nextZ: 0, nextR: 175, dmg: 2, phase: 0, state: "hold", t: 14 };
    this.stormFrom = { x: 0, z: 0, r: 260 };
    this._stormDmgAcc = 0;
    this._makeStormVisuals();

    // pickups
    this.pickups = [];
    this._makePickups();

    // name tags
    this._nameTagPool = [];
    for (let i = 0; i < 10; i++) {
      const el = document.createElement("div");
      el.className = "name-tag";
      el.style.display = "none";
      el.innerHTML = '<div class="nt-name font-ui" style="font-size:12px;font-weight:600;letter-spacing:0.06em;color:#fff"></div><div style="width:44px;height:4px;background:rgba(0,0,0,0.55);border-radius:2px;margin:2px auto 0;overflow:hidden"><div class="nt-hp" style="height:100%;width:100%;background:#3df5c4;border-radius:2px"></div></div>';
      hudRoot.appendChild(el);
      this._nameTagPool.push({ el, nameEl: el.querySelector(".nt-name"), hpEl: el.querySelector(".nt-hp") });
    }
    this._tagT = 0;

    // menu camera path
    this.menuAngle = 0;
    this._camShake = { yaw: 0, pitch: 0, roll: 0 };

    // loop
    this._last = performance.now();
    this._raf = 0;
    this._running = false;

    this._onResize = () => this.resize();
    window.addEventListener("resize", this._onResize);
    this._onVis = () => { if (document.hidden && this.state === "live") this.pause(); };
    document.addEventListener("visibilitychange", this._onVis);

    this._v1 = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._v3 = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._origin = new THREE.Vector3();
  }

  get matchLive() { return this.state === "live"; }

  // ============================ 1v1 DUEL (networked) ============================
  // Relay model: we simulate OUR player and send snapshots; the peer does the
  // same. Builds are grid-quantised integers so they replicate exactly.
  attachNet(net) {
    this.net = net;
    net.on("matched", (d) => this.startDuel(d));
    net.on("state", (d) => { if (this.remote) this.remote.applyState(d, performance.now()); });
    net.on("shot", (d) => this._onPeerShot(d));
    net.on("hit", (d) => this._onPeerHit(d));
    net.on("build", (d) => this._onPeerBuild(d));
    net.on("edit", (d) => this._onPeerEdit(d));
    net.on("destroy", (d) => this._onPeerDestroy(d));
    net.on("died", () => this._onPeerDied());
    net.on("peerleft", () => this._onPeerLeft());
  }

  startDuel(d) {
    this.duel = { slot: d.slot, seed: d.seed, peerName: d.peerName || "RIVAL" };
    this.diffKey = "duel";
    this.diff = DIFFICULTIES.normal;
    this.botCount = 0;
    this.time = 0;
    this.matchTime = 0;
    this.score = 0;
    this.kills = 0;
    this.killStreak = 0;
    this.placement = 2;
    this.totalPlayers = 2;
    this.pings.length = 0;
    this.effects.clearAll();
    this.builds.reset();
    this.sound.stopAll();
    this.bots.reset();
    this.nav.invalidateAll();
    this.weapon = { fireT: 0, bloom: 0, mode: 0, placeT: 0 };
    this.loadout = [makeInstance(WEAPONS[STARTER]), makeInstance(WEAPONS.ar)];
    this.slot = 0;
    this.player.setWeaponModel(STARTER);
    for (const it of this.groundItems) this._itemRoot.remove(it.mesh);
    this.groundItems.length = 0;
    this.edit = null;
    this.editTarget = null;
    this.world.resetChests();

    // storm driven by the shared seed so both clients agree
    setSeed(d.seed);
    const ang = rand(0, TAU), off = rand(0, 30);
    this.storm = { x: Math.cos(ang) * off, z: Math.sin(ang) * off, r: 315, nextX: 0, nextZ: 0, nextR: 315, dmg: PHASES[0].dmg, phase: 0, state: "hold", t: PHASES[0].hold };
    this._rollNextZone();
    resetSeed();

    const sp = d.spawn;
    this.player.spawnAt({ x: sp.x, z: sp.z, y: heightAt(sp.x, sp.z) });
    this._resetPickups();

    if (!this.remote) this.remote = new RemotePlayer(this, this.duel.peerName);
    this.remote.name = this.duel.peerName;
    this.remote.reset({ x: d.peerSpawn.x, y: heightAt(d.peerSpawn.x, d.peerSpawn.z), z: d.peerSpawn.z });

    this.player.gun.visible = true;
    this.state = "countdown";
    this.countdownT = (d.countdownMs || 3000) / 1000;
    this._cdStep = -1;
    this.input.enabled = true;
    this.input.resetTransient();
    this._netT = 0;
    if (!this.isTouch) this.input.requestLock();
    this.hooks.event("matchstart", { diff: this.diff, duel: true, peer: this.duel.peerName });
  }

  _netSend(dt) {
    if (!this.net || !this.duel) return;
    this._netT -= dt;
    if (this._netT > 0) return;
    this._netT = 0.05; // 20Hz
    const p = this.player;
    this.net.send("state", {
      x: +p.pos.x.toFixed(2), y: +p.pos.y.toFixed(2), z: +p.pos.z.toFixed(2),
      yaw: +p.yaw.toFixed(3), pitch: +p.pitch.toFixed(3),
      sl: p.sliding, gr: p.grounded,
      sp: +Math.hypot(p.vel.x, p.vel.z).toFixed(1),
      hp: Math.round(p.hp), sh: Math.round(p.shield),
    });
  }

  _onPeerShot(d) {
    if (!this.remote) return;
    const from = this._v1.set(d.mx, d.my, d.mz);
    const to = this._v2.set(d.tx, d.ty, d.tz);
    this.effects.tracer(from, to, d.c || 0xffd9a0);
    const dist = this.distToPlayer(from);
    if (dist < 60) this.effects.muzzleFlash(from, 0.9, false);
    this.sound.enemyShoot(0, dist);
    this.pings.push({ x: d.mx, z: d.mz, t: this.time });
  }

  // Peer says they hit us. Relay model = we trust them and apply it locally,
  // which keeps HP authoritative on the victim's own machine (no rubber-banding).
  _onPeerHit(d) {
    if (!this.player.alive) return;
    this._hurtPlayer(d.dmg || 10, { name: this.duel ? this.duel.peerName : "RIVAL" }, false);
    this.effects.impact({ x: d.x, y: d.y, z: d.z }, this.player.shield > 0 ? "shield" : "flesh");
  }

  _onPeerBuild(d) {
    const spec = {
      type: d.ty, ix: d.ix, iz: d.iz, L: d.L,
      orient: d.o || 0, yaw: (d.y || 0) * (Math.PI / 2), yawIdx: d.y || 0,
      key: this.builds.key(d.ty, d.ix, d.iz, d.L, d.ty === "wall" ? (d.o || 0) : (d.y || 0)),
    };
    const p = this.builds.place(spec, this.remote);
    if (p && d.tiles) { p.tiles = d.tiles.slice(); this.builds._reCollide(p); this.builds.dirty[p.type] = true; }
  }

  _onPeerEdit(d) {
    const key = this.builds.key(d.ty, d.ix, d.iz, d.L, d.ty === "wall" ? (d.o || 0) : (d.y || 0));
    const p = this.builds.cellMap.get(key);
    if (p && d.tiles) this.builds.applyTiles(p, d.tiles);
  }

  _onPeerDestroy(d) {
    const key = this.builds.key(d.ty, d.ix, d.iz, d.L, d.ty === "wall" ? (d.o || 0) : (d.y || 0));
    const p = this.builds.cellMap.get(key);
    if (p) this.builds._removePiece(p);
  }

  _onPeerDied() {
    if (this.remote) this.remote.setDead(true);
    this.kills = 1;
    this.score += 400;
    this.sound.kill();
    this.effects.shake(0.25);
    this.hooks.event("killfeed", { killer: "YOU", victim: this.duel ? this.duel.peerName : "RIVAL", you: true, head: false, elite: false });
    this._endMatch(true, null);
  }

  _onPeerLeft() {
    if (this.state === "live" || this.state === "countdown") {
      this.hooks.event("peerleft", {});
      this._endMatch(true, null);
    }
    if (this.remote) this.remote.setDead(true);
    this.duel = null;
  }

  // broadcast helpers used by the normal gameplay code
  netBuild(p) {
    if (!this.net || !this.duel || !p) return;
    this.net.send("build", {
      ty: p.type, ix: p.ix, iz: p.iz, L: p.L,
      o: p.orient || 0, y: p.type === "ramp" ? Math.round(p.yaw / (Math.PI / 2)) : 0,
    });
  }
  netEdit(p) {
    if (!this.net || !this.duel || !p) return;
    this.net.send("edit", {
      ty: p.type, ix: p.ix, iz: p.iz, L: p.L,
      o: p.orient || 0, y: p.type === "ramp" ? Math.round(p.yaw / (Math.PI / 2)) : 0,
      tiles: p.tiles,
    });
  }

  // ============================ boot & flow ============================
  boot() {
    this.state = "menu";
    this.input.attach(this.canvas);
    this.input.onLockChange = (locked) => {
      if (!locked && this.state === "live" && !this.isTouch) this.pause();
      this.hooks.event("lockchange", { locked });
    };
    this.applyQuality();
    this._running = true;
    this._last = performance.now();
    const loop = (now) => {
      if (!this._running) return;
      this._raf = requestAnimationFrame(loop);
      this._tick(now);
    };
    this._raf = requestAnimationFrame(loop);
  }

  startMatch(diffKey, botCount = 50) {
    this.duel = null;
    if (this.remote) this.remote.setDead(true);
    this.diffKey = diffKey;
    this.diff = DIFFICULTIES[diffKey] || DIFFICULTIES.normal;
    this.botCount = clamp(Math.round(botCount), 1, 100);
    this.time = 0;
    this.matchTime = 0;
    this.score = 0;
    this.kills = 0;
    this.killStreak = 0;
    this.streakT = 0;
    this._stormDmgAcc = 0;
    this.placement = this.botCount + 1;
    this.pings.length = 0;
    this.effects.clearAll();
    this.builds.reset();
    this.sound.stopAll();
    this.weapon = { fireT: 0, bloom: 0, mode: 0, placeT: 0 };

    // reset loadout to the starter sidearm
    this.loadout = [makeInstance(WEAPONS[STARTER]), null];
    this.slot = 0;
    this.player.setWeaponModel(STARTER);
    for (const it of this.groundItems) this._itemRoot.remove(it.mesh);
    this.groundItems.length = 0;
    this.nearItem = null;
    this.nearChest = null;
    this.edit = null;
    this.editTarget = null;
    this.nav.invalidateAll();
    this.world.resetChests();

    // storm reset
    const ang = rand(0, TAU), off = rand(0, 40);
    this.storm = { x: Math.cos(ang) * off, z: Math.sin(ang) * off, r: 315, nextX: 0, nextZ: 0, nextR: 315, dmg: PHASES[0].dmg, phase: 0, state: "hold", t: PHASES[0].hold };
    this._rollNextZone();

    // player spawn
    const sp = this.world.spawnPoints[(Math.random() * this.world.spawnPoints.length) | 0];
    this.player.spawnAt(sp);

    // bots
    const n = this.bots.spawnAll(this.botCount, this.diff, this.player.pos);
    this.totalPlayers = n + 1;

    // a guaranteed chest + weapon near the drop so the first 10s has a goal
    {
      const a = rand(0, TAU);
      const gx = this.player.pos.x + Math.cos(a) * 7, gz = this.player.pos.z + Math.sin(a) * 7;
      this.spawnGroundGun(rollWeapon(), gx, heightAt(gx, gz), gz, 0);
    }

    // make 2 nearest bots wander toward the player for early action
    const close = this.bots.bots.filter((b) => b.alive).sort((a, b) => a.pos.distanceTo(this.player.pos) - b.pos.distanceTo(this.player.pos)).slice(0, 2);
    for (const b of close) b.moveTarget = { x: this.player.pos.x + rand(-12, 12), z: this.player.pos.z + rand(-12, 12) };

    // pickups Respawn
    this._resetPickups();

    // gun visible
    this.player.gun.visible = true;

    this.state = "countdown";
    this.countdownT = 2.0;
    this._cdStep = -1;
    this.input.enabled = true;
    this.input.resetTransient();
    if (!this.isTouch) this.input.requestLock();
    this.hooks.event("matchstart", { diff: this.diff });
  }

  pause() {
    if (this.state !== "live" && this.state !== "countdown") return;
    this._pausedFrom = this.state;
    this.state = "paused";
    this.input.enabled = false;
    this.input.releaseLock();
    this.sound.setStorm(0);
    this.hooks.event("pause", {});
  }

  resume() {
    if (this.state !== "paused") return;
    this.state = this._pausedFrom || "live";
    this.input.enabled = true;
    if (!this.isTouch) this.input.requestLock();
    this.hooks.event("resume", {});
  }

  quitToMenu() {
    this.state = "menu";
    if (this.duel && this.net) this.net.leave();
    this.duel = null;
    if (this.remote) this.remote.setDead(true);
    this.input.enabled = false;
    this.input.releaseLock();
    this.bots.reset();
    this.builds.reset();
    this.effects.clearAll();
    this.sound.stopAll();
    this.player.gun.visible = false;
    this.player.alive = false;
    for (const it of this.groundItems) this._itemRoot.remove(it.mesh);
    this.groundItems.length = 0;
    this.nearItem = null;
    this.nearChest = null;
    this.edit = null;
    this.editTarget = null;
    this.builds.hideEditGrid();
    this._clearNameTags();
    this.hooks.event("menu", {});
  }

  applyQuality() {
    const valid = ["bare", "min", "low", "high"];
    const q = valid.includes(this.settings.quality) ? this.settings.quality : "high";
    const prTable = this.isTouch
      ? { high: 1.6, low: 1.15, min: 0.8, bare: 0.5 }
      : { high: 2, low: 1.25, min: 0.85, bare: 0.55 };
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, prTable[q]));
    this.world.sun.castShadow = q === "high" && !this.isTouch;
    this.effects.particleBudget = q === "high" ? 1 : q === "low" ? 0.55 : q === "min" ? 0.3 : 0.12;
    this.effects.blobs.visible = q === "high" || q === "low";
    const bare = q === "bare";
    // BARE: no clouds/water shine/storm inner glow, tight fog, flat lighting
    if (this.scene.fog) {
      this.scene.fog.near = bare ? 40 : q === "min" ? 70 : 110;
      this.scene.fog.far = bare ? 210 : q === "min" ? 330 : 520;
    }
    if (this.world.cloudMesh) this.world.cloudMesh.visible = !bare;
    if (this.stormWall2) this.stormWall2.visible = !bare;
    if (this.world.water) this.world.water.material.shininess = bare ? 0 : 90;
    this.effects.points.visible = q !== "bare" ? true : true; // particles still fire, just fewer
    this.maxTagCount = bare ? 4 : q === "min" ? 6 : 10;
  }

  setPrefs(p) {
    Object.assign(this.settings, p);
    this.sound.setVolume(this.settings.volume);
    this.applyQuality();
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  // ============================ storm visuals ============================
  _makeStormVisuals() {
    const tex = makeStormTexture();
    this.stormTex = tex;
    const geo = new THREE.CylinderGeometry(1, 1, 220, 72, 1, true);
    const mat = new THREE.MeshBasicMaterial({ color: 0xb46bff, transparent: true, opacity: 0.42, side: THREE.DoubleSide, depthWrite: false, map: tex, fog: false });
    this.stormWall = new THREE.Mesh(geo, mat);
    this.stormWall.position.y = 90;
    this.stormWall.renderOrder = 8;
    this.stormWall.frustumCulled = false;
    this.scene.add(this.stormWall);

    const geo2 = new THREE.CylinderGeometry(1, 1, 200, 48, 1, true);
    const mat2 = new THREE.MeshBasicMaterial({ color: 0xd9a8ff, transparent: true, opacity: 0.14, side: THREE.DoubleSide, depthWrite: false, fog: false, blending: THREE.AdditiveBlending });
    this.stormWall2 = new THREE.Mesh(geo2, mat2);
    this.stormWall2.position.y = 83;
    this.stormWall2.renderOrder = 9;
    this.stormWall2.frustumCulled = false;
    this.scene.add(this.stormWall2);
  }

  _rollNextZone() {
    const s = this.storm;
    const ph = PHASES[Math.min(s.phase, PHASES.length - 1)];
    const maxOff = Math.max(0, (s.r - ph.r) * 0.55);
    const a = rand(0, TAU), d = rand(0, maxOff);
    s.nextX = clamp(s.x + Math.cos(a) * d, -ISLAND_R * 0.7, ISLAND_R * 0.7);
    s.nextZ = clamp(s.z + Math.sin(a) * d, -ISLAND_R * 0.7, ISLAND_R * 0.7);
    s.nextR = ph.r;
  }

  _updateStorm(dt) {
    const s = this.storm;
    s.t -= dt;
    if (s.state === "hold") {
      if (s.t <= 0) {
        s.state = "shrink";
        s.t = PHASES[Math.min(s.phase, PHASES.length - 1)].shrink;
        this.stormFrom = { x: s.x, z: s.z, r: s.r };
        this.sound.streak();
        this.hooks.event("storm", { shrinking: true, phase: s.phase + 1 });
      }
    } else {
      const ph = PHASES[Math.min(s.phase, PHASES.length - 1)];
      const k = clamp(1 - s.t / ph.shrink, 0, 1);
      const e = k * k * (3 - 2 * k);
      s.x = lerp(this.stormFrom.x, s.nextX, e);
      s.z = lerp(this.stormFrom.z, s.nextZ, e);
      s.r = lerp(this.stormFrom.r, s.nextR, e);
      if (s.t <= 0) {
        s.phase = Math.min(s.phase + 1, PHASES.length - 1);
        s.dmg = PHASES[s.phase].dmg;
        if (s.phase >= PHASES.length - 1 && s.r <= 3) {
          s.state = "hold"; s.t = 9999; // final circle
        } else {
          this._rollNextZone();
          s.state = "hold";
          s.t = PHASES[s.phase].hold;
          this.hooks.event("storm", { shrinking: false, phase: s.phase + 1 });
        }
      }
    }
    // visuals
    this.stormWall.scale.set(s.r, 1, s.r);
    this.stormWall.position.x = s.x; this.stormWall.position.z = s.z;
    this.stormWall2.scale.set(s.r * 0.985, 1, s.r * 0.985);
    this.stormWall2.position.x = s.x; this.stormWall2.position.z = s.z;
    this.stormTex.offset.x += dt * 0.045;
    this.stormTex.offset.y += dt * 0.012;

    // dusk progression: light cools & dims as the storm closes
    const dusk = clamp(s.phase / (PHASES.length - 1) + (s.r < 40 ? 0.25 : 0), 0, 1);
    this.world.sun.intensity = lerp(1.9, 1.15, dusk);
    this.world.hemi.intensity = lerp(0.85, 0.55, dusk);
    this.world.sun.color.setHSL(lerp(0.1, 0.02, dusk), lerp(0.45, 0.75, dusk), lerp(0.72, 0.58, dusk));
    this.scene.fog.color.setHSL(lerp(0.58, 0.7, dusk), lerp(0.32, 0.42, dusk), lerp(0.85, 0.62, dusk));

    // damage + ambience
    if (this.player.alive) {
      const d = Math.hypot(this.player.pos.x - s.x, this.player.pos.z - s.z);
      this.inStorm = d > s.r;
      if (this.inStorm) {
        this._stormDmgAcc += dt * s.dmg;
        if (this._stormDmgAcc >= 1) {
          const dmg = Math.floor(this._stormDmgAcc);
          this._stormDmgAcc -= dmg;
          this._hurtPlayer(dmg, null, true);
          this.effects.stormTick(this.player.pos);
        }
        this.sound.setStorm(clamp((d - s.r + 6) / 22, 0.2, 1));
      } else {
        this.sound.setStorm(0);
      }
    }
  }

  // ============================ pickups ============================
  _makePickups() {
    const mkGeo = (fn, hex) => {
      const mat = new THREE.MeshLambertMaterial({ color: hex, emissive: hex, emissiveIntensity: 0.35 });
      return { geo: fn(), mat };
    };
    const medGeoFn = () => {
      const a = new THREE.BoxGeometry(0.7, 0.24, 0.24);
      const b = new THREE.BoxGeometry(0.24, 0.7, 0.24);
      const g = new THREE.BoxGeometry(0.7, 0.24, 0.24);
      // manual merge of a & b
      const total = a.attributes.position.count + b.attributes.position.count;
      const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3), uv = new Float32Array(total * 2);
      pos.set(a.attributes.position.array, 0); pos.set(b.attributes.position.array, a.attributes.position.count * 3);
      nor.set(a.attributes.normal.array, 0); nor.set(b.attributes.normal.array, a.attributes.position.count * 3);
      uv.set(a.attributes.uv.array, 0); uv.set(b.attributes.uv.array, a.attributes.position.count * 2);
      const idx = [];
      for (let i = 0; i < a.index.count; i++) idx.push(a.index.array[i]);
      for (let i = 0; i < b.index.count; i++) idx.push(b.index.array[i] + a.attributes.position.count);
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      g.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
      g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
      g.setIndex(idx);
      return g;
    };
    this.pickupDefs = {
      med: mkGeo(medGeoFn, 0x51e07a),
      shield: mkGeo(() => new THREE.OctahedronGeometry(0.42, 0), 0x4fc8ff),
    };
    for (const t of ["med", "shield"]) {
      const mesh = new THREE.InstancedMesh(this.pickupDefs[t].geo, this.pickupDefs[t].mat, 50);
      mesh.count = 0;
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      this.pickupDefs[t].mesh = mesh;
    }
  }

  _resetPickups() {
    for (const p of this.pickups) p.active = true;
    // first-time spawn
    if (!this.pickups.length) {
      const spots = [...this.world.lootSpots].sort(() => Math.random() - 0.5);
      let i = 0;
      for (const s of spots) {
        if (i >= 30) break;
        this.pickups.push({ type: i % 2 === 0 ? "med" : "shield", x: s.x, y: s.y, z: s.z, active: true, respawnT: 0, phase: rand(0, 6) });
        i++;
      }
      // a couple right next to player spawn
      for (let k = 0; k < 2; k++) {
        const a = rand(0, TAU), d = rand(4, 9);
        const x = this.player.pos.x + Math.cos(a) * d, z = this.player.pos.z + Math.sin(a) * d;
        const y = heightAt(x, z);
        if (y > 0.3) this.pickups.push({ type: k % 2 ? "shield" : "med", x, y: y + 0.55, z, active: true, respawnT: 0, phase: rand(0, 6) });
      }
    } else {
      // add fresh ones near player again
      for (let k = 0; k < 2; k++) {
        const a = rand(0, TAU), d = rand(4, 9);
        const x = this.player.pos.x + Math.cos(a) * d, z = this.player.pos.z + Math.sin(a) * d;
        const y = heightAt(x, z);
        if (y > 0.3 && this.pickups.length < 44) this.pickups.push({ type: k % 2 ? "shield" : "med", x, y: y + 0.55, z, active: true, respawnT: 0, phase: rand(0, 6) });
      }
    }
  }

  _updatePickups(dt) {
    const obj = this._pickObj || (this._pickObj = new THREE.Object3D());
    const counts = { med: 0, shield: 0 };
    for (const p of this.pickups) {
      if (!p.active) {
        p.respawnT -= dt;
        if (p.respawnT <= 0) p.active = true;
        else continue;
      }
      // collect?
      if (this.player.alive) {
        const dx = this.player.pos.x - p.x, dz = this.player.pos.z - p.z;
        const dy = (this.player.pos.y + 0.9) - p.y;
        if (dx * dx + dz * dz < 1.7 && Math.abs(dy) < 2) {
          let used = false;
          if (p.type === "med" && this.player.hp < 100) { this.player.hp = Math.min(100, this.player.hp + 25); used = true; }
          if (p.type === "shield" && this.player.shield < 100) { this.player.shield = Math.min(100, this.player.shield + 25); used = true; }
          if (used) {
            p.active = false; p.respawnT = 75;
            this.sound.pickup();
            this.effects.pickupBurst({ x: p.x, y: p.y, z: p.z }, p.type === "med" ? 0x51e07a : 0x4fc8ff);
            this.hooks.event("pickup", { type: p.type });
            continue;
          }
        }
      }
      const mesh = this.pickupDefs[p.type].mesh;
      if (counts[p.type] >= 50) continue;
      obj.position.set(p.x, p.y + Math.sin(this.time * 2 + p.phase) * 0.12, p.z);
      obj.rotation.y = this.time * 1.6 + p.phase;
      obj.rotation.x = 0;
      obj.scale.setScalar(1);
      obj.updateMatrix();
      mesh.setMatrixAt(counts[p.type]++, obj.matrix);
    }
    for (const t of ["med", "shield"]) {
      const mesh = this.pickupDefs[t].mesh;
      mesh.count = counts[t];
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  dropPickup(x, y, z) {
    if (this.pickups.length > 70) return;
    this.pickups.push({ type: Math.random() < 0.5 ? "med" : "shield", x, y: heightAt(x, z) + 0.55, z, active: true, respawnT: 0, phase: rand(0, 6) });
  }

  // ============================ weapons & loot ============================
  activeGun() { return this.loadout[this.slot]; }

  setSlot(i) {
    if (i === this.slot || !this.loadout[i]) return;
    this.slot = i;
    const g = this.activeGun();
    if (g) { g.reloading = false; g.reloadT = 0; }
    this.weapon.fireT = Math.max(this.weapon.fireT, 0.22);
    this.weapon.bloom = 0;
    this.player.setWeaponModel(g.def.id);
    this.sound.uiClick();
    this.hooks.event("weapon", { name: g.def.name, rarity: g.def.rarity });
  }

  swapSlot() {
    const other = this.slot === 0 ? 1 : 0;
    if (this.loadout[other]) this.setSlot(other);
  }

  // Spawn a pickup-able weapon in the world
  spawnGroundGun(def, x, y, z, vel) {
    if (this.groundItems.length > 26) {
      const old = this.groundItems.shift();
      this._itemRoot.remove(old.mesh);
    }
    const hex = RARITY[def.rarity].color;
    const mesh = buildWorldGun(def.id, hex);
    mesh.position.set(x, y + 0.9, z);
    this._itemRoot.add(mesh);
    this.groundItems.push({ def, mesh, x, y: y + 0.9, z, phase: rand(0, 6), vy: vel || 0, settled: !vel });
  }

  openChest(chest) {
    if (chest.opened) return;
    chest.opened = true;
    this.sound.pickup();
    this.sound.build();
    this.effects.spawn(chest.x, chest.y + 0.7, chest.z, {
      count: 34, color: 0xffd166, color2: 0xfff4c8, speed: 4.5, up: 3.2, size: 2, life: 0.9, gravity: -6, drag: 2.5,
    });
    this.effects.shake(0.06);
    // weapon + consumables burst out
    const def = rollWeapon();
    this.spawnGroundGun(def, chest.x + rand(-0.8, 0.8), chest.y + 0.5, chest.z + rand(-0.8, 0.8), 3.2);
    const n = 1 + (Math.random() < 0.55 ? 1 : 0);
    for (let i = 0; i < n; i++) {
      const a = rand(0, TAU);
      this.dropPickup(chest.x + Math.cos(a) * 1.5, chest.y, chest.z + Math.sin(a) * 1.5);
    }
    this.hooks.event("chest", { weapon: def.name, rarity: def.rarity });
  }

  equipGroundItem(item) {
    const idx = this.groundItems.indexOf(item);
    if (idx < 0) return;
    const empty = this.loadout.indexOf(null);
    let droppedDef = null;
    if (empty >= 0) {
      this.loadout[empty] = makeInstance(item.def);
      this.slot = empty;
    } else {
      droppedDef = this.loadout[this.slot].def;
      this.loadout[this.slot] = makeInstance(item.def);
    }
    this.groundItems.splice(idx, 1);
    this._itemRoot.remove(item.mesh);
    this.player.setWeaponModel(item.def.id);
    this.weapon.fireT = 0.25;
    this.weapon.bloom = 0;
    this.sound.pickup();
    this.effects.pickupBurst({ x: item.x, y: item.y, z: item.z }, RARITY[item.def.rarity].color);
    // drop the replaced gun so you can swap back
    if (droppedDef) {
      this.spawnGroundGun(droppedDef, this.player.pos.x + rand(-1.2, 1.2), this.player.pos.y + 0.4, this.player.pos.z + rand(-1.2, 1.2), 2.2);
    }
    this.hooks.event("weapon", { name: item.def.name, rarity: item.def.rarity, picked: true });
  }

  _updateLoot(dt) {
    const p = this.player;
    // ground item physics + bob, find nearest
    let best = null, bestD = 3.2;
    for (const it of this.groundItems) {
      if (!it.settled) {
        it.vy -= 16 * dt;
        it.y += it.vy * dt;
        const g = heightAt(it.x, it.z) + 0.55;
        if (it.y <= g) { it.y = g; it.vy = 0; it.settled = true; }
      }
      it.phase += dt;
      it.mesh.position.set(it.x, it.y + Math.sin(it.phase * 1.8) * 0.1, it.z);
      it.mesh.rotation.y += dt * 0.9;
      if (p.alive) {
        const d = Math.hypot(p.pos.x - it.x, p.pos.z - it.z);
        if (d < bestD && Math.abs(p.pos.y + 0.9 - it.y) < 3) { bestD = d; best = it; }
      }
    }
    this.nearItem = best;

    // nearest unopened chest
    let chest = null, cd = 3.0;
    if (p.alive) {
      for (const c of this.world.chests) {
        if (c.opened) continue;
        const d = Math.hypot(p.pos.x - c.x, p.pos.z - c.z);
        if (d < cd && Math.abs(p.pos.y - c.y) < 3) { cd = d; chest = c; }
      }
    }
    this.nearChest = chest;

    // interact
    if (this.input.consumeInteract() && this.state === "live") {
      if (chest && (!best || cd < bestD)) this.openChest(chest);
      else if (best) this.equipGroundItem(best);
    }
  }

  // ============================ combat ============================
  distToPlayer(pos) { return Math.hypot(pos.x - this.player.pos.x, pos.z - this.player.pos.z); }

  // unified hitscan. shooter: 'player' | bot | null
  raycastShot(ox, oy, oz, dx, dy, dz, maxT, shooter) {
    let bestT = maxT, hit = null;

    // -- entities --
    if (shooter !== this.player && this.player.alive) {
      // use the LIVE height so sliding genuinely shrinks your profile
      const ph = this.player.h;
      const pr = this.player.sliding ? 0.5 : 0.48;
      const t = rayCylinderY(ox, oy, oz, dx, dy, dz, this.player.pos.x, this.player.pos.y, this.player.pos.z, pr, ph, bestT);
      if (t >= 0 && t < bestT) { bestT = t; hit = { kind: "player" }; }
    }
    for (const b of this.bots.bots) {
      if (!b.alive || b === shooter) continue;
      const t = rayCylinderY(ox, oy, oz, dx, dy, dz, b.pos.x, b.pos.y, b.pos.z, 0.46, 1.82, bestT);
      if (t >= 0 && t < bestT) { bestT = t; hit = { kind: "bot", bot: b }; }
    }
    // networked opponent
    if (this.remote && this.remote.alive && shooter === this.player && this.duel) {
      const rp = this.remote;
      const t = rayCylinderY(ox, oy, oz, dx, dy, dz, rp.pos.x, rp.pos.y, rp.pos.z, 0.5, rp.h, bestT);
      if (t >= 0 && t < bestT) { bestT = t; hit = { kind: "remote", remote: rp }; }
    }

    // -- colliders (both hashes), stepped query --
    const step = 8;
    const steps = Math.ceil(bestT / step);
    _hashes[0] = this.ctx.hashWorld;
    _hashes[1] = this.ctx.hashBuilds;
    const stamp = ++Game._shotStamp;
    for (let i = 0; i <= steps; i++) {
      const t = Math.min(i * step, bestT);
      const cx = ox + dx * t, cz = oz + dz * t;
      for (const hash of _hashes) {
        if (!hash) continue;
        const items = hash.query(cx, cz, 11, _qHit);
        for (const item of items) {
          if (item.alive === false) continue;
          if (item._shot === stamp) continue;
          item._shot = stamp;
          if (item.kind === "box") {
            const th = rayAABB(ox, oy, oz, dx, dy, dz, item, bestT);
            if (th >= 0 && th < bestT) {
              const kind = item.tag === "crate" ? "crate" : item.tag === "build" ? "build" : item.tag === "chest" ? "chest" : "world";
              bestT = th; hit = { kind, item };
            }
          } else if (item.kind === "ramp") {
            const th = rayRamp(ox, oy, oz, dx, dy, dz, item, bestT);
            if (th >= 0 && th < bestT) { bestT = th; hit = { kind: "build", item }; }
          } else if (item.kind === "cone") {
            const th = rayTaperedCylinder(ox, oy, oz, dx, dy, dz, item.x, item.z, item.y0, item.y1, item.r0, item.r1, bestT);
            if (th >= 0 && th < bestT) { bestT = th; hit = { kind: "world", item }; }
          } else if (item.kind === "sphere") {
            const th = rayEllipsoid(ox, oy, oz, dx, dy, dz, item.x, item.y, item.z, item.r, item.ry, bestT);
            if (th >= 0 && th < bestT) { bestT = th; hit = { kind: "world", item }; }
          } else if (item.kind === "circle") {
            const th = rayCylinderY(ox, oy, oz, dx, dy, dz, item.x, item.y0, item.z, item.r + 0.1, item.y1 - item.y0, bestT);
            if (th >= 0 && th < bestT) { bestT = th; hit = { kind: "world", item }; }
          }
        }
      }
    }

    // -- terrain march --
    let tPrev = 0;
    for (let t = 3; t <= bestT; t += 4) {
      const x = ox + dx * t, y = oy + dy * t, z = oz + dz * t;
      if (heightAt(x, z) > y) {
        // refine
        let lo = tPrev, hi = t;
        for (let k = 0; k < 4; k++) {
          const mid = (lo + hi) / 2;
          if (heightAt(ox + dx * mid, oz + dz * mid) > oy + dy * mid) hi = mid; else lo = mid;
        }
        if (hi < bestT) { bestT = hi; hit = { kind: "ground" }; }
        break;
      }
      tPrev = t;
    }

    if (!hit) return null;
    return { t: bestT, hit, x: ox + dx * bestT, y: oy + dy * bestT, z: oz + dz * bestT };
  }

  _damageCrate(crate, dmg, point) {
    crate.hp -= dmg;
    if (point) this.effects.impact(point, "wood");
    if (crate.hp <= 0 && crate.alive) {
      this.world.destroyCrate(crate);
      this.sound.buildBreak();
      this.effects.buildPuff({ x: crate.x, y: crate.y, z: crate.z }, 0xc98a4b);
      if (Math.random() < 0.16) this.dropPickup(crate.x, crate.y, crate.z);
    }
  }

  firePlayerShot() {
    const wpn = this.weapon;
    const gun = this.activeGun();
    if (!gun) return;
    const W = gun.def;
    const cam = this.camera;
    gun.ammo--;
    wpn.fireT = W.fireT;

    // spread
    const movePen = clamp(Math.hypot(this.player.vel.x, this.player.vel.z) * 0.0016, 0, 0.012);
    const airPen = this.player.grounded ? 0 : 0.014;
    let spread = W.spread + wpn.bloom + movePen + airPen;
    if (this.input.aimHeld) spread *= W.adsMul;
    this.spreadDeg = spread;

    this.player.muzzleWorld(this._v1);
    this.effects.muzzleFlash(this._v1, W.pellets > 1 ? 1.6 : 1.15, true);

    let anyHit = false, anyKill = false, anyHead = false, totalDmg = 0;
    let lastHitPos = null;

    for (let p = 0; p < W.pellets; p++) {
      this._dir.set((Math.random() - 0.5) * 2 * spread, (Math.random() - 0.5) * 2 * spread, -1)
        .normalize().applyQuaternion(cam.quaternion);
      this._origin.copy(cam.position);
      const res = this.raycastShot(this._origin.x, this._origin.y, this._origin.z, this._dir.x, this._dir.y, this._dir.z, W.range, this.player);

      const end = res ? this._v2.set(res.x, res.y, res.z) : this._v2.copy(this._origin).addScaledVector(this._dir, W.range);
      if (p === 0 || W.pellets <= 3 || p % 3 === 0) this.effects.tracer(this._v1, end, W.tracer);
      if (!res) continue;

      const hit = res.hit;
      if (hit.kind === "bot") {
        const isHead = res.y > hit.bot.pos.y + 1.42;
        let dmg = W.dmg * (isHead ? W.headMul : 1);
        // range falloff (shotguns fall off hard)
        const fall = W.pellets > 1 ? 0.35 : 0.55;
        const soft = W.range * fall;
        if (res.t > soft) dmg *= Math.max(0.35, 1 - (res.t - soft) / (W.range - soft + 1) * 0.75);
        dmg = Math.max(2, Math.round(dmg));
        const died = this.bots.damage(hit.bot, dmg, this.player, isHead);
        this.effects.impact({ x: res.x, y: res.y, z: res.z }, hit.bot.shield > 0 ? "shield" : "flesh");
        anyHit = true; totalDmg += dmg;
        anyKill = anyKill || died;
        anyHead = anyHead || isHead;
        lastHitPos = { x: res.x, y: res.y, z: res.z };
      } else if (hit.kind === "remote") {
        // Client-authoritative hit report: tell the peer how much they took.
        const isHead = res.y > hit.remote.pos.y + hit.remote.h * 0.78;
        let dmg = W.dmg * (isHead ? W.headMul : 1);
        const fall = W.pellets > 1 ? 0.35 : 0.55;
        const soft = W.range * fall;
        if (res.t > soft) dmg *= Math.max(0.35, 1 - (res.t - soft) / (W.range - soft + 1) * 0.75);
        dmg = Math.max(2, Math.round(dmg));
        if (this.net) this.net.send("hit", { dmg, x: res.x, y: res.y, z: res.z, head: isHead });
        hit.remote.hp = Math.max(0, hit.remote.hp - dmg);
        this.effects.impact({ x: res.x, y: res.y, z: res.z }, "flesh");
        anyHit = true; totalDmg += dmg;
        anyHead = anyHead || isHead;
        lastHitPos = { x: res.x, y: res.y, z: res.z };
      } else if (hit.kind === "build") {
        this.builds.damageCollider(hit.item, W.dmg, { x: res.x, y: res.y, z: res.z });
      } else if (hit.kind === "crate") {
        this._damageCrate(hit.item, W.dmg, { x: res.x, y: res.y, z: res.z });
      } else if (hit.kind === "chest") {
        this.openChest(hit.item.chest);
      } else if (hit.kind === "ground") {
        this.effects.impact({ x: res.x, y: res.y, z: res.z }, "stone");
      } else {
        this.effects.impact({ x: res.x, y: res.y, z: res.z }, hit.item && hit.item.tag === "tree" ? "wood" : "spark");
      }
    }

    // tell the peer we fired (tracer + sfx on their screen)
    if (this.net && this.duel) {
      const e2 = this._v2;
      this.net.send("shot", {
        mx: +this._v1.x.toFixed(2), my: +this._v1.y.toFixed(2), mz: +this._v1.z.toFixed(2),
        tx: +e2.x.toFixed(2), ty: +e2.y.toFixed(2), tz: +e2.z.toFixed(2), c: W.tracer,
      });
    }

    // feedback
    this.sound.shoot();
    this.player.recoil = Math.min(1.6, this.player.recoil + W.recoil);
    this.player.recoilPitch = Math.min(0.09, this.player.recoilPitch + W.kick);
    this.effects.shake(W.shake);
    wpn.bloom = Math.min(W.bloomMax, wpn.bloom + W.bloomAdd);

    if (anyHit && lastHitPos) {
      this.effects.dmgNumber({ x: lastHitPos.x, y: lastHitPos.y + 0.25, z: lastHitPos.z }, String(totalDmg), anyHead ? "#ffd166" : "#ffffff", anyHead || totalDmg > 40);
      this.hooks.event("hitmark", { kill: anyKill, head: anyHead });
      if (anyHead) this.sound.headshot(); else this.sound.hitMarker();
    }
  }

  // bot fires a shot along dir
  botShoot(bot, eye, dir, muzzle, primary = true) {
    const W = bot.wpn || WEAPONS.ar;
    const res = this.raycastShot(eye.x, eye.y, eye.z, dir.x, dir.y, dir.z, W.range, bot);
    const distP = this.distToPlayer(eye);
    // audiovisual only if near player
    if (distP < 95) {
      const end = res ? this._v3.set(res.x, res.y, res.z) : this._v3.copy(eye).addScaledVector(dir, W.range);
      this.effects.tracer(muzzle, end, W.tracer);
      if (primary && distP < 60) this.effects.muzzleFlash(muzzle, 0.85, false);
      if (primary) this.sound.enemyShoot(0, distP);
    } else if (primary) {
      this.effects.tracer(muzzle, res ? this._v3.set(res.x, res.y, res.z) : this._v3.copy(eye).addScaledVector(dir, 40), W.tracer);
    }
    // minimap ping
    if (primary && distP < 130) this.pings.push({ x: bot.pos.x, z: bot.pos.z, t: this.time });

    if (!res) return;
    const hit = res.hit;
    const eliteMul = bot.elite ? 1.25 : 1;
    if (hit.kind === "player") {
      const base = W.botDmg * rand(0.85, 1.15) * eliteMul;
      this._hurtPlayer(base * bot.diff.dmgMul, bot, false);
      this.effects.impact({ x: res.x, y: res.y, z: res.z }, this.player.shield > 0 ? "shield" : "flesh");
    } else if (hit.kind === "bot") {
      this.bots.damage(hit.bot, W.botDmg * rand(0.85, 1.15) * eliteMul, bot, res.y > hit.bot.pos.y + 1.42);
      this.effects.impact({ x: res.x, y: res.y, z: res.z }, hit.bot.shield > 0 ? "shield" : "flesh");
    } else if (hit.kind === "build") {
      this.builds.damageCollider(hit.item, W.dmg * 0.8, { x: res.x, y: res.y, z: res.z });
    } else if (hit.kind === "crate") {
      this._damageCrate(hit.item, W.dmg * 0.8, { x: res.x, y: res.y, z: res.z });
    }
  }

  _hurtPlayer(amount, attacker, isStorm) {
    if (!this.player.alive || this.state === "over") return;
    let remaining = amount;
    if (this.player.shield > 0) {
      const absorbed = Math.min(this.player.shield, remaining);
      this.player.shield -= absorbed;
      remaining -= absorbed;
      if (absorbed > 0) this.sound.shieldHit();
    }
    this.player.hp -= remaining;
    if (!isStorm) {
      this.effects.shake(clamp(0.14 + amount / 90, 0, 0.5));
      this.sound.damageTaken();
    }
    this.hooks.event("damaged", { amount, storm: isStorm, from: attacker ? attacker.name : null });
      if (this.player.hp <= 0) {
      this.player.hp = 0;
      this.player.alive = false;
      if (this.net && this.duel) this.net.send("died", {});
      this._endMatch(false, attacker);
    }
  }

  onBotDeath(bot, attacker, isHead) {
    this.effects.bloodBurst(bot.pos);
    const killerName = attacker === this.player ? "YOU" : (attacker && attacker.name) || "THE STORM";
    const isPlayerKill = attacker === this.player;
    if (isPlayerKill) {
      this.kills++;
      this.score += 150;
      if (bot.elite) this.score += 60;
      this.effects.dmgNumber({ x: bot.pos.x, y: bot.pos.y + 2.1, z: bot.pos.z }, bot.elite ? "+210" : "+150", "#3df5c4", true);
      // streaks
      if (this.time - this.streakT < 3.6) this.killStreak++; else this.killStreak = 1;
      this.streakT = this.time;
      this.sound.kill();
      this.effects.hitstop(0.09);
      this.effects.shake(0.22);
      if (this.killStreak >= 2) {
        this.sound.streak();
        this.hooks.event("streak", { name: STREAK_NAMES[Math.min(this.killStreak, STREAK_NAMES.length - 1)], count: this.killStreak });
      }
      this.hooks.event("youscored", { kills: this.kills });
      if (Math.random() < 0.3) this.dropPickup(bot.pos.x, bot.pos.y, bot.pos.z);
    } else if (attacker && attacker.name) {
      attacker.matchKills = (attacker.matchKills || 0) + 1;
    }
    this.hooks.event("killfeed", { killer: killerName, victim: bot.name, you: isPlayerKill, head: isHead, elite: bot.elite });

    const alive = this.bots.aliveCount();
    if (alive === 0 && this.player.alive) this._endMatch(true, null);
  }

  _endMatch(win, attacker) {
    if (this.state === "over") return;
    this.state = "over";
    this.input.enabled = false;
    this.input.releaseLock();
    const aliveBots = this.bots.aliveCount();
    this.placement = win ? 1 : aliveBots + 1;
    const placeBonus = Math.max(0, (this.totalPlayers - this.placement) * 15);
    const winBonus = win ? 500 : 0;
    this.score += placeBonus + winBonus;
    this.sound.setStorm(0);
    if (win) { this.sound.win(); this.effects.shake(0.3); } else this.sound.lose();
    this._result = {
      win,
      placement: this.placement,
      total: this.totalPlayers,
      kills: this.kills,
      score: this.score,
      placeBonus, winBonus,
      time: this.matchTime,
      diffKey: this.diffKey,
      diffLabel: this.diff.label,
      killedBy: attacker ? attacker.name : (this.inStorm ? "THE STORM" : null),
    };
    this._clearNameTags();
    this.hooks.event(win ? "victory" : "defeat", this._result);
    this.hooks.over(this._result);
  }

  // ============================ name tags ============================
  _clearNameTags() {
    for (const t of this._nameTagPool) t.el.style.display = "none";
  }

  _updateNameTags() {
    let i = 0;
    const w = window.innerWidth, h = window.innerHeight;
    const cap = Math.min(this.maxTagCount ?? 10, this._nameTagPool.length);
    for (const b of this.bots.bots) {
      if (i >= cap) break;
      if (!b.alive) continue;
      const d = this.distToPlayer(b.pos);
      if (d > 70 || d < 3) continue;
      // don't show tags through walls/terrain
      const e = this.camera.position;
      if (losBlocked(e.x, e.y, e.z, b.pos.x, b.pos.y + 1.5, b.pos.z, this.ctx)) continue;
      this._v1.set(b.pos.x, b.pos.y + 2.15, b.pos.z).project(this.camera);
      if (this._v1.z > 1 || this._v1.z < -1) continue;
      const x = (this._v1.x * 0.5 + 0.5) * w;
      const y = (-this._v1.y * 0.5 + 0.5) * h;
      if (x < 0 || x > w || y < 0 || y > h) continue;
      const tag = this._nameTagPool[i++];
      tag.el.style.display = "block";
      tag.el.style.left = x + "px";
      tag.el.style.top = y + "px";
      tag.el.style.opacity = String(clamp(1.3 - d / 70, 0.25, 1));
      tag.nameEl.textContent = b.name + (b.elite ? " ★" : "");
      const frac = clamp((b.hp + b.shield * 0.6) / 130, 0, 1);
      tag.hpEl.style.width = (frac * 100).toFixed(0) + "%";
      tag.hpEl.style.background = b.elite ? "#ff9a3d" : frac > 0.4 ? "#3df5c4" : "#ff5f6d";
    }
    for (; i < this._nameTagPool.length; i++) this._nameTagPool[i].el.style.display = "none";
  }

  // ============================ per-frame tick ============================
  _tick(now) {
    let dt = Math.min(0.05, (now - this._last) / 1000);
    this._last = now;
    // hitstop slow-mo
    if (this.effects.hitstopT > 0) dt *= 0.22;

    const st = this.state;
    if (st === "menu") {
      this.time += dt;
      this.world.update(dt, this.time);
      this.effects.update(dt, this.camera);
      this.menuAngle += dt * 0.045;
      const r = 200;
      this.camera.position.set(Math.cos(this.menuAngle) * r, 84 + Math.sin(this.time * 0.1) * 8, Math.sin(this.menuAngle) * r);
      this.camera.lookAt(0, 6, 0);
      if (this.camera.fov !== 62) { this.camera.fov = 62; this.camera.updateProjectionMatrix(); }
    } else if (st === "countdown" || st === "live") {
      this.time += dt;
      this.matchTime += dt;
      if (st === "countdown") {
        this.countdownT -= dt;
        const step = this.countdownT > 1.5 ? 3 : this.countdownT > 1.0 ? 2 : this.countdownT > 0.5 ? 1 : 0;
        if (step !== this._cdStep) {
          this._cdStep = step;
          if (step > 0) { this.sound.countTick(); this.hooks.event("count", { n: step }); }
          else { this.sound.countGo(); this.hooks.event("count", { n: 0 }); }
        }
        if (this.countdownT <= 0) this.state = "live";
      }

      // --- touch buttons set the mode directly (tap same build mode = back to gun) ---
      const mreq = this.input.consumeMode();
      if (mreq >= 0) {
        const next = mreq === this.weapon.mode && mreq !== 0 ? 0 : mreq;
        if (next !== this.weapon.mode) {
          this.weapon.mode = next;
          if (next > 0) this._lastPiece = next;
          this.sound.uiClick();
          this.hooks.event("mode", { mode: next });
        }
      }
      // --- Q toggles build mode on/off (keyboard) ---
      if (this.input.consumeBuildToggle()) {
        this.weapon.mode = this.weapon.mode > 0 ? 0 : (this._lastPiece || 1);
        this.sound.uiClick();
        this.hooks.event("mode", { mode: this.weapon.mode });
      }
      // --- digits are contextual: build pieces inside build mode, weapon slots outside ---
      const dg = this.input.consumeDigit();
      if (dg > 0) {
        if (this.weapon.mode > 0) {
          if (dg <= 3 && this.weapon.mode !== dg) {
            this.weapon.mode = dg;
            this._lastPiece = dg;
            this.sound.uiClick();
            this.hooks.event("mode", { mode: dg });
          }
        } else if (dg <= 2) {
          this.setSlot(dg - 1);
        }
      }
      // --- wheel/X: cycle pieces in build mode, swap guns otherwise ---
      if (this.input.consumeSwap()) {
        if (this.weapon.mode > 0) {
          this.weapon.mode = (this.weapon.mode % 3) + 1;
          this._lastPiece = this.weapon.mode;
          this.sound.uiClick();
        } else {
          this.swapSlot();
        }
      }
      if (this.input.consumePause()) { this.pause(); }
      if (this.input.consumeReload()) this._tryReload();

      // player
      this.player.update(dt, false);

      // weapon
      this._updateWeapon(dt);

      // bots
      this.bots.update(dt);

      // networked opponent
      if (this.duel && this.remote) {
        this.remote.update(dt, performance.now());
        this._netSend(dt);
      }

      // storm
      this._updateStorm(dt);

      // world ambience
      this.world.update(dt, this.time);

      // pickups + weapons/chests
      this._updatePickups(dt);
      this._updateLoot(dt);

      // builds ghost & anims
      this._updateBuildMode(dt);
      this.builds.update(dt);

      // camera shake
      if (this.effects.trauma > 0) {
        this.effects.shakeOffset(this.time * 60, this._camShake);
        this.camera.rotation.y += this._camShake.yaw;
        this.camera.rotation.x += this._camShake.pitch;
        this.camera.rotation.z += this._camShake.roll;
      }

      // shadow camera follows player
      const sun = this.world.sun;
      sun.position.set(this.player.pos.x + 120, 210, this.player.pos.z + 90);
      sun.target.position.set(this.player.pos.x, 0, this.player.pos.z);
      sun.target.updateMatrixWorld();

      // name tags @12Hz
      this._tagT -= dt;
      if (this._tagT <= 0) { this._tagT = 0.083; this._updateNameTags(); }

      // blob shadows
      this.effects.beginBlobs();
      if (this.player.alive) this.effects.addBlob(this.player.pos.x, this.player.groundH ?? this.player.pos.y, this.player.pos.z, 1, this.player.pos.y - this.player.groundH);
      for (const b of this.bots.bots) if (b.alive) this.effects.addBlob(b.pos.x, b.groundH ?? b.pos.y, b.pos.z, 1, b.pos.y - b.groundH);
      this.effects.endBlobs();

      this.effects.update(dt, this.camera);

      // pings cleanup
      if (this.pings.length) {
        for (let i = this.pings.length - 1; i >= 0; i--) if (this.time - this.pings[i].t > 2.5) this.pings.splice(i, 1);
      }

      // HUD push
      this.hooks.hud(this._hudData());
    } else if (st === "paused" || st === "over") {
      // gentle idle rendering; keep world alive behind overlays
      this.time += dt * 0.0; // freeze timers
      this.effects.update(dt, this.camera);
      if (st === "over") this.world.update(dt, performance.now() / 1000);
      if (this.input.consumePause()) this.resume();
    }

    this.renderer.render(this.scene, this.camera);
  }

  _tryReload() {
    const gun = this.activeGun();
    if (!gun || gun.reloading || gun.ammo >= gun.def.mag) return;
    gun.reloading = true;
    gun.reloadT = gun.def.reload;
    this.sound.reload();
    this.hooks.event("reload", {});
  }

  _updateWeapon(dt) {
    const wpn = this.weapon;
    const gun = this.activeGun();
    const frozen = this.state !== "live";
    wpn.bloom = Math.max(0, wpn.bloom - dt * 0.05);

    if (gun && gun.reloading) {
      gun.reloadT -= dt;
      if (gun.reloadT <= 0) { gun.reloading = false; gun.ammo = gun.def.mag; }
    }

    if (wpn.mode !== 0) { this._fireHeldLast = false; return; } // build modes handled elsewhere
    if (frozen || !gun) return;

    wpn.fireT -= dt;
    const held = this.input.isFireHeld() && this.player.alive;
    // semi-auto weapons require a fresh trigger pull
    const wantFire = gun.def.auto ? held : (held && !this._fireHeldLast);
    if (wantFire && wpn.fireT <= 0) {
      if (gun.reloading) { this._fireHeldLast = held; return; }
      if (gun.ammo <= 0) {
        if (!this._fireHeldLast) this.sound.dryFire();
        this._tryReload();
      } else {
        this.firePlayerShot();
      }
    }
    this._fireHeldLast = held;
  }

  // Fortnite-style tile editing.
  // G enters edit on the aimed piece; hold LMB and sweep the crosshair over
  // tiles to mark them; RELEASE applies the change. G again cancels.
  _handleEdit(cam, dir) {
    const ed = this.edit;
    // ---- already editing ----
    if (ed && ed.piece && ed.piece.alive) {
      const idx = this.builds.pickTile(ed.piece, cam.x, cam.y, cam.z, dir.x, dir.y, dir.z, 14);
      ed.hover = idx;
      const held = this.input.isFireHeld();

      if (held && !ed.painting && idx >= 0) {
        // first tile decides whether this stroke cuts or restores
        ed.painting = true;
        ed.paintVal = !ed.working[idx];
        ed.working[idx] = ed.paintVal;
        ed.touched = true;
        this.sound.uiClick();
      } else if (held && ed.painting && idx >= 0 && ed.working[idx] !== ed.paintVal) {
        ed.working[idx] = ed.paintVal;
        ed.touched = true;
        this.sound.uiClick();
      } else if (!held && ed.painting) {
        // RELEASE -> commit
        ed.painting = false;
        const stolen = ed.piece.owner !== this.player;
        const target = ed.piece;
        if (this.builds.applyTiles(target, ed.working)) {
          if (target.alive) { target.owner = this.player; this.netEdit(target); }
          else if (this.net && this.duel) {
            this.net.send("destroy", {
              ty: target.type, ix: target.ix, iz: target.iz, L: target.L,
              o: target.orient || 0, y: target.type === "ramp" ? Math.round(target.yaw / (Math.PI / 2)) : 0,
            });
          }
          this.effects.shake(0.04);
          this.hooks.event("edit", { type: target.type, stolen, applied: true });
        }
        this.builds.hideEditGrid();
        this.edit = null;
        this.weapon.placeT = 0.25; // don't instantly place a piece on release
        return true;
      }

      if (this.input.consumeEdit()) { // cancel
        this.builds.hideEditGrid();
        this.edit = null;
        this.sound.uiClick();
        this.weapon.placeT = 0.25;
        return true;
      }
      this.builds.showEditGrid(ed.piece, ed.working, ed.hover);
      this.builds.updateGhost(null);
      return true;
    }

    // ---- not editing: offer to start ----
    if (this.edit) { this.builds.hideEditGrid(); this.edit = null; }
    if (this.editTarget && this.input.consumeEdit()) {
      this.edit = {
        piece: this.editTarget,
        working: this.editTarget.tiles.slice(),
        hover: -1, painting: false, paintVal: false, touched: false,
      };
      this.sound.uiClick();
      this.builds.updateGhost(null);
      return true;
    }
    return false;
  }

  _updateBuildMode(dt) {
    const wpn = this.weapon;
    if (wpn.mode === 0 || !this.player.alive || this.state !== "live") {
      this.builds.updateGhost(null);
      if (this.edit) { this.builds.hideEditGrid(); this.edit = null; }
      this.editTarget = null;
      return;
    }
    // Aim point = where you're LOOKING (surface hit, or max build range).
    const REACH = 9;
    const cam = this.camera.position;
    this._dir.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const res = this.raycastShot(cam.x, cam.y, cam.z, this._dir.x, this._dir.y, this._dir.z, REACH, this.player);
    // pull back slightly off the hit surface so we resolve the cell in front of it
    const d = res ? Math.max(0.8, res.t - 0.12) : REACH * 0.55;
    const aim = this._aimPt || (this._aimPt = new THREE.Vector3());
    aim.set(cam.x + this._dir.x * d, cam.y + this._dir.y * d, cam.z + this._dir.z * d);

    // --- EDIT: Fortnite-style tile grid (hover/drag tiles, release to apply) ---
    this.editTarget = null;
    if (res && res.hit.kind === "build" && res.hit.item.piece) {
      this.editTarget = res.hit.item.piece; // ANY build, including enemy ones
    }
    if (this._handleEdit(cam, this._dir)) return;
    this.input.consumeEdit();

    const type = wpn.mode === 1 ? "wall" : wpn.mode === 2 ? "floor" : "ramp";
    const spec = this.builds.specFor(type, aim, cam, this._dir, this.player.pos.y);
    const tr = spec ? this.builds.transformOf(spec) : null;
    // build range + never build inside yourself (keeps the camera out of geometry)
    const distOk = tr && Math.hypot(tr.x - this.player.pos.x, tr.z - this.player.pos.z) < 10;
    const selfClip = spec && this.builds.overlapsEntity(spec, this.player.pos, this.player.r + 0.12, this.player.h);
    const valid = !!(spec && distOk && !selfClip && this.builds.canPlace(spec));
    this.builds.updateGhost(type, valid, spec);

    wpn.placeT -= dt;
    if (this.input.isFireHeld() && wpn.placeT <= 0 && valid) {
      wpn.placeT = 0.17;
      const placed = this.builds.place(spec, this.player);
      if (placed) this.netBuild(placed);
      this.effects.shake(0.03);
    }
  }

  _hudData() {
    const s = this.storm;
    const wpn = this.weapon;
    const gun = this.activeGun();
    const data = this._hd || (this._hd = {});
    data.hp = this.player.hp;
    data.shield = this.player.shield;
    data.ammo = gun ? gun.ammo : 0;
    data.magSize = gun ? gun.def.mag : 0;
    data.reloading = gun ? gun.reloading : false;
    data.reloadPct = gun && gun.reloading ? 1 - gun.reloadT / gun.def.reload : 0;
    data.gunName = gun ? gun.def.short : "—";
    data.gunRarity = gun ? RARITY[gun.def.rarity].css : "#b8c0cc";
    data.slot = this.slot;
    data.slot0 = this.loadout[0] ? { name: this.loadout[0].def.short, css: RARITY[this.loadout[0].def.rarity].css, ammo: this.loadout[0].ammo } : null;
    data.slot1 = this.loadout[1] ? { name: this.loadout[1].def.short, css: RARITY[this.loadout[1].def.rarity].css, ammo: this.loadout[1].ammo } : null;
    data.sliding = this.player.sliding;
    data.speed = Math.hypot(this.player.vel.x, this.player.vel.z);
    // interaction prompt
    if (this.edit && this.edit.piece && this.edit.piece.alive) {
      let cut = 0;
      for (const b of this.edit.working) if (!b) cut++;
      data.prompt = {
        kind: "editing",
        label: "DRAG TO CUT TILES",
        sub: cut > 0 ? `${cut} REMOVED · RELEASE TO APPLY` : "RELEASE TO APPLY · G CANCELS",
        css: "#ff5d5d",
      };
    } else if (this.editTarget) {
      const stolen = this.editTarget.owner !== this.player;
      data.prompt = {
        kind: "edit",
        label: (stolen ? "STEAL & EDIT " : "EDIT ") + this.editTarget.type.toUpperCase(),
        sub: TILE_N[this.editTarget.type] + "-TILE GRID",
        css: stolen ? "#b464ff" : "#ffd166",
      };
    }
    else if (this.nearChest) data.prompt = { kind: "chest", label: "OPEN CHEST", css: "#ffd166" };
    else if (this.nearItem) {
      const d = this.nearItem.def;
      data.prompt = { kind: "gun", label: d.name, sub: RARITY[d.rarity].name, css: RARITY[d.rarity].css, swap: !this.loadout.includes(null) };
    } else data.prompt = null;
    data.kills = this.kills;
    data.alive = this.bots.aliveCount() + (this.player.alive ? 1 : 0);
    data.score = this.score;
    data.stormState = s.state;
    data.stormT = Math.max(0, Math.ceil(s.t));
    data.stormDmg = s.dmg;
    data.stormPhase = s.phase;
    data.inStorm = this.inStorm;
    data.mode = wpn.mode;
    data.spread = this.spreadDeg || 0.011;
    data.aiming = this.input.aimHeld;
    data.matchTime = this.matchTime;
    data.sprinting = this.player.sprinting;
    // map
    data.px = this.player.pos.x; data.pz = this.player.pos.z; data.pyaw = this.player.yaw;
    data.zx = s.x; data.zz = s.z; data.zr = s.r;
    data.nzx = s.nextX; data.nzz = s.nextZ; data.nzr = s.nextR;
    data.pings = this.pings;
    data.pstorm = s.state === "shrink";
    data.state = this.state;
    return data;
  }

  dispose() {
    this._running = false;
    cancelAnimationFrame(this._raf);
    window.removeEventListener("resize", this._onResize);
    document.removeEventListener("visibilitychange", this._onVis);
    this.input.detach();
    this.bots.reset();
    this.world.dispose();
    this.builds.dispose();
    this.renderer.dispose();
    if (this.canvas.parentElement === this.container) this.container.removeChild(this.canvas);
  }
}

// scratch for raycast queries
const _qHit = [];
const _hashes = [null, null];
Game._shotStamp = 1;
