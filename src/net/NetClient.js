// ============================================================
// NetClient.js — WebSocket transport + 1v1 protocol
//
// Thin wrapper: owns the socket, reconnection, latency probe and
// an event emitter. The Game subscribes to the events it cares about.
// ============================================================

export class NetClient {
  constructor() {
    this.ws = null;
    this.connected = false;
    this.slot = -1;
    this.room = null;
    this.ping = 0;
    this.handlers = new Map();
    this._pingTimer = null;
    this._sendBudget = 0;
  }

  url() {
    // same-origin by default; override with ?server=wss://host for local dev
    const params = new URLSearchParams(location.search);
    const override = params.get("server");
    if (override) return override;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}/ws`;
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
    return this;
  }
  _emit(type, data, slot) {
    const list = this.handlers.get(type);
    if (list) for (const fn of list) fn(data, slot);
  }

  connect() {
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
    let ws;
    try { ws = new WebSocket(this.url()); } catch (e) { this._emit("error", { message: "bad url" }); return; }
    this.ws = ws;

    ws.onopen = () => {
      this.connected = true;
      this._emit("open", {});
      this._pingTimer = setInterval(() => {
        this._lastPing = performance.now();
        this.send("ping", { c: this._lastPing });
      }, 2000);
    };
    ws.onclose = () => {
      this.connected = false;
      this.slot = -1;
      this.room = null;
      clearInterval(this._pingTimer);
      this._emit("close", {});
    };
    ws.onerror = () => this._emit("error", { message: "socket error" });
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      const { t, d, s } = msg;
      if (t === "pong") {
        this.ping = Math.round(performance.now() - (d && d.c ? d.c : this._lastPing));
        return;
      }
      if (t === "matched") { this.slot = d.slot; this.room = d.room; }
      if (t === "peerleft") this.room = null;
      this._emit(t, d, s);
    };
  }

  disconnect() {
    clearInterval(this._pingTimer);
    if (this.ws) { try { this.ws.close(); } catch {} }
    this.ws = null;
    this.connected = false;
  }

  send(type, data) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    try { this.ws.send(JSON.stringify({ t: type, d: data })); return true; } catch { return false; }
  }

  queue(name) { this.send("queue", { name }); }
  cancel() { this.send("cancel", {}); }
  leave() { this.send("leave", {}); }
}
