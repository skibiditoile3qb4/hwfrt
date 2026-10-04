// ============================================================
// server.js — Stormfall Isle 1v1 relay server
//
// Serves the built client (dist/) and runs a tiny WebSocket
// matchmaker: players queue, get paired into 2-player rooms,
// and the server relays state between them.
//
// Design notes:
//  - Relay (not simulation) authority. Each client simulates its
//    own player and trusts the peer's reported state. Perfectly
//    fine for 1v1 with friends; trivially cheatable by a determined
//    attacker. See README for the trade-off.
//  - The server IS authoritative for: match seed, who spawns where,
//    countdown start time, and match end. That keeps both clients
//    generating the same world and storm.
//  - Zero state is persisted, so Render's ephemeral free tier is fine.
// ============================================================
import express from "express";
import compression from "compression";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
app.use(compression());
app.use(express.static(join(__dirname, "dist"), { maxAge: "1h" }));

// Render pings this to check the service is alive (and you can use it
// with an uptime monitor to stop the free tier spinning down).
app.get("/healthz", (_req, res) => res.type("text").send("ok"));
app.get("/stats", (_req, res) =>
  res.json({ online: clients.size, queued: queue.length, rooms: rooms.size })
);

app.get("/{*splat}", (_req, res) =>
  res.sendFile(join(__dirname, "dist", "index.html"))
);

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// ------------------------------------------------------------
// state
// ------------------------------------------------------------
const clients = new Set();
let queue = [];
const rooms = new Map();
let nextRoomId = 1;

const send = (ws, type, data) => {
  if (ws.readyState === 1) {
    try { ws.send(JSON.stringify({ t: type, d: data })); } catch {}
  }
};

function pairUp() {
  // drop dead sockets
  queue = queue.filter((c) => c.readyState === 1 && !c.room);
  while (queue.length >= 2) {
    const a = queue.shift();
    const b = queue.shift();
    const id = nextRoomId++;
    const seed = (Math.random() * 0xffffffff) >>> 0;

    // deterministic, mirrored spawns so neither player is favoured
    const ang = Math.random() * Math.PI * 2;
    const R = 70;
    const spawns = [
      { x: Math.cos(ang) * R, z: Math.sin(ang) * R },
      { x: -Math.cos(ang) * R, z: -Math.sin(ang) * R },
    ];

    const room = { id, players: [a, b], seed, spawns, startedAt: Date.now(), over: false };
    rooms.set(id, room);
    a.room = room; b.room = room;
    a.slot = 0; b.slot = 1;

    [a, b].forEach((c, i) => {
      send(c, "matched", {
        room: id,
        slot: i,
        seed,
        spawn: spawns[i],
        peerSpawn: spawns[1 - i],
        peerName: (i === 0 ? b : a).name,
        countdownMs: 3000,
      });
    });
    console.log(`[room ${id}] matched ${a.name} vs ${b.name}`);
  }
}

function leaveRoom(ws, reason) {
  const room = ws.room;
  if (!room) return;
  const peer = room.players.find((p) => p !== ws);
  if (peer && peer.readyState === 1) {
    send(peer, "peerleft", { reason });
    peer.room = null;
  }
  rooms.delete(room.id);
  ws.room = null;
  console.log(`[room ${room.id}] closed (${reason})`);
}

// Messages relayed verbatim to the peer. Keep this list tight.
const RELAY = new Set([
  "state",   // transform + animation, ~20Hz
  "shot",    // a bullet was fired (for tracer/sfx on the peer)
  "hit",     // "I hit you for N" — receiver applies it to themselves
  "build",   // piece placed
  "edit",    // piece tiles changed
  "destroy", // piece destroyed
  "died",    // I died
  "emote",
]);

wss.on("connection", (ws, req) => {
  ws.isAlive = true;
  ws.name = "PLAYER";
  ws.room = null;
  clients.add(ws);
  ws.on("pong", () => { ws.isAlive = true; });

  send(ws, "hello", { online: clients.size });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const { t, d } = msg || {};
    if (!t) return;

    switch (t) {
      case "queue": {
        ws.name = String((d && d.name) || "PLAYER").slice(0, 12).toUpperCase();
        if (ws.room) leaveRoom(ws, "requeue");
        if (!queue.includes(ws)) queue.push(ws);
        send(ws, "queued", { position: queue.length });
        pairUp();
        break;
      }
      case "cancel": {
        queue = queue.filter((c) => c !== ws);
        send(ws, "cancelled", {});
        break;
      }
      case "leave": {
        leaveRoom(ws, "left");
        break;
      }
      case "ping": {
        send(ws, "pong", { c: d && d.c });
        break;
      }
      default: {
        if (RELAY.has(t) && ws.room) {
          const peer = ws.room.players.find((p) => p !== ws);
          if (peer && peer.readyState === 1) {
            // stamp the sender so the client never confuses itself
            try { peer.send(JSON.stringify({ t, d, s: ws.slot })); } catch {}
          }
        }
      }
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    queue = queue.filter((c) => c !== ws);
    leaveRoom(ws, "disconnect");
  });
  ws.on("error", () => {});
});

// drop zombie sockets (Render closes idle connections ~5min)
setInterval(() => {
  for (const ws of clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 30000);

server.listen(PORT, () => {
  console.log(`Stormfall Isle listening on :${PORT}`);
});
