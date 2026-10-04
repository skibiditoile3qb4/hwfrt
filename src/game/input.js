// ============================================================
// input.js — keyboard/mouse/pointer-lock + shared touch state
// ============================================================

export class Input {
  constructor() {
    this.keys = new Set();
    this.lookDX = 0;
    this.lookDY = 0;
    this.fireHeld = false;
    this.firePressed = false; // edge
    this.aimHeld = false;
    this.jumpHeld = false;
    this.jumpPressed = false;
    this.modeRequest = -1; // direct mode set (touch buttons): 0=gun 1=wall 2=floor 3=ramp
    this.buildTogglePressed = false; // Q
    this.digitRequest = 0; // 1..3, contextual
    this.interactPressed = false;
    this.swapPressed = false;
    this.slidePressed = false;
    this.slideHeld = false;
    this.editPressed = false;
    this.reloadPressed = false;
    this.pausePressed = false;
    this.enabled = false; // gameplay input active
    this.pointerLocked = false;
    this.wantLockEl = null;
    this.onLockChange = null;

    // Touch state — written by the React TouchControls layer
    this.touch = {
      active: false,
      mx: 0, mz: 0,       // move vector -1..1
      sprint: false,
      lookDX: 0, lookDY: 0,
      fire: false,
      jump: false,
      jumpPressed: false,
      slidePressed: false,
      slideHeld: false,
      editPressed: false,
    };

    this._onKeyDown = (e) => {
      if (e.code === "KeyP" && !e.repeat) this.pausePressed = true; // always allow pause toggle
      if (!this.enabled) return;
      const c = e.code;
      if (["Space", "KeyW", "KeyA", "KeyS", "KeyD", "Tab"].includes(c)) e.preventDefault();
      if (e.repeat) return;
      this.keys.add(c);
      if (c === "Space") { this.jumpHeld = true; this.jumpPressed = true; }
      // Q toggles build mode; digits are contextual (weapons outside, pieces inside)
      if (c === "KeyQ") this.buildTogglePressed = true;
      if (c === "Digit1") this.digitRequest = 1;
      if (c === "Digit2") this.digitRequest = 2;
      if (c === "Digit3") this.digitRequest = 3;
      if (c === "KeyR") this.reloadPressed = true;
      if (c === "KeyF" || c === "KeyE") this.interactPressed = true;
      if (c === "KeyX") this.swapPressed = true;
      if (c === "KeyC") { this.slidePressed = true; this.slideHeld = true; }
      if (c === "KeyG") this.editPressed = true;
    };
    this._onKeyUp = (e) => {
      this.keys.delete(e.code);
      if (e.code === "Space") this.jumpHeld = false;
      if (e.code === "KeyC") this.slideHeld = false;
    };
    this._onMouseMove = (e) => {
      if (!this.enabled || !this.pointerLocked) return;
      this.lookDX += e.movementX || 0;
      this.lookDY += e.movementY || 0;
    };
    this._onMouseDown = (e) => {
      if (!this.enabled) return;
      if (e.button === 0) { this.fireHeld = true; this.firePressed = true; }
      if (e.button === 2) this.aimHeld = true;
    };
    this._onMouseUp = (e) => {
      if (e.button === 0) this.fireHeld = false;
      if (e.button === 2) this.aimHeld = false;
    };
    this._onContextMenu = (e) => { e.preventDefault(); };
    this._onWheel = (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      this.swapPressed = true;
    };
    this._onLockChange = () => {
      this.pointerLocked = document.pointerLockElement === this.wantLockEl;
      if (this.onLockChange) this.onLockChange(this.pointerLocked);
    };
  }

  attach(lockEl) {
    this.wantLockEl = lockEl;
    window.addEventListener("keydown", this._onKeyDown);
    window.addEventListener("keyup", this._onKeyUp);
    window.addEventListener("mousemove", this._onMouseMove);
    window.addEventListener("mousedown", this._onMouseDown);
    window.addEventListener("mouseup", this._onMouseUp);
    window.addEventListener("contextmenu", this._onContextMenu);
    window.addEventListener("wheel", this._onWheel, { passive: false });
    document.addEventListener("pointerlockchange", this._onLockChange);
  }

  detach() {
    window.removeEventListener("keydown", this._onKeyDown);
    window.removeEventListener("keyup", this._onKeyUp);
    window.removeEventListener("mousemove", this._onMouseMove);
    window.removeEventListener("mousedown", this._onMouseDown);
    window.removeEventListener("mouseup", this._onMouseUp);
    window.removeEventListener("contextmenu", this._onContextMenu);
    window.removeEventListener("wheel", this._onWheel);
    document.removeEventListener("pointerlockchange", this._onLockChange);
  }

  requestLock() {
    if (this.wantLockEl && document.pointerLockElement !== this.wantLockEl) {
      const p = this.wantLockEl.requestPointerLock({ unadjustedMovement: true });
      if (p && p.catch) p.catch(() => { try { this.wantLockEl.requestPointerLock(); } catch (e) {} });
    }
  }

  releaseLock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  // Movement vector from keys (x = strafe, z = forward+)
  moveVec() {
    let x = 0, z = 0;
    if (this.keys.has("KeyW") || this.keys.has("ArrowUp")) z += 1;
    if (this.keys.has("KeyS") || this.keys.has("ArrowDown")) z -= 1;
    if (this.keys.has("KeyA") || this.keys.has("ArrowLeft")) x -= 1;
    if (this.keys.has("KeyD") || this.keys.has("ArrowRight")) x += 1;
    const t = this.touch;
    if (t.active && (t.mx !== 0 || t.mz !== 0)) { x = t.mx; z = t.mz; }
    const len = Math.hypot(x, z);
    if (len > 1) { x /= len; z /= len; }
    return { x, z };
  }

  sprinting() {
    return this.keys.has("ShiftLeft") || this.keys.has("ShiftRight") || (this.touch.active && this.touch.sprint);
  }

  isFireHeld() { return this.fireHeld || (this.touch.active && this.touch.fire); }

  consumeLook() {
    let dx = this.lookDX, dy = this.lookDY;
    this.lookDX = 0; this.lookDY = 0;
    if (this.touch.active) {
      dx += this.touch.lookDX;
      dy += this.touch.lookDY;
      this.touch.lookDX = 0; this.touch.lookDY = 0;
    }
    return { dx, dy };
  }

  consumeJump() {
    const p = this.jumpPressed || (this.touch.active && this.touch.jumpPressed);
    this.jumpPressed = false;
    if (this.touch.active) this.touch.jumpPressed = false;
    return p;
  }

  consumeFirePress() {
    const p = this.firePressed;
    this.firePressed = false;
    return p;
  }

  consumeMode() {
    const m = this.modeRequest;
    this.modeRequest = -1;
    return m;
  }

  consumeReload() { const r = this.reloadPressed; this.reloadPressed = false; return r; }
  consumeBuildToggle() { const b = this.buildTogglePressed; this.buildTogglePressed = false; return b; }
  consumeDigit() { const d = this.digitRequest; this.digitRequest = 0; return d; }
  consumeInteract() { const i = this.interactPressed; this.interactPressed = false; return i; }
  consumeSwap() { const s = this.swapPressed; this.swapPressed = false; return s; }
  consumeSlide() {
    const s = this.slidePressed || (this.touch.active && this.touch.slidePressed);
    this.slidePressed = false;
    if (this.touch.active) this.touch.slidePressed = false;
    return s;
  }
  isSlideHeld() { return this.slideHeld || (this.touch.active && this.touch.slideHeld); }
  consumeEdit() {
    const e = this.editPressed || (this.touch.active && this.touch.editPressed);
    this.editPressed = false;
    if (this.touch.active) this.touch.editPressed = false;
    return e;
  }
  consumePause() { const p = this.pausePressed; this.pausePressed = false; return p; }

  resetTransient() {
    this.lookDX = 0; this.lookDY = 0;
    this.fireHeld = false; this.firePressed = false;
    this.jumpHeld = false; this.jumpPressed = false;
    this.buildTogglePressed = false; this.digitRequest = 0;
    this.swapPressed = false; this.interactPressed = false;
    this.slidePressed = false; this.slideHeld = false; this.editPressed = false;
    this.modeRequest = -1;
    this.touch.slidePressed = false; this.touch.slideHeld = false; this.touch.editPressed = false;
    this.touch.fire = false; this.touch.jump = false; this.touch.jumpPressed = false;
  }
}
