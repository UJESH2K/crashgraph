"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { Toolbar } from "@/components/shell/Toolbar";
import { StatusBar } from "@/components/shell/StatusBar";
import { LanderTag } from "@/components/hud/LanderTag";
import { Banner } from "@/components/hud/Banner";
import { ViewStamp } from "@/components/hud/ViewStamp";
import { LiveMemoryMap } from "@/components/hud/LiveMemoryMap";
import { useConfirm } from "@/components/hud/Dialog";
import { Panel } from "@/components/panel/Panel";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { Analysis } from "@/components/analysis/Analysis";
import { SceneGuard } from "@/components/scene/SceneGuard";
import { api, fetchExplain, loadCurveInto, useConsole } from "@/lib/console";
import { store } from "@/lib/store";
import { hudBus } from "@/lib/hudbus";
import type { Explanation, Frame, Stage, Terrain } from "@/lib/types";
import s from "./page.module.css";

// WebGL cannot render on the server, and both scenes reach for window on mount.
const Scene = dynamic(() => import("@/components/scene/Scene").then(m => m.Scene), {
  ssr: false, loading: () => null,
});
const MemoryStage = dynamic(
  () => import("@/components/memory/MemoryStage").then(m => m.MemoryStage),
  { ssr: false, loading: () => null },
);

const STAGES: Stage[] = ["flight", "memory", "analysis"];

const Caret = ({ dir }: { dir: "left" | "right" }) => (
  <svg viewBox="0 0 7 11" aria-hidden="true">
    <path
      d={dir === "left" ? "M5.4 1L1 5.5l4.4 4.5" : "M1.6 1L6 5.5 1.6 10"}
      fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round"
    />
  </svg>
);

export default function Page() {
  const { state, curve, log } = useConsole();
  const { ask, node: dialog } = useConfirm();

  const [free, setFree] = useState(false);
  const [stage, setStage] = useState<Stage>("flight");
  const [selected, setSelected] = useState<number | null>(null);
  const [explanation, setExplanation] = useState<Explanation | null>(null);
  const [reactor, setReactor] = useState({ on: false, available: false, message: "" });
  /* Either rail can be put away so the flight has the window to itself, which is what you
     want when showing this to a room; the handles at the edges of the view bring it back. */
  const [rails, setRails] = useState({ left: true, right: true });
  const toggleRail = useCallback(
    (side: "left" | "right") => setRails(r => ({ ...r, [side]: !r[side] })), []);
  const replay = useRef<{ frames: Frame[]; i: number; timer: number } | null>(null);

  /* /#memory and /#analysis open straight onto that stage, which is usually what a reviewer
     following a link wants; the hash then tracks whatever they switch to. */
  useEffect(() => {
    const read = () => {
      const h = window.location.hash.replace("#", "") as Stage;
      if (STAGES.includes(h)) setStage(h);
    };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);

  const go = useCallback((next: Stage) => {
    setStage(next);
    const url = next === "flight" ? window.location.pathname : `#${next}`;
    window.history.replaceState(null, "", url);
  }, []);

  /* first load: the curve for whichever world the console is already on */
  const world = state?.world.key;
  useEffect(() => { if (world) loadCurveInto(world); }, [world]);

  /* keep the newest finished attempt explained unless the viewer picked one */
  const lastN = curve.at(-1)?.n ?? null;
  useEffect(() => {
    if (lastN === null) return;
    if (selected !== null && selected !== lastN - 1) return;
    setSelected(lastN);
  }, [lastN, selected]);

  useEffect(() => {
    if (selected === null) return;
    let live = true;
    fetchExplain(selected).then(x => { if (live) setExplanation(x); });
    return () => { live = false; };
  }, [selected]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (["INPUT", "SELECT", "TEXTAREA"].includes(t.tagName) || e.metaKey || e.ctrlKey) return;
      if (e.key === "[") { e.preventDefault(); toggleRail("left"); }
      if (e.key === "]") { e.preventDefault(); toggleRail("right"); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleRail]);

  useEffect(() => {
    fetch(api("/api/reactor")).then(r => r.json())
      .then(d => setReactor(r => ({ ...r, available: !!d.available, message: d.message ?? "" })))
      .catch(() => {});
  }, []);

  /* replay a recorded attempt through the same channel the live frames use */
  const playReplay = useCallback(async (n: number, mode = "Replay") => {
    const r = await fetch(api(`/api/frames/${n}`));
    if (!r.ok) return;
    const d: { terrain: Terrain; frames: Frame[] } = await r.json();
    if (replay.current) window.clearInterval(replay.current.timer);
    store.emitReset(d.terrain, n, state?.world.key ?? "luna", false);
    hudBus.tele.mode = mode;
    const timer = window.setInterval(() => {
      const r2 = replay.current;
      if (!r2) return;
      if (r2.i >= r2.frames.length) {
        window.clearInterval(r2.timer);
        replay.current = null;
        hudBus.tele.mode = "Live";
        return;
      }
      store.emitFrame(r2.frames[r2.i], r2.i);
      r2.i += 1;
    }, 20);
    replay.current = { frames: d.frames, i: 0, timer };
  }, [state?.world.key]);

  /* picking an attempt replays it, which only makes sense on the flight stage */
  /* At full training speed the trainer sends no frames at all — the physics is the point and
     the socket would be the bottleneck. That used to leave the viewport frozen on whatever was
     last drawn, which reads as a broken page rather than a deliberate trade. So the console
     plays back the recording of each attempt as it finishes: one at a time, always the newest
     one available, so what you are watching is real and recent even though it is not live. */
  const speed = state?.speed;
  useEffect(() => {
    if (speed !== "train" || lastN === null || replay.current) return;
    playReplay(lastN, "Replay · full speed");
  }, [speed, lastN, playReplay]);

  const pick = useCallback((n: number) => {
    setSelected(n);
    if (stage === "flight") playReplay(n);
  }, [playReplay, stage]);

  useEffect(() => () => { if (replay.current) window.clearInterval(replay.current.timer); }, []);

  const accent = { luna: "#8fb4dc", ares: "#e0855a", titan: "#d7b25c" }[world ?? "luna"] ?? "#8fb4dc";
  const onFlight = stage === "flight";

  return (
    <div
      className={s.shell}
      style={{
        ["--accent" as string]: accent,
        gridTemplateColumns:
          `${rails.left ? "var(--rail-l)" : "0px"} minmax(0, 1fr) ${rails.right ? "var(--rail-r)" : "0px"}`,
      }}
    >
      <div className={s.bar}>
        <Toolbar
          stage={stage}
          onStage={go}
          reactorOn={reactor.on}
          reactorAvailable={reactor.available}
          reactorMessage={reactor.message || "Reactor is not configured"}
          onReactor={() => setReactor(r => ({ ...r, on: !r.on }))}
          rails={rails}
          onRails={toggleRail}
        />
      </div>

      <aside className={`${s.left} ${rails.left ? "" : s.gone}`}>
        <Sidebar monitor={stage !== "flight"} />
      </aside>

      <div className={s.view}>
        {/* the flight canvas is never unmounted: switching stages must not cost a WebGL
            context, the loaded models, the camera, or a replay halfway through */}
        <div className={s.flight}>
          <SceneGuard>
            <Scene free={free} onTakeOver={() => setFree(true)} paused={!onFlight} />
          </SceneGuard>
        </div>

        {onFlight && (
          <>
            <ViewStamp />
            <LiveMemoryMap />
            <LanderTag hidden={false} />
            <Banner />
            {free && (
              <div className={s.camhint}>
                <span>Free look</span>
                <button className="link" onClick={() => setFree(false)}>follow the lander</button>
              </div>
            )}
          </>
        )}

        {stage === "memory" && (
          <div className={s.overlay}>
            <SceneGuard><MemoryStage selected={selected} /></SceneGuard>
          </div>
        )}

        {stage === "analysis" && (
          <div className={s.overlay}><Analysis onClose={() => go("flight")} /></div>
        )}

        <button
          className={`${s.handle} ${s.handleL}`}
          onClick={() => toggleRail("left")}
          aria-label={rails.left ? "Hide the left panel" : "Show the left panel"}
          title={`${rails.left ? "Hide" : "Show"} the left panel  ( [ )`}
        >
          <Caret dir={rails.left ? "left" : "right"} />
        </button>
        <button
          className={`${s.handle} ${s.handleR}`}
          onClick={() => toggleRail("right")}
          aria-label={rails.right ? "Hide the right panel" : "Show the right panel"}
          title={`${rails.right ? "Hide" : "Show"} the right panel  ( ] )`}
        >
          <Caret dir={rails.right ? "right" : "left"} />
        </button>

        {log && <p className={s.log}>{log}</p>}
      </div>

      <aside className={`${s.right} ${rails.right ? "" : s.gone}`}>
        <Panel explanation={explanation} selected={selected} onPick={pick} onConfirm={ask} />
      </aside>

      <div className={s.status}><StatusBar /></div>

      {dialog}
    </div>
  );
}
