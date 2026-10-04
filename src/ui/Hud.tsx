// ============================================================
// Hud.tsx — in-game overlay: bars, ammo, minimap, killfeed,
// crosshair, banners, touch controls (mobile)
// ============================================================
import { useEffect, useRef } from "react";
import {
  Heart, Shield, Users, Skull, CloudLightning, Crosshair, Box, Layers, Triangle,
  Target, OctagonAlert,
} from "lucide-react";

const MODES = [
  { key: 0, label: "GUN", icon: Crosshair },
  { key: 1, label: "WALL", icon: Box },
  { key: 2, label: "FLOOR", icon: Layers },
  { key: 3, label: "RAMP", icon: Triangle },
];

export interface FeedItem {
  id: number;
  killer: string;
  victim: string;
  you: boolean;
  elite: boolean;
}

interface HudProps {
  dataRef: React.MutableRefObject<any>;
  killfeed: FeedItem[];
  countdown: number | null;
  streak: string | null;
  stormMsg: string | null;
  isTouch: boolean;
}

export default function Hud({ dataRef, killfeed, countdown, streak, stormMsg, isTouch }: HudProps) {
  const hpBar = useRef<HTMLDivElement>(null);
  const shBar = useRef<HTMLDivElement>(null);
  const hpText = useRef<HTMLSpanElement>(null);
  const ammoText = useRef<HTMLSpanElement>(null);
  const ammoWrap = useRef<HTMLSpanElement>(null);
  const killsText = useRef<HTMLSpanElement>(null);
  const aliveText = useRef<HTMLSpanElement>(null);
  const scoreText = useRef<HTMLSpanElement>(null);
  const stormText = useRef<HTMLSpanElement>(null);
  const stormIcon = useRef<HTMLSpanElement>(null);
  const stormPill = useRef<HTMLDivElement>(null);
  const crosshair = useRef<HTMLDivElement>(null);
  const chArms = [useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null)];
  const modeRow = useRef<HTMLDivElement>(null);
  const stormVeil = useRef<HTMLDivElement>(null);
  const lowHpVeil = useRef<HTMLDivElement>(null);
  const mapCanvas = useRef<HTMLCanvasElement>(null);
  const dmgVeil = useRef<HTMLDivElement>(null);
  const hitLayer = useRef<HTMLDivElement>(null);
  const gunName = useRef<HTMLDivElement>(null);
  const magText = useRef<HTMLSpanElement>(null);
  const slotEls = [useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null)];
  const promptEl = useRef<HTMLDivElement>(null);
  const promptMain = useRef<HTMLSpanElement>(null);
  const promptSub = useRef<HTMLSpanElement>(null);
  const reloadRing = useRef<HTMLDivElement>(null);
  const slideVeil = useRef<HTMLDivElement>(null);
  const speedEl = useRef<HTMLDivElement>(null);

  // ---------- imperative fast HUD loop ----------
  useEffect(() => {
    const iv = setInterval(() => {
      const d = dataRef.current;
      if (!d) return;
      if (hpBar.current) hpBar.current.style.width = `${Math.max(0, d.hp)}%`;
      if (shBar.current) shBar.current.style.width = `${Math.max(0, d.shield)}%`;
      if (hpText.current) hpText.current.textContent = `${Math.ceil(Math.max(0, d.hp))}`;
      if (ammoText.current) {
        ammoText.current.textContent = d.reloading ? "--" : `${d.ammo}`;
        ammoText.current.style.color = d.reloading ? "#ffd166" : d.ammo === 0 ? "#ff5f6d" : "#ffffff";
      }
      if (magText.current) magText.current.textContent = `/ ${d.magSize}`;
      if (ammoWrap.current) ammoWrap.current.style.opacity = d.mode === 0 ? "1" : "0.25";
      if (gunName.current) {
        gunName.current.textContent = d.reloading ? "RELOADING…" : d.gunName;
        gunName.current.style.color = d.reloading ? "#ffd166" : d.gunRarity;
      }
      if (reloadRing.current) {
        reloadRing.current.style.opacity = d.reloading ? "1" : "0";
        reloadRing.current.style.width = `${Math.round((d.reloadPct || 0) * 100)}%`;
      }
      // weapon slots
      for (let i = 0; i < 2; i++) {
        const el = slotEls[i].current;
        if (!el) continue;
        const s = i === 0 ? d.slot0 : d.slot1;
        const active = d.slot === i && d.mode === 0;
        el.style.opacity = s ? "1" : "0.3";
        el.style.borderColor = active && s ? s.css : "rgba(255,255,255,0.12)";
        el.style.background = active && s ? `${s.css}22` : "rgba(10,14,30,0.5)";
        el.style.transform = active ? "translateY(-3px)" : "translateY(0)";
        const nameEl = el.querySelector(".slot-name") as HTMLElement | null;
        const ammoEl = el.querySelector(".slot-ammo") as HTMLElement | null;
        if (nameEl) { nameEl.textContent = s ? s.name : "EMPTY"; nameEl.style.color = s ? s.css : "rgba(255,255,255,0.35)"; }
        if (ammoEl) ammoEl.textContent = s ? `${s.ammo}` : "";
      }
      // interaction prompt
      if (promptEl.current) {
        const p = d.prompt;
        promptEl.current.style.opacity = p ? "1" : "0";
        promptEl.current.style.transform = p ? "translate(-50%,0) scale(1)" : "translate(-50%,8px) scale(0.94)";
        if (p) {
          promptEl.current.style.borderColor = p.css + "99";
          if (promptMain.current) { promptMain.current.textContent = p.label; promptMain.current.style.color = p.css; }
          if (promptSub.current) {
            promptSub.current.textContent = p.kind === "chest" ? "HOLDS A WEAPON"
              : p.kind === "edit" ? p.sub
              : (p.swap ? `${p.sub} · SWAPS HELD GUN` : p.sub);
          }
          const keyEl = promptEl.current.querySelector(".prompt-key") as HTMLElement | null;
          if (keyEl) {
            keyEl.textContent = p.kind === "editing"
              ? (isTouch ? "DRAG" : "LMB")
              : p.kind === "edit" ? (isTouch ? "✎" : "G")
              : (isTouch ? "TAP" : "F");
          }
        }
      }
      if (killsText.current) killsText.current.textContent = `${d.kills}`;
      if (aliveText.current) aliveText.current.textContent = `${d.alive}`;
      if (scoreText.current) scoreText.current.textContent = `${d.score}`;
      if (stormText.current) {
        stormText.current.textContent =
          d.stormState === "shrink" ? "STORM SHRINKING" : d.stormT < 9999 ? `SHRINK IN ${d.stormT}s` : "FINAL CIRCLE";
      }
      if (stormPill.current) {
        stormPill.current.classList.toggle("border-red-400/60", !!d.inStorm);
        stormPill.current.classList.toggle("text-red-300", !!d.inStorm);
      }
      if (stormVeil.current) stormVeil.current.style.opacity = d.inStorm ? "1" : "0";
      if (slideVeil.current) {
        // speed-lines intensify with actual velocity
        const k = Math.max(0, Math.min(1, ((d.speed || 0) - 6) / 16));
        slideVeil.current.style.opacity = d.sliding ? String(0.25 + k * 0.75) : "0";
      }
      if (speedEl.current) {
        const fast = d.sliding || (d.speed || 0) > 9.2;
        speedEl.current.style.opacity = fast ? "1" : "0";
        speedEl.current.style.transform = `translate(-50%,0) scale(${fast ? 1 : 0.85})`;
        const sp = d.speed || 0;
        speedEl.current.textContent = `${sp.toFixed(1)} m/s`;
        speedEl.current.style.color = sp > 18 ? "#ff7a3d" : sp > 12 ? "#ffd166" : "#b464ff";
      }
      if (lowHpVeil.current) lowHpVeil.current.style.opacity = d.hp > 0 && d.hp < 32 ? String(0.45 + 0.25 * Math.sin(performance.now() / 180)) : "0";
      // crosshair spread
      const spreadPx = 8 + ((d.spread || 0.011) - 0.011) * 2600 + (d.aiming ? -3 : 0);
      const s = Math.max(5, Math.min(30, spreadPx));
      for (let i = 0; i < 4; i++) {
        const el = chArms[i].current;
        if (!el) continue;
        if (i === 0) el.style.transform = `translate(-50%, -100%) translateY(-${s}px)`;
        if (i === 1) el.style.transform = `translate(-50%, 0%) translateY(${s}px)`;
        if (i === 2) el.style.transform = `translate(-100%, -50%) translateX(-${s}px)`;
        if (i === 3) el.style.transform = `translate(0%, -50%) translateX(${s}px)`;
      }
      if (crosshair.current) crosshair.current.style.opacity = d.mode === 0 ? "1" : "0.35";
      // build mode highlight
      if (modeRow.current) {
        const kids = modeRow.current.children;
        for (let i = 0; i < kids.length; i++) {
          const el = kids[i] as HTMLElement;
          const active = i === d.mode;
          el.classList.toggle("border-volt", active);
          el.classList.toggle("text-volt", active);
          el.classList.toggle("bg-volt/15", active);
          el.style.transform = active ? "translateY(-4px)" : "translateY(0)";
        }
      }
      drawMap(d);
    }, 66);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const drawMap = (d: any) => {
    const cv = mapCanvas.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const S = cv.width;
    const c = S / 2;
    const scale = S / 2 / 275; // world 275 -> half canvas
    const toMap = (x: number, z: number) => [c + x * scale, c + z * scale];
    ctx.clearRect(0, 0, S, S);
    // base
    ctx.save();
    ctx.beginPath();
    ctx.arc(c, c, c - 1, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = "rgba(8,12,28,0.72)";
    ctx.fillRect(0, 0, S, S);
    // island blob
    ctx.beginPath();
    ctx.arc(c, c, 250 * scale, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(56,92,64,0.75)";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(c, c, 120 * scale, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(64,104,72,0.8)";
    ctx.fill();
    // storm wash
    ctx.fillStyle = "rgba(163,91,255,0.30)";
    ctx.fillRect(0, 0, S, S);
    // safe zone cut-out
    ctx.globalCompositeOperation = "destination-out";
    ctx.beginPath();
    const [zx, zz] = toMap(d.zx, d.zz);
    ctx.arc(zx, zz, Math.max(2, d.zr * scale), 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = "source-over";
    // current circle
    ctx.beginPath();
    ctx.arc(zx, zz, Math.max(2, d.zr * scale), 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = 2;
    ctx.stroke();
    // next circle
    const [nx, nz] = toMap(d.nzx, d.nzz);
    ctx.beginPath();
    ctx.arc(nx, nz, Math.max(1.5, d.nzr * scale), 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(61,245,196,0.65)";
    ctx.lineWidth = 1.2;
    ctx.stroke();
    // pings
    if (d.pings) {
      for (const p of d.pings) {
        const [px, pz] = toMap(p.x, p.z);
        ctx.beginPath();
        ctx.arc(px, pz, 2.6, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255,122,61,0.95)";
        ctx.fill();
      }
    }
    // player arrow
    const [px, pz] = toMap(d.px, d.pz);
    ctx.translate(px, pz);
    ctx.rotate(-d.pyaw);
    ctx.beginPath();
    ctx.moveTo(0, -6);
    ctx.lineTo(4.4, 5);
    ctx.lineTo(0, 2.6);
    ctx.lineTo(-4.4, 5);
    ctx.closePath();
    ctx.fillStyle = "#3df5c4";
    ctx.strokeStyle = "#06281f";
    ctx.lineWidth = 1.4;
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  };

  return (
    <div className="pointer-events-none absolute inset-0 font-ui">
      {/* storm damage veil */}
      <div
        ref={stormVeil}
        className="absolute inset-0 transition-opacity duration-300"
        style={{
          opacity: 0,
          background: "radial-gradient(ellipse at center, transparent 42%, rgba(163,91,255,0.42) 100%)",
          animation: "stormPulse 1.6s ease-in-out infinite",
        }}
      />
      {/* slide speed-lines */}
      <div
        ref={slideVeil}
        className="absolute inset-0"
        style={{
          opacity: 0,
          transition: "opacity 0.16s",
          background: "radial-gradient(ellipse at center, transparent 34%, rgba(160,120,255,0.26) 86%, rgba(190,150,255,0.4) 100%)",
        }}
      />
      {/* low hp veil */}
      <div
        ref={lowHpVeil}
        className="absolute inset-0"
        style={{ opacity: 0, background: "radial-gradient(ellipse at center, transparent 46%, rgba(255,30,40,0.5) 100%)", transition: "opacity 0.15s" }}
      />
      {/* damage flash veil */}
      <div
        ref={dmgVeil}
        id="dmg-veil"
        className="absolute inset-0"
        style={{ opacity: 0, background: "radial-gradient(ellipse at center, rgba(255,40,50,0.12) 52%, rgba(255,20,30,0.5) 100%)" }}
      />
      {/* hitmarker layer */}
      <div ref={hitLayer} id="hit-layer" className="absolute inset-0 overflow-hidden" />

      {/* crosshair */}
      <div ref={crosshair} className="hud-crosshair">
        <div className="ch-dot" />
        <div ref={chArms[0]} className="ch" style={{ width: 2, height: 7, left: "50%", top: "50%" }} />
        <div ref={chArms[1]} className="ch" style={{ width: 2, height: 7, left: "50%", top: "50%" }} />
        <div ref={chArms[2]} className="ch" style={{ width: 7, height: 2, left: "50%", top: "50%" }} />
        <div ref={chArms[3]} className="ch" style={{ width: 7, height: 2, left: "50%", top: "50%" }} />
      </div>

      {/* top center: storm + alive + kills */}
      <div className="absolute top-3 left-1/2 -translate-x-1/2 flex items-center gap-2">
        <div ref={stormPill} className="panel-glass rounded-full px-3.5 py-1.5 flex items-center gap-2 text-[13px] font-semibold tracking-wider text-storm transition-colors" style={{ borderColor: "rgba(163,91,255,0.35)" }}>
          <span ref={stormIcon}><CloudLightning size={15} /></span>
          <span ref={stormText}>SHRINK IN 20s</span>
        </div>
        <div className="panel-glass rounded-full px-3.5 py-1.5 flex items-center gap-2 text-[13px] font-semibold tracking-wider text-white">
          <Users size={15} className="text-sky-300" />
          <span ref={aliveText}>51</span>
        </div>
        <div className="panel-glass rounded-full px-3.5 py-1.5 flex items-center gap-2 text-[13px] font-semibold tracking-wider text-white">
          <Skull size={15} className="text-blaze" />
          <span ref={killsText}>0</span>
        </div>
      </div>

      {/* killfeed */}
      <div className="absolute top-3 left-3 flex flex-col gap-1.5 max-w-[300px]">
        {killfeed.map((k) => (
          <div
            key={k.id}
            className={`kill-item rounded-md px-2.5 py-1 text-[12.5px] font-semibold tracking-wide flex items-center gap-1.5 backdrop-blur-sm ${
              k.you ? "bg-volt/20 border border-volt/50 text-volt" : "bg-night/60 border border-white/10 text-white/80"
            }`}
          >
            <Target size={12} className={k.you ? "text-volt" : "text-white/50"} />
            <span className={k.you ? "text-volt" : "text-sun"}>{k.killer}</span>
            <span className="text-white/40">▸</span>
            <span className="text-white/85">{k.victim}{k.elite ? " ★" : ""}</span>
          </div>
        ))}
      </div>

      {/* storm banner message */}
      {stormMsg && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 anim-slide-up">
          <div className="panel-glass rounded-lg px-5 py-2 flex items-center gap-2 text-[13px] font-bold tracking-[0.18em] text-storm" style={{ borderColor: "rgba(163,91,255,0.4)" }}>
            <OctagonAlert size={15} />
            {stormMsg}
          </div>
        </div>
      )}

      {/* streak banner */}
      {streak && (
        <div className="absolute top-[24%] left-1/2 -translate-x-1/2 anim-banner">
          <div className="font-display text-4xl md:text-5xl text-sun tracking-wider" style={{ textShadow: "0 0 24px rgba(255,209,102,0.8), 0 4px 0 rgba(0,0,0,0.35)" }}>
            {streak}
          </div>
        </div>
      )}

      {/* countdown */}
      {countdown !== null && (
        <div key={countdown} className="absolute top-[38%] left-1/2 -translate-x-1/2">
          <div
            className={`font-display ${countdown === 0 ? "text-7xl text-volt" : "text-6xl text-white"}`}
            style={{ animation: "countPop 0.5s ease-out both", textShadow: "0 0 30px rgba(61,245,196,0.6), 0 4px 0 rgba(0,0,0,0.4)" }}
          >
            {countdown === 0 ? "GO!" : countdown}
          </div>
        </div>
      )}

      {/* speedometer — appears when you're moving fast */}
      <div
        ref={speedEl}
        className="absolute left-1/2 font-display text-[15px] tracking-[0.18em]"
        style={{
          bottom: isTouch ? "20%" : "17%", opacity: 0, color: "#b464ff",
          transform: "translate(-50%,0) scale(0.85)",
          transition: "opacity .14s, transform .14s, color .2s",
          textShadow: "0 2px 10px rgba(0,0,0,0.85)",
        }}
      >
        0.0 m/s
      </div>

      {/* interaction prompt */}
      <div
        ref={promptEl}
        className="absolute left-1/2 panel-glass rounded-xl px-5 py-2.5 flex items-center gap-3"
        style={{ bottom: isTouch ? "34%" : "26%", opacity: 0, transform: "translate(-50%,8px) scale(0.94)", transition: "opacity .14s, transform .14s" }}
      >
        <div className="prompt-key font-display text-[13px] rounded-md px-2 py-1 bg-white/10 text-white tracking-wider">{isTouch ? "TAP" : "F"}</div>
        <div className="flex flex-col leading-tight">
          <span ref={promptMain} className="font-display text-[14px] tracking-[0.12em] text-white">PICK UP</span>
          <span ref={promptSub} className="font-ui text-[11px] font-bold tracking-[0.16em] text-white/45">WEAPON</span>
        </div>
      </div>

      {/* minimap */}
      <div className={`absolute top-3 right-3 ${isTouch ? "w-[104px] h-[104px]" : "w-[148px] h-[148px]"}`}>
        <canvas ref={mapCanvas} width={isTouch ? 104 : 148} height={isTouch ? 104 : 148} className="rounded-full border border-sky-200/20 shadow-xl w-full h-full" />
      </div>

      {/* bottom left: hp / shield / score */}
      <div className={`absolute ${isTouch ? "bottom-3 left-3" : "bottom-5 left-6"} w-[240px] max-w-[46vw]`}>
        <div className="flex items-center gap-2 mb-1">
          <Shield size={14} className="text-sky-300" />
          <div className="bar-outer rounded-sm h-[9px] flex-1">
            <div ref={shBar} className="bar-fill h-full rounded-sm" style={{ width: "0%", background: "linear-gradient(90deg,#38b6ff,#8be9ff)" }} />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Heart size={15} className="text-volt" />
          <div className="bar-outer rounded-sm h-[14px] flex-1">
            <div ref={hpBar} className="bar-fill h-full rounded-sm" style={{ width: "100%", background: "linear-gradient(90deg,#2ee6a6,#9dffd9)" }} />
          </div>
          <span ref={hpText} className="font-display text-lg text-white w-8 text-right" style={{ textShadow: "0 2px 4px rgba(0,0,0,0.8)" }}>100</span>
        </div>
        <div className="mt-1.5 flex items-center gap-2 text-[12px] font-bold tracking-[0.16em] text-sun">
          <span>SCORE</span>
          <span ref={scoreText} className="text-white font-display text-sm">0</span>
        </div>
      </div>

      {/* bottom right: ammo + weapon slots + build slots */}
      <div className={`absolute ${isTouch ? "bottom-[150px] right-3" : "bottom-5 right-6"} flex flex-col items-end gap-2`}>
        <div ref={gunName} className="font-display text-[13px] tracking-[0.2em]" style={{ color: "#b8c0cc", textShadow: "0 2px 5px rgba(0,0,0,0.8)" }}>PISTOL</div>
        <span ref={ammoWrap} className="flex items-baseline gap-1 text-white" style={{ transition: "opacity .15s" }}>
          <span ref={ammoText} className="font-display text-4xl" style={{ textShadow: "0 2px 6px rgba(0,0,0,0.8)" }}>15</span>
          <span ref={magText} className="text-white/50 font-bold text-sm tracking-widest">/ 15</span>
        </span>
        {/* reload progress */}
        <div className="w-[104px] h-[3px] rounded-full bg-black/50 overflow-hidden" style={{ opacity: 0 }}>
          <div ref={reloadRing} className="h-full rounded-full" style={{ width: "0%", background: "linear-gradient(90deg,#ffd166,#ff9a3d)", transition: "width .06s linear" }} />
        </div>
        {/* weapon slots */}
        <div className="flex gap-1.5">
          {[0, 1].map((i) => (
            <div
              key={i}
              ref={slotEls[i]}
              className="rounded-md border px-2.5 py-1 min-w-[74px] text-right"
              style={{ borderColor: "rgba(255,255,255,0.12)", background: "rgba(10,14,30,0.5)", transition: "all .12s", backdropFilter: "blur(6px)" }}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[9px] font-bold text-white/30">{i + 1}</span>
                <span className="slot-name font-display text-[11px] tracking-wider">EMPTY</span>
              </div>
              <div className="slot-ammo font-ui text-[10px] font-bold text-white/45 text-right" />
            </div>
          ))}
        </div>
        {!isTouch && (
          <div ref={modeRow} className="flex gap-1.5">
            {MODES.map((m, i) => (
              <div
                key={m.key}
                className={`panel-glass rounded-md px-2.5 py-1.5 flex items-center gap-1.5 text-[11px] font-bold tracking-widest text-white/55 border transition-all duration-100 ${i === 0 ? "border-volt text-volt bg-volt/15" : "border-white/10"}`}
                style={{ transition: "transform .12s, color .12s, border-color .12s" }}
              >
                <m.icon size={13} />
                <span className="hidden xl:inline">{m.label}</span>
                <span className="text-[9px] text-white/35">{i === 0 ? "Q" : i}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// TouchControls — rendered on coarse-pointer devices
// ============================================================
export function TouchControls({ game, onPause }: { game: any; onPause: () => void }) {
  const joyZone = useRef<HTMLDivElement>(null);
  const lookZone = useRef<HTMLDivElement>(null);
  const joyBase = useRef<HTMLDivElement>(null);
  const joyNub = useRef<HTMLDivElement>(null);
  const modeBtnRefs = [useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null)];

  useEffect(() => {
    const input = game.input;
    input.touch.active = true;
    const joy = joyZone.current!;
    const look = lookZone.current!;
    let joyId = -1, joyCX = 0, joyCY = 0;
    let lookId = -1, lookLX = 0, lookLY = 0;
    const R = 52;

    const setNub = (dx: number, dy: number, show: boolean) => {
      if (joyBase.current) {
        joyBase.current.style.display = show ? "block" : "none";
        joyBase.current.style.left = joyCX - 60 + "px";
        joyBase.current.style.top = joyCY - 60 + "px";
        joyBase.current.style.width = "120px";
        joyBase.current.style.height = "120px";
      }
      if (joyNub.current) {
        joyNub.current.style.display = show ? "block" : "none";
        joyNub.current.style.left = joyCX + dx - 26 + "px";
        joyNub.current.style.top = joyCY + dy - 26 + "px";
        joyNub.current.style.width = "52px";
        joyNub.current.style.height = "52px";
      }
    };

    const onJoyDown = (e: PointerEvent) => {
      if (joyId >= 0) return;
      joyId = e.pointerId;
      joyCX = e.clientX; joyCY = e.clientY;
      joy.setPointerCapture(e.pointerId);
      setNub(0, 0, true);
    };
    const onJoyMove = (e: PointerEvent) => {
      if (e.pointerId !== joyId) return;
      let dx = e.clientX - joyCX, dy = e.clientY - joyCY;
      const len = Math.hypot(dx, dy);
      if (len > R) { dx = (dx / len) * R; dy = (dy / len) * R; }
      setNub(dx, dy, true);
      const nx = dx / R, ny = dy / R;
      input.touch.mx = nx;
      input.touch.mz = -ny;
      input.touch.sprint = Math.hypot(nx, ny) > 0.9;
    };
    const onJoyUp = (e: PointerEvent) => {
      if (e.pointerId !== joyId) return;
      joyId = -1;
      input.touch.mx = 0; input.touch.mz = 0; input.touch.sprint = false;
      setNub(0, 0, false);
    };
    const onLookDown = (e: PointerEvent) => {
      if (lookId >= 0) return;
      lookId = e.pointerId;
      lookLX = e.clientX; lookLY = e.clientY;
      look.setPointerCapture(e.pointerId);
    };
    const onLookMove = (e: PointerEvent) => {
      if (e.pointerId !== lookId) return;
      input.touch.lookDX += (e.clientX - lookLX) * 2.4;
      input.touch.lookDY += (e.clientY - lookLY) * 2.4;
      lookLX = e.clientX; lookLY = e.clientY;
    };
    const onLookUp = (e: PointerEvent) => {
      if (e.pointerId !== lookId) return;
      lookId = -1;
    };

    joy.addEventListener("pointerdown", onJoyDown);
    joy.addEventListener("pointermove", onJoyMove);
    joy.addEventListener("pointerup", onJoyUp);
    joy.addEventListener("pointercancel", onJoyUp);
    look.addEventListener("pointerdown", onLookDown);
    look.addEventListener("pointermove", onLookMove);
    look.addEventListener("pointerup", onLookUp);
    look.addEventListener("pointercancel", onLookUp);
    return () => {
      input.touch.active = false;
      joy.removeEventListener("pointerdown", onJoyDown);
      joy.removeEventListener("pointermove", onJoyMove);
      joy.removeEventListener("pointerup", onJoyUp);
      joy.removeEventListener("pointercancel", onJoyUp);
      look.removeEventListener("pointerdown", onLookDown);
      look.removeEventListener("pointermove", onLookMove);
      look.removeEventListener("pointerup", onLookUp);
      look.removeEventListener("pointercancel", onLookUp);
    };
  }, [game]);

  const setMode = (m: number) => {
    game.input.modeRequest = m;
    for (let i = 0; i < 4; i++) {
      const el = modeBtnRefs[i].current;
      if (el) el.classList.toggle("active", i === m);
    }
  };

  return (
    <div className="absolute inset-0 z-30" style={{ pointerEvents: "none" }}>
      {/* joystick zone (left 45%) */}
      <div ref={joyZone} className="absolute left-0 top-0 bottom-0 w-[45%]" style={{ pointerEvents: "auto", touchAction: "none" }} />
      {/* look zone (right 55%, upper area) */}
      <div ref={lookZone} className="absolute right-0 top-0 w-[55%] bottom-[30%]" style={{ pointerEvents: "auto", touchAction: "none" }} />
      {/* joystick visuals */}
      <div ref={joyBase} className="joy-base" style={{ display: "none" }} />
      <div ref={joyNub} className="joy-nub" style={{ display: "none" }} />

      {/* buttons */}
      <div className="absolute right-4 bottom-[26px] flex flex-col items-end gap-3" style={{ pointerEvents: "none" }}>
        {/* mode row */}
        <div className="flex gap-2" style={{ pointerEvents: "auto" }}>
          {MODES.map((m, i) => (
            <div
              key={m.key}
              ref={modeBtnRefs[i]}
              className={`touch-btn w-11 h-11 ${i === 0 ? "active" : ""}`}
              onPointerDown={(e) => { e.stopPropagation(); setMode(m.key); }}
            >
              <m.icon size={18} />
            </div>
          ))}
        </div>
        <div className="flex items-end gap-3" style={{ pointerEvents: "auto" }}>
          {/* interact / pick up */}
          <div
            className="touch-btn w-12 h-12 mb-2"
            style={{ borderColor: "rgba(255,209,102,0.55)", color: "#ffd166" }}
            onPointerDown={(e) => { e.stopPropagation(); game.input.interactPressed = true; }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>
          </div>
          {/* swap weapon */}
          <div
            className="touch-btn w-12 h-12 mb-2"
            onPointerDown={(e) => { e.stopPropagation(); game.input.swapPressed = true; }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M7 4L3 8l4 4M3 8h13M17 20l4-4-4-4M21 16H8"/></svg>
          </div>
          {/* slide */}
          <div
            className="touch-btn w-12 h-12 mb-2"
            style={{ borderColor: "rgba(180,100,255,0.6)", color: "#d2a8ff" }}
            onPointerDown={(e) => { e.stopPropagation(); game.input.touch.slidePressed = true; game.input.touch.slideHeld = true; }}
            onPointerUp={() => { game.input.touch.slideHeld = false; }}
            onPointerCancel={() => { game.input.touch.slideHeld = false; }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M3 17h7l4-5 6 2M4 20h16"/><circle cx="16" cy="7" r="2"/></svg>
          </div>
          {/* jump */}
          <div
            className="touch-btn w-14 h-14 mb-2"
            onPointerDown={(e) => { e.stopPropagation(); game.input.touch.jumpPressed = true; game.input.touch.jump = true; }}
            onPointerUp={() => { game.input.touch.jump = false; }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
          </div>
          {/* fire */}
          <div
            className="touch-btn fire w-[76px] h-[76px]"
            onPointerDown={(e) => { e.stopPropagation(); game.input.touch.fire = true; e.currentTarget.setPointerCapture(e.pointerId); }}
            onPointerUp={() => { game.input.touch.fire = false; }}
            onPointerCancel={() => { game.input.touch.fire = false; }}
          >
            <Crosshair size={30} />
          </div>
        </div>
      </div>

      {/* pause + reload */}
      <div className="absolute top-[126px] right-3 flex flex-col gap-2" style={{ pointerEvents: "auto" }}>
        <div className="touch-btn w-10 h-10" onPointerDown={(e) => { e.stopPropagation(); onPause(); }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
        </div>
        <div className="touch-btn w-10 h-10" onPointerDown={(e) => { e.stopPropagation(); game.input.reloadPressed = true; }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6"/></svg>
        </div>
        {/* edit build */}
        <div
          className="touch-btn w-10 h-10"
          style={{ borderColor: "rgba(255,209,102,0.6)", color: "#ffd166" }}
          onPointerDown={(e) => { e.stopPropagation(); game.input.touch.editPressed = true; }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
        </div>
      </div>
    </div>
  );
}
