// ============================================================
// effects.js — particles, tracers, flashes, shake, dmg numbers
// ============================================================
import * as THREE from "three";
import { clamp } from "./utils.js";

const MAX_PARTICLES = 2600;
const MAX_TRACERS = 26;
const MAX_BLOBS = 80;

function makeSoftCircleTexture(inner = "#ffffff") {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
  g.addColorStop(0, inner);
  g.addColorStop(0.4, inner);
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  return tex;
}

export class Effects {
  constructor(scene, hudContainer) {
    this.scene = scene;
    this.hud = hudContainer;
    this.trauma = 0;
    this.timeScale = 1;
    this.hitstopT = 0;
    this.particleBudget = 1;

    // ---- particles ----
    this.pCount = MAX_PARTICLES;
    this.pPos = new Float32Array(this.pCount * 3);
    this.pVel = new Float32Array(this.pCount * 3);
    this.pCol = new Float32Array(this.pCount * 3);
    this.pSize = new Float32Array(this.pCount);
    this.pLife = new Float32Array(this.pCount);
    this.pMaxLife = new Float32Array(this.pCount);
    this.pGrav = new Float32Array(this.pCount);
    this.pDrag = new Float32Array(this.pCount);
    this.pAlpha = new Float32Array(this.pCount);
    this.pCursor = 0;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.pPos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("aColor", new THREE.BufferAttribute(this.pCol, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("aSize", new THREE.BufferAttribute(this.pSize, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("aAlpha", new THREE.BufferAttribute(this.pAlpha, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { map: { value: makeSoftCircleTexture() } },
      vertexShader: `
        attribute vec3 aColor; attribute float aSize; attribute float aAlpha;
        varying vec3 vColor; varying float vAlpha;
        void main(){
          vColor = aColor; vAlpha = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * (240.0 / max(1.0, -mv.z));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform sampler2D map;
        varying vec3 vColor; varying float vAlpha;
        void main(){
          vec4 t = texture2D(map, gl_PointCoord);
          gl_FragColor = vec4(vColor, t.a * vAlpha);
        }`,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
    this.pGeo = geo;

    // ---- tracers ----
    this.tracers = [];
    const tGeo = new THREE.BoxGeometry(0.055, 0.055, 1);
    for (let i = 0; i < MAX_TRACERS; i++) {
      const m = new THREE.Mesh(tGeo, new THREE.MeshBasicMaterial({ color: 0xffe9a8, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
      m.visible = false;
      scene.add(m);
      this.tracers.push({ mesh: m, life: 0, maxLife: 0.09 });
    }

    // ---- muzzle flashes ----
    this.flashes = [];
    const flashTex = makeSoftCircleTexture("#ffd9a0");
    for (let i = 0; i < 10; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: flashTex, color: 0xffc46b, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
      s.visible = false;
      scene.add(s);
      this.flashes.push({ sprite: s, life: 0 });
    }

    // dynamic light for player muzzle (one, reused)
    this.muzzleLight = new THREE.PointLight(0xffb35c, 0, 9, 1.8);
    scene.add(this.muzzleLight);
    this.muzzleLightT = 0;

    // ---- blob shadows ----
    const blobGeo = new THREE.CircleGeometry(0.85, 12);
    blobGeo.rotateX(-Math.PI / 2);
    const blobMat = new THREE.MeshBasicMaterial({ color: 0x0a1a12, transparent: true, opacity: 0.32, depthWrite: false });
    this.blobs = new THREE.InstancedMesh(blobGeo, blobMat, MAX_BLOBS);
    this.blobs.frustumCulled = false;
    this.blobs.renderOrder = 1;
    scene.add(this.blobs);
    this._blobIndex = 0;
    this._blobObj = new THREE.Object3D();

    // ---- damage numbers (DOM pool) ----
    this.dmgPool = [];
    if (hudContainer) {
      for (let i = 0; i < 14; i++) {
        const el = document.createElement("div");
        el.className = "dmg-num";
        el.style.display = "none";
        hudContainer.appendChild(el);
        this.dmgPool.push({ el, life: 0 });
      }
    }
  }

  // =============== particles ===============
  spawn(x, y, z, { count = 10, color = 0xffffff, color2 = null, speed = 4, up = 2, size = 1.6, life = 0.6, gravity = -9, drag = 2, spread = 1 } = {}) {
    count = Math.max(1, Math.round(count * this.particleBudget));
    const c1 = _c1.setHex(color);
    const c2 = color2 !== null ? _c2.setHex(color2) : c1;
    for (let i = 0; i < count; i++) {
      const idx = this.pCursor;
      this.pCursor = (this.pCursor + 1) % this.pCount;
      const i3 = idx * 3;
      this.pPos[i3] = x + (Math.random() - 0.5) * spread * 0.3;
      this.pPos[i3 + 1] = y + (Math.random() - 0.5) * spread * 0.3;
      this.pPos[i3 + 2] = z + (Math.random() - 0.5) * spread * 0.3;
      const a = Math.random() * Math.PI * 2;
      const el = (Math.random() - 0.35) * Math.PI;
      const sp = speed * (0.4 + Math.random() * 0.9);
      this.pVel[i3] = Math.cos(a) * Math.cos(el) * sp;
      this.pVel[i3 + 1] = Math.sin(el) * sp + up;
      this.pVel[i3 + 2] = Math.sin(a) * Math.cos(el) * sp;
      const mixT = Math.random();
      this.pCol[i3] = c1.r + (c2.r - c1.r) * mixT;
      this.pCol[i3 + 1] = c1.g + (c2.g - c1.g) * mixT;
      this.pCol[i3 + 2] = c1.b + (c2.b - c1.b) * mixT;
      this.pSize[idx] = size * (0.6 + Math.random() * 0.8);
      this.pMaxLife[idx] = this.pLife[idx] = life * (0.5 + Math.random() * 0.9);
      this.pGrav[idx] = gravity;
      this.pDrag[idx] = drag;
      this.pAlpha[idx] = 1;
    }
  }

  impact(p, kind) {
    if (kind === "flesh") this.spawn(p.x, p.y, p.z, { count: 12, color: 0xff5d5d, color2: 0xffb0a0, speed: 5, size: 1.4, life: 0.5, gravity: -12 });
    else if (kind === "shield") this.spawn(p.x, p.y, p.z, { count: 10, color: 0x6bd8ff, color2: 0xd6f4ff, speed: 6, size: 1.3, life: 0.4, gravity: -4 });
    else if (kind === "wood") this.spawn(p.x, p.y, p.z, { count: 9, color: 0xd9a066, color2: 0x9c6b3e, speed: 4, size: 1.5, life: 0.55, gravity: -14 });
    else if (kind === "stone") this.spawn(p.x, p.y, p.z, { count: 8, color: 0xcfd4da, color2: 0x8d939b, speed: 4.5, size: 1.4, life: 0.5, gravity: -14 });
    else this.spawn(p.x, p.y, p.z, { count: 8, color: 0xfff2b8, color2: 0xffb36b, speed: 5, size: 1.1, life: 0.35, gravity: -8 });
  }

  bloodBurst(p) {
    this.spawn(p.x, p.y + 0.8, p.z, { count: 34, color: 0xff4d4d, color2: 0xffc1a8, speed: 7, up: 3.5, size: 2, life: 0.8, gravity: -13 });
    this.spawn(p.x, p.y + 0.4, p.z, { count: 18, color: 0xffffff, speed: 3, size: 2.6, life: 0.45, gravity: 2, drag: 3 });
  }

  buildPuff(p, colorHex = 0xd9b791) {
    this.spawn(p.x, p.y, p.z, { count: 14, color: colorHex, color2: 0xffffff, speed: 3.5, up: 1.5, size: 2.2, life: 0.5, gravity: -5, drag: 4 });
  }

  footPuff(x, y, z) {
    this.spawn(x, y + 0.06, z, { count: 3, color: 0xd8cfae, speed: 1.2, up: 0.6, size: 1.1, life: 0.4, gravity: -2, drag: 3 });
  }

  landPuff(x, y, z, big = false) {
    this.spawn(x, y + 0.05, z, { count: big ? 16 : 8, color: 0xd8cfae, speed: big ? 4 : 2, up: 0.7, size: 1.6, life: 0.45, gravity: -3, drag: 3.5 });
  }

  stormTick(p) {
    this.spawn(p.x, p.y + 1, p.z, { count: 5, color: 0xb36bff, color2: 0xe0c3ff, speed: 2, up: 3, size: 1.4, life: 0.6, gravity: 4 });
  }

  pickupBurst(p, colorHex) {
    this.spawn(p.x, p.y, p.z, { count: 14, color: colorHex, color2: 0xffffff, speed: 3, up: 2.5, size: 1.4, life: 0.6, gravity: 1, drag: 3 });
  }

  // =============== tracers & flashes ===============
  tracer(from, to, colorHex = 0xffe9a8) {
    let best = null;
    for (const t of this.tracers) if (t.life <= 0) { best = t; break; }
    if (!best) return;
    const m = best.mesh;
    m.visible = true;
    m.material.color.setHex(colorHex);
    m.material.opacity = 0.85;
    m.position.copy(from).add(to).multiplyScalar(0.5);
    m.lookAt(to.x, to.y, to.z);
    m.scale.set(1, 1, from.distanceTo(to));
    best.life = best.maxLife;
  }

  muzzleFlash(pos, scale = 1, isPlayer = false) {
    let best = null;
    for (const f of this.flashes) if (f.life <= 0) { best = f; break; }
    if (!best) return;
    best.sprite.visible = true;
    best.sprite.position.copy(pos);
    best.sprite.scale.setScalar(0.7 * scale);
    best.sprite.material.opacity = 0.95;
    best.sprite.material.rotation = Math.random() * Math.PI * 2;
    best.life = 0.055;
    if (isPlayer) {
      this.muzzleLight.position.copy(pos);
      this.muzzleLight.intensity = 6;
      this.muzzleLightT = 0.05;
    }
  }

  // =============== shake & hitstop ===============
  shake(amount) { this.trauma = clamp(this.trauma + amount, 0, 1); }
  hitstop(duration = 0.08) { this.hitstopT = Math.max(this.hitstopT, duration); }

  // =============== damage numbers ===============
  dmgNumber(worldPos, text, color = "#ffe08a", big = false) {
    let best = this.dmgPool.find((d) => d.life <= 0);
    if (!best) return;
    _v1.copy(worldPos).project(this.camera);
    if (_v1.z > 1) return;
    const x = (_v1.x * 0.5 + 0.5) * window.innerWidth;
    const y = (-_v1.y * 0.5 + 0.5) * window.innerHeight;
    best.el.style.display = "block";
    best.el.style.left = x + "px";
    best.el.style.top = y + "px";
    best.el.style.color = color;
    best.el.style.fontSize = big ? "26px" : "17px";
    best.el.textContent = text;
    // restart CSS animation
    best.el.style.animation = "none";
    void best.el.offsetHeight;
    best.el.style.animation = "";
    best.life = 0.75;
  }

  // =============== blobs ===============
  beginBlobs() { this._blobIndex = 0; }
  addBlob(x, y, z, scale = 1, heightAbove = 0) {
    if (this._blobIndex >= MAX_BLOBS) return;
    const o = this._blobObj;
    const fade = clamp(1 - heightAbove / 8, 0.25, 1);
    o.position.set(x, y + 0.03, z);
    o.scale.setScalar(scale * fade);
    o.rotation.set(0, 0, 0);
    o.updateMatrix();
    this.blobs.setMatrixAt(this._blobIndex++, o.matrix);
  }
  endBlobs() {
    const o = this._blobObj;
    o.position.set(0, -999, 0);
    o.scale.setScalar(0.001);
    o.updateMatrix();
    for (let i = this._blobIndex; i < MAX_BLOBS; i++) this.blobs.setMatrixAt(i, o.matrix);
    this.blobs.instanceMatrix.needsUpdate = true;
  }

  // =============== frame update ===============
  update(dt, camera) {
    this.camera = camera;
    // trauma decay
    this.trauma = Math.max(0, this.trauma - dt * 1.6);
    if (this.hitstopT > 0) this.hitstopT -= dt;

    // particles
    const n = this.pCount;
    for (let i = 0; i < n; i++) {
      if (this.pLife[i] <= 0) continue;
      this.pLife[i] -= dt;
      const i3 = i * 3;
      if (this.pLife[i] <= 0) { this.pAlpha[i] = 0; this.pPos[i3 + 1] = -999; continue; }
      const dragF = 1 / (1 + this.pDrag[i] * dt);
      this.pVel[i3] *= dragF;
      this.pVel[i3 + 1] = this.pVel[i3 + 1] * dragF + this.pGrav[i] * dt;
      this.pVel[i3 + 2] *= dragF;
      this.pPos[i3] += this.pVel[i3] * dt;
      this.pPos[i3 + 1] += this.pVel[i3 + 1] * dt;
      this.pPos[i3 + 2] += this.pVel[i3 + 2] * dt;
      const t = this.pLife[i] / this.pMaxLife[i];
      this.pAlpha[i] = t < 0.45 ? t / 0.45 : 1;
    }
    this.pGeo.attributes.position.needsUpdate = true;
    this.pGeo.attributes.aAlpha.needsUpdate = true;
    this.pGeo.attributes.aColor.needsUpdate = true;
    this.pGeo.attributes.aSize.needsUpdate = true;

    // tracers
    for (const t of this.tracers) {
      if (t.life > 0) {
        t.life -= dt;
        t.mesh.material.opacity = Math.max(0, (t.life / t.maxLife)) * 0.85;
        if (t.life <= 0) t.mesh.visible = false;
      }
    }
    // flashes
    for (const f of this.flashes) {
      if (f.life > 0) {
        f.life -= dt;
        f.sprite.material.opacity = Math.max(0, f.life / 0.055) * 0.95;
        if (f.life <= 0) f.sprite.visible = false;
      }
    }
    if (this.muzzleLightT > 0) {
      this.muzzleLightT -= dt;
      if (this.muzzleLightT <= 0) this.muzzleLight.intensity = 0;
    }
    // damage numbers lifetime
    for (const d of this.dmgPool) {
      if (d.life > 0) {
        d.life -= dt;
        if (d.life <= 0) d.el.style.display = "none";
      }
    }
  }

  shakeOffset(t, out) {
    const s = this.trauma * this.trauma;
    out.yaw = s * 0.05 * (Math.sin(t * 91.7) + Math.sin(t * 47.3) * 0.6);
    out.pitch = s * 0.05 * (Math.cos(t * 83.1) + Math.sin(t * 59.7) * 0.6);
    out.roll = s * 0.04 * Math.sin(t * 71.3);
    return out;
  }

  clearAll() {
    for (let i = 0; i < this.pCount; i++) { this.pLife[i] = 0; this.pAlpha[i] = 0; this.pPos[i * 3 + 1] = -999; }
    for (const t of this.tracers) { t.life = 0; t.mesh.visible = false; }
    for (const f of this.flashes) { f.life = 0; f.sprite.visible = false; }
    for (const d of this.dmgPool) { d.life = 0; d.el.style.display = "none"; }
    this.trauma = 0;
  }
}

const _c1 = new THREE.Color();
const _c2 = new THREE.Color();
const _v1 = new THREE.Vector3();
