# 🌩️ Stormfall Isle

A 3D browser battle royale — build, slide, and fight across a storm-swept island.
Singleplayer vs up to 100 bots, plus **online 1v1 duels**.

---

## ⚠️ ONE REQUIRED MANUAL STEP

Open `package.json` and add a `start` script. Render needs it to boot the server:

```json
"scripts": {
  "dev": "vite",
  "build": "vite build",
  "preview": "vite preview",
  "start": "node server.js"
}
```

Without this, the Render deploy will build fine but fail to start.

---

## 1. Push to GitHub

```bash
# from the project folder
git init
git add .
git commit -m "Stormfall Isle"
git branch -M main

# create an empty repo on github.com first (no README/licence),
# then point at it:
git remote add origin https://github.com/YOUR_USERNAME/stormfall-isle.git
git push -u origin main
```

`.gitignore` already excludes `node_modules/` and `dist/`.

---

## 2. Deploy to Render (free tier)

**It must be a Web Service, not a Static Site** — Static Sites can't run
WebSockets, and the multiplayer relay needs them.

### Option A — Blueprint (easiest)
`render.yaml` is already in the repo.
1. Render Dashboard → **New +** → **Blueprint**
2. Connect your GitHub repo → **Apply**

### Option B — Manual
1. Render Dashboard → **New +** → **Web Service** → connect your repo
2. Settings:
   | Field | Value |
   |---|---|
   | Runtime | **Node** |
   | Build Command | `npm install && npm run build` |
   | Start Command | `npm start` |
   | Plan | **Free** |
   | Health Check Path | `/healthz` |
3. **Create Web Service**

First build takes ~2–4 minutes. You'll get a URL like
`https://stormfall-isle.onrender.com`. Open it in two browsers/devices,
click **FIND A DUEL** on both, and you'll be matched.

---

## 3. Local development

```bash
npm install
npm run dev       # client only, hot reload, port 5173

# to test multiplayer locally:
npm run build
npm start         # serves dist/ + websockets on :3000
```

Open `http://localhost:3000` in two tabs. To point a dev client at a
remote server, append `?server=wss://your-app.onrender.com/ws`.

---

## 🛜 Is multiplayer actually possible here? — Yes, with caveats

**It works because of three properties this game already had:**

1. **Deterministic world.** World generation is seeded (`WORLD_SEED` in
   `utils.js`), so every client generates a byte-identical island. No map data
   is ever sent over the network. *(This was the one real blocker — before the
   fix, world gen used `Math.random()` and both players got different islands.)*
2. **Builds are integers.** A placed piece is just
   `{type, ix, iz, level, orient}` — about 40 bytes, and it lands in exactly
   the same place on both machines. Building replicates perfectly.
3. **Only 2 entities.** A duel syncs two players, not 51 — roughly **2 KB/s
   per player** at a 20 Hz snapshot rate. Trivial for the free tier.

### The architecture (relay, not authoritative simulation)

```
  Player A ──┐                      ┌── simulates A, interpolates B
             ├── Render WebSocket ──┤
  Player B ──┘      (relay)         └── simulates B, interpolates A
```

The server is authoritative for **matchmaking, the match seed, spawn points,
and the countdown**. Everything else it relays verbatim. Each client simulates
its own player and renders the opponent from snapshots with a **110 ms
interpolation buffer** to smooth out jitter.

Hits are **client-authoritative**: "I hit you for 23" → the victim applies the
damage to themselves. This means no rubber-banding and no server CPU cost, and
your HP is always truthful on your own screen.

### Honest limitations

| Issue | Reality |
|---|---|
| **Cheating** | Client-authoritative hits are trivially spoofable. Fine for friends; **not** suitable for a public competitive ladder. Fixing it means server-side simulation — a major rewrite. |
| **Cold starts** | Free services sleep after ~15 min idle and take **~50 s** to wake. The first player to visit will wait. |
| **750 free hours/month** | One always-on service ≈ 730 h, so a single service fits. |
| **512 MB RAM** | Plenty — the relay stores almost nothing. Hundreds of concurrent duels would fit before RAM matters. |
| **Single instance** | Don't scale to 2+ instances: rooms live in memory, so players on different instances can't see each other. You'd need Redis for that. |
| **Latency** | Pick the Render region nearest your players. Above ~150 ms, peeking feels unfair (you can get shot behind cover). |
| **No reconnect** | Dropping out ends the duel. |

### Beating the cold-start problem
Point a free uptime monitor (UptimeRobot, cron-job.org) at
`https://your-app.onrender.com/healthz` every 10 minutes. This is allowed and
keeps the instance warm. It does consume your free hours, which is fine for one
service.

---

## 🎮 Controls

| Key | Action |
|---|---|
| `WASD` | Move · `SHIFT` sprint |
| `SPACE` | Jump |
| `C` | **Slide** (faster downhill, lowers your hitbox) |
| `LMB` / `RMB` | Shoot / aim |
| `R` | Reload |
| `F` / `E` | Open chest · pick up weapon |
| `1` / `2` | Weapon slots · `X`/wheel to swap |
| `Q` | Toggle build mode |
| `1` `2` `3` *(in build mode)* | Wall · Floor · Ramp |
| `G` | Edit a build → hold `LMB`, sweep tiles, release to apply |
| `P` / `ESC` | Pause |

Full touch controls on mobile.

---

## 📁 Project layout

```
server.js            Express + WebSocket relay (matchmaking, rooms)
render.yaml          Render blueprint
src/
  App.tsx            Menus, HUD shell, match lifecycle
  game/
    Game.js          Orchestrator: loop, combat, storm, duel hooks
    world.js         Seeded island, POIs, structures
    builds.js        Grid building + tile editing
    bots.js          Bot AI (GOD tier uses A*)
    nav.js           A* pathfinding w/ build & break costs
    physics.js       Swept capsule movement, ramps, slopes
    weapons.js       6 weapons, viewmodels, loot
    effects.js       Particles, tracers, shake
    audio.js         Procedural WebAudio
  net/
    NetClient.js     WebSocket transport + protocol
    RemotePlayer.js  Opponent rendering + interpolation
```

## 🔌 Wire protocol

| Msg | Dir | Payload |
|---|---|---|
| `queue` | → | `{name}` join matchmaking |
| `matched` | ← | `{slot, seed, spawn, peerSpawn, peerName}` |
| `state` | ↔ | 20 Hz transform + hp/shield |
| `shot` | ↔ | muzzle + impact point (tracer/sfx) |
| `hit` | ↔ | `{dmg, x, y, z, head}` |
| `build` / `edit` / `destroy` | ↔ | grid coords (+ tile mask) |
| `died` | ↔ | end of round |
