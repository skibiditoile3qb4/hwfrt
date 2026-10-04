// ============================================================
// App.tsx — STORMFALL ISLE shell: menu / HUD / pause / gameover
// ============================================================
import { useCallback, useEffect, useRef, useState } from "react";
import { Game } from "./game/Game.js";
import { NetClient } from "./net/NetClient.js";
import Hud, { TouchControls, type FeedItem } from "./ui/Hud";
import {
  Play, RotateCcw, Home, Volume2, Gauge, Sparkles, Crown, Trophy, Skull, Users,
  ChevronRight, Settings, X, MousePointer2, Keyboard, Swords, Star,
  CloudLightning,
} from "lucide-react";

type Phase = "menu" | "playing" | "paused" | "over";
interface ScoreEntry { score: number; kills: number; place: number; diff: string; date: number; }
interface MatchResult {
  win: boolean; placement: number; total: number; kills: number; score: number;
  placeBonus: number; winBonus: number; time: number; diffKey: string; diffLabel: string; killedBy: string | null;
}

const RARITY_CSS: Record<string, string> = {
  common: "#b8c0cc", uncommon: "#52e07a", rare: "#4fa8ff", epic: "#b464ff", legendary: "#ffb23d",
};
const PREFS_KEY = "stormfall_prefs_v1";
const SCORES_KEY = "stormfall_scores_v1";
const isTouchDevice = () =>
  (typeof window !== "undefined" && (window.matchMedia("(pointer: coarse)").matches || "ontouchstart" in window)) || false;

function loadJSON<T>(key: string, fb: T): T {
  try { const v = localStorage.getItem(key); return v ? { ...fb, ...JSON.parse(v) } as T : fb; } catch { return fb; }
}
function loadScores(): ScoreEntry[] {
  try { const v = localStorage.getItem(SCORES_KEY); return v ? JSON.parse(v) : []; } catch { return []; }
}

export default function App() {
  const containerRef = useRef<HTMLDivElement>(null);
  const hudRootRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<any>(null);
  const dataRef = useRef<any>(null);

  const [phase, setPhase] = useState<Phase>("menu");
  const phaseRef = useRef<Phase>("menu");
  const setPhaseBoth = (p: Phase) => { phaseRef.current = p; setPhase(p); };

  const [diffKey, setDiffKey] = useState("normal");
  const diffRef = useRef("normal");
  const [botCount, setBotCount] = useState(() => loadJSON(PREFS_KEY, { botCount: 50 }).botCount ?? 50);
  const botCountRef = useRef(botCount);
  const [isTouch] = useState(isTouchDevice());
  const [prefs, setPrefs] = useState(() => loadJSON(PREFS_KEY, { sensitivity: 1, volume: 0.8, quality: "high" }));
  const [scores, setScores] = useState<ScoreEntry[]>(loadScores);
  const [result, setResult] = useState<MatchResult | null>(null);
  const [newBest, setNewBest] = useState(false);
  const [killfeed, setKillfeed] = useState<FeedItem[]>([]);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [streak, setStreak] = useState<string | null>(null);
  const [stormMsg, setStormMsg] = useState<string | null>(null);
  const [locked, setLocked] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [showHint, setShowHint] = useState(false);
  const [bigBanner, setBigBanner] = useState<string | null>(null);
  const [playerName, setPlayerName] = useState(() => loadJSON(PREFS_KEY, { playerName: "" }).playerName || "PLAYER");
  const netRef = useRef<any>(null);
  const [net, setNet] = useState<{ status: string; ping: number; peer: string | null }>({
    status: "offline", ping: 0, peer: null,
  });
  const [gunToast, setGunToast] = useState<{ name: string; css: string; id: number } | null>(null);

  const feedId = useRef(0);
  const timers = useRef<number[]>([]);
  const later = (fn: () => void, ms: number) => { const id = window.setTimeout(fn, ms); timers.current.push(id); };

  // -------------------- game lifecycle --------------------
  useEffect(() => {
    const game = new Game({
      container: containerRef.current!,
      hudRoot: hudRootRef.current!,
      isTouch: isTouchDevice(),
      prefs: loadJSON(PREFS_KEY, { sensitivity: 1, volume: 0.8, quality: "high" }),
      hooks: {
        hud: (d: any) => { dataRef.current = d; },
        event: (type: string, payload: any) => handleGameEvent(type, payload),
        over: (res: MatchResult) => handleMatchOver(res),
      },
    });
    gameRef.current = game;
    game.boot();

    // ---- multiplayer transport ----
    const nc = new NetClient();
    netRef.current = nc;
    game.attachNet(nc);
    nc.on("open", () => setNet((n) => ({ ...n, status: "online" })));
    nc.on("close", () => setNet((n) => ({ ...n, status: "offline", peer: null })));
    nc.on("error", () => setNet((n) => ({ ...n, status: "error" })));
    nc.on("queued", () => setNet((n) => ({ ...n, status: "searching" })));
    nc.on("cancelled", () => setNet((n) => ({ ...n, status: "online" })));
    nc.on("matched", (d: any) => {
      setNet((n) => ({ ...n, status: "match", peer: d.peerName }));
      setPhaseBoth("playing");
    });
    nc.on("peerleft", () => setNet((n) => ({ ...n, status: "online", peer: null })));
    const pingIv = setInterval(() => setNet((n) => (n.ping === nc.ping ? n : { ...n, ping: nc.ping })), 1000);

    return () => {
      timers.current.forEach(clearTimeout);
      clearInterval(pingIv);
      nc.disconnect();
      game.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const flashDmgVeil = useCallback(() => {
    const el = document.getElementById("dmg-veil");
    if (!el) return;
    el.style.transition = "none";
    el.style.opacity = "1";
    void el.offsetHeight;
    el.style.transition = "opacity 0.45s ease-out";
    el.style.opacity = "0";
  }, []);

  const spawnHitmarker = useCallback((kill: boolean) => {
    const layer = document.getElementById("hit-layer");
    if (!layer) return;
    const el = document.createElement("div");
    el.className = "hitmarker" + (kill ? " kill" : "");
    layer.appendChild(el);
    setTimeout(() => el.remove(), 320);
  }, []);

  const handleGameEvent = useCallback((type: string, payload: any) => {
    const game = gameRef.current;
    switch (type) {
      case "matchstart":
        setKillfeed([]);
        setResult(null);
        setCountdown(3);
        setBigBanner(null);
        setShowHint(true);
        later(() => setShowHint(false), 9000);
        break;
      case "count": {
        setCountdown(payload.n);
        if (payload.n === 0) later(() => setCountdown(null), 640);
        break;
      }
      case "hitmark": spawnHitmarker(payload.kill); break;
      case "weapon": {
        if (!payload.picked) break;
        const css = RARITY_CSS[payload.rarity] || "#b8c0cc";
        const id = ++feedId.current;
        setGunToast({ name: payload.name, css, id });
        later(() => setGunToast((t) => (t && t.id === id ? null : t)), 2200);
        break;
      }
      case "chest": {
        const css = RARITY_CSS[payload.rarity] || "#ffd166";
        const id = ++feedId.current;
        setGunToast({ name: `CHEST · ${payload.weapon}`, css, id });
        later(() => setGunToast((t) => (t && t.id === id ? null : t)), 2200);
        break;
      }
      case "edit": {
        const id = ++feedId.current;
        setGunToast({
          name: `${payload.stolen ? "STOLEN · " : ""}${payload.type.toUpperCase()} · ${payload.name}`,
          css: payload.stolen ? "#b464ff" : "#ffd166", id,
        });
        later(() => setGunToast((t) => (t && t.id === id ? null : t)), 1300);
        break;
      }
      case "damaged": flashDmgVeil(); break;
      case "streak": {
        setStreak(payload.name);
        later(() => setStreak(null), 1900);
        break;
      }
      case "killfeed": {
        const item: FeedItem = { id: ++feedId.current, killer: payload.killer, victim: payload.victim, you: payload.you, elite: payload.elite };
        setKillfeed((f) => [...f.slice(-5), item]);
        later(() => setKillfeed((f) => f.filter((k) => k.id !== item.id)), 4600);
        break;
      }
      case "storm": {
        setStormMsg(payload.shrinking ? `STORM SHRINKING — PHASE ${payload.phase}` : `ZONE LOCKED — PHASE ${payload.phase}`);
        later(() => setStormMsg(null), 3200);
        break;
      }
      case "victory": {
        setBigBanner("VICTORY ROYALE");
        break;
      }
      case "defeat": {
        setBigBanner(null);
        break;
      }
      case "pause": setPhaseBoth("paused"); break;
      case "resume": setPhaseBoth("playing"); break;
      case "menu": setPhaseBoth("menu"); break;
      case "lockchange": setLocked(payload.locked); break;
      default: break;
    }
    void game;
  }, [flashDmgVeil, spawnHitmarker]);

  const handleMatchOver = useCallback((res: MatchResult) => {
    later(() => {
      setResult(res);
      setPhaseBoth("over");
      // save score
      setScores((prev) => {
        const entry: ScoreEntry = { score: res.score, kills: res.kills, place: res.placement, diff: res.diffLabel, date: Date.now() };
        const next = [...prev, entry].sort((a, b) => b.score - a.score).slice(0, 8);
        const isBest = next[0] === entry && res.score > 0;
        setNewBest(isBest);
        try { localStorage.setItem(SCORES_KEY, JSON.stringify(next)); } catch {}
        return next;
      });
    }, res.win ? 1500 : 1600);
  }, []);

  const savePrefs = useCallback((p: any) => {
    setPrefs((old) => {
      const next = { ...old, ...p };
      try { localStorage.setItem(PREFS_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
    gameRef.current?.setPrefs(p);
  }, []);

  const play = useCallback((dk?: string) => {
    const game = gameRef.current;
    if (!game) return;
    game.sound.ensure();
    game.sound.uiClick();
    const key = dk || diffRef.current;
    diffRef.current = key;
    setPhaseBoth("playing");
    game.startMatch(key, botCountRef.current);
  }, []);

  const restart = useCallback(() => {
    const game = gameRef.current;
    if (!game) return;
    game.sound.ensure();
    setResult(null);
    setKillfeed([]);
    setPhaseBoth("playing");
    game.startMatch(diffRef.current, botCountRef.current);
  }, []);

  const toMenu = useCallback(() => {
    gameRef.current?.sound.uiClick();
    gameRef.current?.quitToMenu();
    setResult(null);
  }, []);

  const resume = useCallback(() => {
    gameRef.current?.sound.uiClick();
    gameRef.current?.resume();
  }, []);

  const pauseGame = useCallback(() => { gameRef.current?.pause(); }, []);

  // global keys on menu/over screens
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (phaseRef.current === "menu" && (e.code === "Enter")) play();
      else if (phaseRef.current === "over" && e.code === "KeyR") restart();
      else if (phaseRef.current === "paused" && (e.code === "KeyR")) { restart(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [play, restart]);

  const setDiff = (k: string) => { setDiffKey(k); diffRef.current = k; gameRef.current?.sound.ensure(); gameRef.current?.sound.uiClick(); };

  const game = gameRef.current;
  const DIFFS = [
    { key: "easy", label: "RECRUIT", desc: "Slow, sloppy bots. Learn the ropes.", color: "#3df5c4", icon: Sparkles },
    { key: "normal", label: "VETERAN", desc: "Real fights. Bots strafe, track and build.", color: "#ffd166", icon: Swords },
    { key: "hard", label: "LEGEND", desc: "Cracked aim, instant builds, no mercy.", color: "#ff5f6d", icon: Skull },
    { key: "god", label: "GOD", desc: "Inhuman aim. They raise forts and box you in.", color: "#b464ff", icon: Crown },
  ];

  return (
    <div className="fixed inset-0 bg-night overflow-hidden game-noselect">
      {/* 3D canvas mount */}
      <div ref={containerRef} className="absolute inset-0" />
      {/* HUD root for game-drawn DOM (name tags / damage numbers) */}
      <div ref={hudRootRef} className="absolute inset-0 pointer-events-none overflow-hidden z-10" />

      {/* cinematic vignette */}
      <div
        className="absolute inset-0 pointer-events-none z-[15]"
        style={{ background: "radial-gradient(ellipse at center, transparent 58%, rgba(6,8,20,0.34) 100%)" }}
      />

      {/* ==================== IN-GAME HUD ==================== */}
      {(phase === "playing" || phase === "paused" || phase === "over") && (
        <div className="absolute inset-0 z-20">
          <Hud
            dataRef={dataRef}
            killfeed={killfeed}
            countdown={countdown}
            streak={streak}
            stormMsg={stormMsg}
            isTouch={isTouch}
          />
          {isTouch && phase === "playing" && <TouchControls game={game} onPause={pauseGame} />}

          {/* click-to-aim veil (desktop) */}
          {!isTouch && phase === "playing" && !locked && !countdown && countdown !== 0 && (
            <div
              className="absolute inset-0 z-40 flex items-center justify-center cursor-pointer bg-night/40 backdrop-blur-[2px]"
              onClick={() => gameRef.current?.input.requestLock()}
            >
              <div className="panel-glass rounded-xl px-8 py-5 flex items-center gap-3 anim-pop-in">
                <MousePointer2 className="text-volt" size={22} />
                <span className="font-display text-xl tracking-wider text-white">CLICK TO AIM</span>
              </div>
            </div>
          )}

          {/* hint toast */}
          {showHint && phase === "playing" && (
            <div className="absolute bottom-[120px] left-1/2 -translate-x-1/2 pointer-events-none">
              <div className="panel-glass rounded-full px-5 py-2 text-[12.5px] font-semibold tracking-widest text-white/75 anim-slide-up flex items-center gap-2">
                {isTouch ? (
                  <><span className="text-volt">STICK</span> move <span className="text-white/30">•</span> <span className="text-volt">DRAG</span> aim <span className="text-white/30">•</span> <span className="text-sun">↓</span> loot chests</>
                ) : (
                  <><Keyboard size={14} className="text-volt" /><span className="text-volt">WASD</span> move <span className="text-white/30">•</span> <span className="text-storm">C</span> slide <span className="text-white/30">•</span> <span className="text-sun">F</span> loot <span className="text-white/30">•</span> <span className="text-blaze">Q</span> build <span className="text-white/30">•</span> <span className="text-sun">G</span> edit</>
                )}
              </div>
            </div>
          )}

          {/* weapon pickup toast */}
          {gunToast && (
            <div key={gunToast.id} className="absolute bottom-[34%] left-1/2 -translate-x-1/2 pointer-events-none anim-pop-in">
              <div
                className="panel-glass rounded-lg px-5 py-2 font-display text-[15px] tracking-[0.16em]"
                style={{ color: gunToast.css, borderColor: gunToast.css + "77", boxShadow: `0 0 26px ${gunToast.css}44` }}
              >
                {gunToast.name}
              </div>
            </div>
          )}

          {/* victory banner */}
          {bigBanner === "VICTORY ROYALE" && (
            <div className="absolute top-[30%] left-1/2 -translate-x-1/2 anim-banner pointer-events-none">
              <div className="flex items-center gap-4">
                <Crown size={44} className="text-sun" />
                <div className="font-display text-5xl md:text-7xl title-gradient tracking-wide">#1 VICTORY</div>
                <Crown size={44} className="text-sun" />
              </div>
            </div>
          )}
        </div>
      )}

      {/* ==================== MENU ==================== */}
      {phase === "menu" && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center overflow-y-auto scroll-slim"
          style={{ background: "radial-gradient(ellipse at 50% 120%, rgba(11,16,35,0.25) 0%, rgba(11,16,35,0.66) 55%, rgba(11,16,35,0.92) 100%)" }}
        >
          <div className="flex flex-col items-center px-4 py-8 w-full max-w-5xl">
            {/* badge */}
            <div className="panel-glass rounded-full pl-3 pr-4 py-1.5 flex items-center gap-2 mb-5 anim-slide-up">
              <span className="relative flex h-2.5 w-2.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-volt opacity-60"></span>
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-volt"></span>
              </span>
              <span className="font-ui text-[12px] md:text-[13px] font-bold tracking-[0.28em] text-white/85">SOLO BATTLE ROYALE • 51 COMBATANTS</span>
            </div>

            {/* title */}
            <h1 className="font-display text-center leading-[0.95] anim-slide-up" style={{ animationDelay: "0.06s" }}>
              <span className="block text-6xl md:text-8xl title-gradient tracking-wide">STORMFALL</span>
              <span className="block text-4xl md:text-6xl text-white/95 tracking-[0.22em] mt-1" style={{ textShadow: "0 4px 24px rgba(0,0,0,0.6)" }}>ISLE</span>
            </h1>
            <p className="font-ui text-white/65 text-base md:text-lg font-semibold tracking-[0.24em] mt-4 mb-8 anim-slide-up" style={{ animationDelay: "0.12s" }}>
              DROP IN&nbsp;&nbsp;•&nbsp;&nbsp;BUILD UP&nbsp;&nbsp;•&nbsp;&nbsp;OUTLAST 50 BOTS
            </p>

            {/* difficulty cards */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 w-full max-w-3xl mb-7 anim-slide-up" style={{ animationDelay: "0.18s" }}>
              {DIFFS.map((d) => {
                const active = diffKey === d.key;
                return (
                  <button
                    key={d.key}
                    onClick={() => setDiff(d.key)}
                    className={`panel-glass rounded-xl p-4 text-left transition-all duration-150 cursor-pointer group ${active ? "scale-[1.03]" : "opacity-75 hover:opacity-100"}`}
                    style={active ? { borderColor: d.color + "aa", boxShadow: `0 0 30px ${d.color}33, 0 22px 60px rgba(0,0,0,0.5)` } : {}}
                  >
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="flex items-center gap-2">
                        <d.icon size={17} style={{ color: d.color }} />
                        <span className="font-display text-[15px] tracking-wider" style={{ color: d.color }}>{d.label}</span>
                      </div>
                      {active && <ChevronRight size={16} style={{ color: d.color }} />}
                    </div>
                    <div className="font-ui text-[13px] font-medium text-white/60 leading-snug">{d.desc}</div>
                  </button>
                );
              })}
            </div>

            {/* ---- ONLINE 1v1 ---- */}
            <div className="panel-glass rounded-xl px-5 py-4 w-full max-w-3xl mb-4 anim-slide-up" style={{ animationDelay: "0.19s" }}>
              <div className="flex items-center justify-between mb-2.5">
                <div className="font-display text-[12px] tracking-[0.24em] text-white/85 flex items-center gap-2">
                  <Swords size={14} className="text-storm" /> ONLINE 1v1 DUEL
                </div>
                <div className="flex items-center gap-2 font-ui text-[11px] font-bold tracking-widest">
                  <span className={`inline-block w-2 h-2 rounded-full ${
                    net.status === "offline" || net.status === "error" ? "bg-red-400"
                    : net.status === "searching" ? "bg-sun animate-pulse" : "bg-volt"}`} />
                  <span className="text-white/50">
                    {net.status === "offline" ? "DISCONNECTED"
                      : net.status === "error" ? "NO SERVER"
                      : net.status === "searching" ? "SEARCHING…"
                      : net.status === "match" ? `VS ${net.peer}`
                      : `CONNECTED · ${net.ping}ms`}
                  </span>
                </div>
              </div>
              <div className="flex gap-2">
                {net.status === "searching" ? (
                  <button
                    onClick={() => { netRef.current?.cancel(); }}
                    className="btn-neon flex-1 font-display rounded-lg py-3 text-[13px] tracking-[0.18em] text-white border border-white/20"
                  >
                    CANCEL SEARCH
                  </button>
                ) : (
                  <button
                    onClick={() => {
                      const nc = netRef.current;
                      gameRef.current?.sound.ensure();
                      gameRef.current?.sound.uiClick();
                      if (!nc.connected) { nc.connect(); setNet((n) => ({ ...n, status: "connecting" })); setTimeout(() => nc.queue(playerName), 700); }
                      else nc.queue(playerName);
                    }}
                    className="btn-neon flex-1 font-display rounded-lg py-3 text-[13px] tracking-[0.18em] text-night"
                    style={{ background: "linear-gradient(135deg,#b464ff,#8be9ff)" }}
                  >
                    FIND A DUEL
                  </button>
                )}
                <input
                  value={playerName}
                  onChange={(e) => { const v = e.target.value.toUpperCase().slice(0, 12); setPlayerName(v); savePrefs({ playerName: v }); }}
                  placeholder="NAME"
                  className="w-32 rounded-lg bg-white/5 border border-white/15 px-3 font-display text-[13px] tracking-widest text-white text-center outline-none focus:border-volt/60"
                />
              </div>
              <div className="font-ui text-[11px] text-white/35 font-medium mt-1.5">
                No bots, no storm rush — just you, one rival, and infinite builds on the same island.
              </div>
            </div>

            {/* opponent count */}
            <div className="panel-glass rounded-xl px-5 py-4 w-full max-w-3xl mb-6 anim-slide-up" style={{ animationDelay: "0.2s" }}>
              <div className="flex items-center justify-between mb-2.5">
                <div className="font-display text-[12px] tracking-[0.24em] text-white/85 flex items-center gap-2">
                  <Users size={14} className="text-sky-300" /> OPPONENTS
                </div>
                <div className="flex items-baseline gap-1.5">
                  <span className="font-display text-2xl text-volt">{botCount}</span>
                  <span className="font-ui text-[12px] font-bold tracking-widest text-white/40">BOTS · {botCount + 1} TOTAL</span>
                </div>
              </div>
              <input
                type="range" min={1} max={100} step={1} value={botCount}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  setBotCount(v);
                  botCountRef.current = v;
                  savePrefs({ botCount: v });
                }}
                className="w-full accent-teal-300"
              />
              <div className="flex justify-between font-ui text-[10px] font-bold tracking-widest text-white/30 mt-1">
                <span>1 · DUEL</span><span>25</span><span>50 · CLASSIC</span><span>75</span><span>100 · CHAOS</span>
              </div>
              <div className="flex gap-2 mt-3">
                {[5, 20, 50, 100].map((n) => (
                  <button
                    key={n}
                    onClick={() => { setBotCount(n); botCountRef.current = n; savePrefs({ botCount: n }); gameRef.current?.sound.uiClick(); }}
                    className={`flex-1 font-display text-[12px] tracking-[0.16em] rounded-lg py-2 border transition-all cursor-pointer ${botCount === n ? "text-night border-transparent" : "text-white/55 border-white/12 hover:border-white/30"}`}
                    style={botCount === n ? { background: "linear-gradient(135deg,#3df5c4,#8be9ff)" } : {}}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>

            {/* play button */}
            <button
              onClick={() => play()}
              className="btn-neon font-display rounded-2xl px-14 py-5 text-2xl tracking-[0.2em] text-night anim-slide-up"
              style={{ animationDelay: "0.24s", background: "linear-gradient(135deg,#3df5c4,#8be9ff)", boxShadow: "0 12px 44px rgba(61,245,196,0.45), inset 0 1px 0 rgba(255,255,255,0.5)" }}
            >
              <span className="flex items-center gap-3"><Play size={26} strokeWidth={3} /> DEPLOY</span>
            </button>
            <div className="font-ui text-white/40 text-[12px] font-semibold tracking-[0.3em] mt-3 anim-slide-up" style={{ animationDelay: "0.28s" }}>
              {isTouch ? "TAP TO DEPLOY" : "PRESS ENTER"}
            </div>

            {/* controls + scores */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 w-full max-w-3xl mt-9 anim-slide-up" style={{ animationDelay: "0.34s" }}>
              {/* controls card */}
              <div className="panel-glass rounded-xl p-4">
                <div className="font-display text-[12px] tracking-[0.24em] text-white/85 mb-2.5 flex items-center gap-2"><Keyboard size={14} className="text-volt" /> CONTROLS</div>
                {isTouch ? (
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 font-ui text-[13px] font-medium text-white/60">
                    <span className="text-white/85 font-semibold">Left stick</span><span>Move (edge = sprint)</span>
                    <span className="text-white/85 font-semibold">Right drag</span><span>Aim</span>
                    <span className="text-white/85 font-semibold">Red button</span><span>Fire / place build</span>
                    <span className="text-sun font-semibold">↓ button</span><span>Open chest / grab gun</span>
                    <span className="text-white/85 font-semibold">⇄ button</span><span>Swap weapon slot</span>
                    <span className="text-storm font-semibold">Slide button</span><span>Slide (faster downhill)</span>
                    <span className="text-sun font-semibold">✎ button</span><span>Edit build, then hold fire + drag tiles</span>
                    <span className="text-white/85 font-semibold">Mode icons</span><span>Gun / Wall / Floor / Ramp</span>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 font-ui text-[13px] font-medium text-white/60">
                    <span><b className="text-volt">WASD</b> move</span><span><b className="text-volt">SHIFT</b> sprint</span>
                    <span><b className="text-volt">SPACE</b> jump</span><span><b className="text-volt">LMB</b> shoot / place</span>
                    <span><b className="text-volt">RMB</b> aim</span><span><b className="text-volt">R</b> reload</span>
                    <span><b className="text-sun">F / E</b> loot chest</span><span><b className="text-sun">X / WHEEL</b> swap gun</span>
                    <span><b className="text-storm">C</b> slide — downhill = fast</span><span><b className="text-sun">G</b> edit your build</span>
                    <span><b className="text-volt">1 / 2</b> weapon slots</span><span><b className="text-blaze">Q</b> build mode on/off</span>
                    <span className="col-span-2"><b className="text-blaze">in build:</b> <b className="text-volt">1</b> wall · <b className="text-volt">2</b> floor · <b className="text-volt">3</b> ramp · <b className="text-volt">Q</b> back to guns</span>
                    <span className="col-span-2 text-white/40"><b className="text-sun">Edit:</b> aim at ANY build (walls, floors, ramps — even enemy ones, you steal them), tap <b className="text-sun">G</b> to open its tile grid, <b className="text-sun">hold LMB and sweep</b> across tiles, then <b className="text-sun">release to apply</b>. G cancels.</span>
                    <span className="col-span-2 text-white/40"><b className="text-storm">Slide</b> lowers your hitbox ~45% — shots sail overhead. Slide down hills &amp; ramps to hit 26 m/s.</span>
                  </div>
                )}
              </div>
              {/* high scores */}
              <div className="panel-glass rounded-xl p-4">
                <div className="font-display text-[12px] tracking-[0.24em] text-white/85 mb-2.5 flex items-center gap-2"><Trophy size={14} className="text-sun" /> HIGH SCORES</div>
                {scores.length === 0 ? (
                  <div className="font-ui text-[13px] text-white/40 font-medium">No drops yet. Be the first legend.</div>
                ) : (
                  <div className="flex flex-col gap-1">
                    {scores.slice(0, 5).map((s, i) => (
                      <div key={i} className="flex items-center gap-2 font-ui text-[13px] font-semibold">
                        <span className={`w-5 text-center font-display text-[12px] ${i === 0 ? "text-sun" : "text-white/35"}`}>{i + 1}</span>
                        <span className="text-white/90 flex-1">{s.score.toLocaleString()}</span>
                        <span className="text-white/45">{s.kills} K</span>
                        <span className="text-white/45">#{s.place}</span>
                        <span className="text-[10px] tracking-widest px-1.5 py-0.5 rounded bg-white/8 text-white/55">{s.diff}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* settings gear */}
          <button onClick={() => setShowSettings(true)} className="absolute top-4 right-4 panel-glass rounded-full p-2.5 text-white/70 hover:text-white transition-colors cursor-pointer">
            <Settings size={18} />
          </button>
        </div>
      )}

      {/* ==================== PAUSED ==================== */}
      {phase === "paused" && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-night/70 backdrop-blur-md">
          <div className="panel-glass rounded-2xl p-8 w-[min(92vw,420px)] anim-pop-in">
            <div className="font-display text-3xl text-white tracking-wider mb-1 text-center">PAUSED</div>
            <div className="font-ui text-white/50 text-[13px] font-semibold tracking-[0.2em] text-center mb-6 flex items-center justify-center gap-2">
              <CloudLightning size={13} className="text-storm" /> STORM WAITS FOR NO ONE
            </div>
            <div className="flex flex-col gap-2.5">
              <button onClick={resume} className="btn-neon font-display rounded-xl px-6 py-3.5 text-night tracking-[0.18em]" style={{ background: "linear-gradient(135deg,#3df5c4,#8be9ff)" }}>
                RESUME
              </button>
              <button onClick={restart} className="btn-neon panel-glass font-display rounded-xl px-6 py-3.5 text-white tracking-[0.18em] flex items-center justify-center gap-2">
                <RotateCcw size={16} /> RESTART
              </button>
              <button onClick={() => setShowSettings(true)} className="btn-neon panel-glass font-display rounded-xl px-6 py-3.5 text-white/85 tracking-[0.18em] flex items-center justify-center gap-2">
                <Settings size={16} /> SETTINGS
              </button>
              <button onClick={toMenu} className="btn-neon panel-glass font-display rounded-xl px-6 py-3.5 text-white/70 tracking-[0.18em] flex items-center justify-center gap-2">
                <Home size={16} /> ABANDON MATCH
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ==================== GAME OVER / VICTORY ==================== */}
      {phase === "over" && result && (
        <div className="absolute inset-0 z-40 flex items-center justify-center overflow-y-auto scroll-slim"
          style={{ background: result.win ? "radial-gradient(ellipse at center, rgba(40,34,8,0.55), rgba(11,16,35,0.88) 75%)" : "radial-gradient(ellipse at center, rgba(35,10,14,0.55), rgba(11,16,35,0.9) 75%)" }}
        >
          <div className="w-[min(94vw,520px)] py-8">
            {/* headline */}
            <div className="text-center mb-6">
              {result.win ? (
                <>
                  <Crown size={52} className="text-sun mx-auto mb-2 anim-floaty" />
                  <div className="font-display text-5xl md:text-6xl title-gradient tracking-wide anim-banner">#1 VICTORY</div>
                  <div className="font-display text-xl md:text-2xl text-sun tracking-[0.3em] mt-1">ROYALE</div>
                </>
              ) : (
                <>
                  <div className="font-display text-5xl md:text-6xl text-white tracking-wide anim-banner" style={{ textShadow: "0 0 30px rgba(255,95,109,0.5)" }}>
                    #{result.placement}
                  </div>
                  <div className="font-ui text-white/60 text-[14px] font-semibold tracking-[0.2em] mt-2 flex items-center justify-center gap-2">
                    <Skull size={14} className="text-blaze" />
                    {result.killedBy ? <>ELIMINATED BY <span className="text-blaze font-bold">{result.killedBy}</span></> : "SWALLOWED BY THE STORM"}
                  </div>
                </>
              )}
              {newBest && (
                <div className="inline-flex items-center gap-1.5 mt-3 px-4 py-1.5 rounded-full font-display text-[13px] tracking-[0.2em] text-night anim-pop-in" style={{ background: "linear-gradient(135deg,#ffd166,#ff9a3d)", boxShadow: "0 6px 24px rgba(255,209,102,0.4)" }}>
                  <Star size={14} /> NEW BEST SCORE
                </div>
              )}
            </div>

            {/* stats */}
            <div className="panel-glass rounded-2xl p-5 anim-slide-up">
              <div className="grid grid-cols-3 gap-2 text-center mb-4">
                <div className="rounded-xl bg-white/4 py-3">
                  <div className="font-display text-3xl text-volt">{result.kills}</div>
                  <div className="font-ui text-[11px] font-bold tracking-[0.22em] text-white/50">ELIMINATIONS</div>
                </div>
                <div className="rounded-xl bg-white/4 py-3">
                  <div className="font-display text-3xl text-white">#{result.placement}<span className="text-sm text-white/40">/{result.total}</span></div>
                  <div className="font-ui text-[11px] font-bold tracking-[0.22em] text-white/50">PLACEMENT</div>
                </div>
                <div className="rounded-xl bg-white/4 py-3">
                  <div className="font-display text-3xl text-sky-300">{Math.floor(result.time / 60)}:{String(Math.floor(result.time % 60)).padStart(2, "0")}</div>
                  <div className="font-ui text-[11px] font-bold tracking-[0.22em] text-white/50">SURVIVED</div>
                </div>
              </div>
              <div className="flex flex-col gap-1.5 font-ui text-[14px] font-semibold border-t border-white/8 pt-3">
                <div className="flex justify-between text-white/70"><span className="flex items-center gap-2"><Skull size={13} className="text-volt" /> Eliminations × {result.kills}</span><span>+{(result.kills * 150).toLocaleString()}</span></div>
                <div className="flex justify-between text-white/70"><span className="flex items-center gap-2"><Users size={13} className="text-sky-300" /> Placement bonus</span><span>+{result.placeBonus.toLocaleString()}</span></div>
                {result.winBonus > 0 && <div className="flex justify-between text-sun"><span className="flex items-center gap-2"><Crown size={13} /> Victory bonus</span><span>+{result.winBonus.toLocaleString()}</span></div>}
                <div className="flex justify-between text-white text-[17px] font-display tracking-wider border-t border-white/10 mt-1 pt-2"><span>TOTAL SCORE</span><span className="title-gradient">{result.score.toLocaleString()}</span></div>
              </div>
            </div>

            {/* high scores */}
            <div className="panel-glass rounded-2xl p-4 mt-3 anim-slide-up" style={{ animationDelay: "0.08s" }}>
              <div className="font-display text-[11px] tracking-[0.24em] text-white/70 mb-2 flex items-center gap-2"><Trophy size={12} className="text-sun" /> LOCAL LEADERBOARD</div>
              <div className="flex flex-col gap-1">
                {scores.slice(0, 5).map((s, i) => (
                  <div key={i} className={`flex items-center gap-2 font-ui text-[13px] font-semibold ${newBest && i === 0 ? "text-sun" : "text-white/75"}`}>
                    <span className="w-4 text-center font-display text-[11px] opacity-70">{i + 1}</span>
                    <span className="flex-1">{s.score.toLocaleString()}</span>
                    <span className="text-white/40">{s.kills} K</span>
                    <span className="text-white/40">#{s.place}</span>
                    <span className="text-[10px] tracking-widest px-1.5 py-0.5 rounded bg-white/8 text-white/50">{s.diff}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* actions */}
            <div className="flex gap-2.5 mt-4 anim-slide-up" style={{ animationDelay: "0.14s" }}>
              <button onClick={restart} className="btn-neon flex-1 font-display rounded-xl px-6 py-4 text-night tracking-[0.16em] flex items-center justify-center gap-2" style={{ background: "linear-gradient(135deg,#3df5c4,#8be9ff)", boxShadow: "0 10px 34px rgba(61,245,196,0.4)" }}>
                <RotateCcw size={18} /> {isTouch ? "PLAY AGAIN" : "PLAY AGAIN — R"}
              </button>
              <button onClick={toMenu} className="btn-neon panel-glass font-display rounded-xl px-6 py-4 text-white tracking-[0.16em] flex items-center justify-center gap-2">
                <Home size={18} /> MENU
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ==================== SETTINGS MODAL ==================== */}
      {showSettings && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-night/70 backdrop-blur-md" onClick={() => setShowSettings(false)}>
          <div className="panel-glass rounded-2xl p-6 w-[min(92vw,400px)] anim-pop-in" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <div className="font-display text-xl text-white tracking-wider">SETTINGS</div>
              <button onClick={() => setShowSettings(false)} className="text-white/50 hover:text-white cursor-pointer"><X size={18} /></button>
            </div>
            <div className="flex flex-col gap-5">
              <div>
                <div className="flex items-center justify-between font-ui text-[13px] font-bold tracking-[0.18em] text-white/70 mb-2">
                  <span className="flex items-center gap-2"><MousePointer2 size={13} className="text-volt" /> SENSITIVITY</span>
                  <span className="text-volt">{prefs.sensitivity.toFixed(2)}×</span>
                </div>
                <input type="range" min={0.4} max={2.2} step={0.05} value={prefs.sensitivity} onChange={(e) => savePrefs({ sensitivity: parseFloat(e.target.value) })} className="w-full accent-teal-300" />
              </div>
              <div>
                <div className="flex items-center justify-between font-ui text-[13px] font-bold tracking-[0.18em] text-white/70 mb-2">
                  <span className="flex items-center gap-2"><Volume2 size={13} className="text-volt" /> VOLUME</span>
                  <span className="text-volt">{Math.round(prefs.volume * 100)}%</span>
                </div>
                <input type="range" min={0} max={1} step={0.05} value={prefs.volume} onChange={(e) => savePrefs({ volume: parseFloat(e.target.value) })} className="w-full accent-teal-300" />
              </div>
              <div>
                <div className="font-ui text-[13px] font-bold tracking-[0.18em] text-white/70 mb-2 flex items-center gap-2"><Gauge size={13} className="text-volt" /> QUALITY</div>
                <div className="grid grid-cols-4 gap-2">
                  {["bare", "min", "low", "high"].map((q) => (
                    <button
                      key={q}
                      onClick={() => savePrefs({ quality: q })}
                      className={`font-display text-[11px] tracking-[0.14em] rounded-lg py-2.5 border transition-all cursor-pointer ${prefs.quality === q ? "text-night border-transparent" : "text-white/60 border-white/15 hover:border-white/30"}`}
                      style={prefs.quality === q ? { background: "linear-gradient(135deg,#3df5c4,#8be9ff)" } : {}}
                    >
                      {q.toUpperCase()}
                    </button>
                  ))}
                </div>
                <div className="font-ui text-[11px] text-white/35 font-medium mt-1.5">LOW drops shadows. MIN cuts resolution & draw distance. BARE strips clouds, fog distance and most effects — ugly but fast on anything.</div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
