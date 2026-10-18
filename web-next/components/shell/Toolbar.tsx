"use client";

import { useEffect, useState } from "react";
import { loadCurveInto, send, useConsole, worldPhysics } from "@/lib/console";
import { LanderMark } from "@/components/hud/LanderMark";
import { ThemeToggle } from "./ThemeToggle";
import type { Stage } from "@/lib/types";
import s from "./Toolbar.module.css";

/**
 * One bar for everything that steers the console: which world, whether it is flying, how fast,
 * and which of the three stages is on the screen.
 *
 * This replaces the floating pill dock the console used to carry over the 3D view. A control
 * that sits on top of the flight has to be translucent to avoid hiding it, and a translucent
 * control over a moving scene is hard to read and harder to hit. Docking the controls gives the
 * viewport a rectangle of its own that nothing is ever drawn over.
 */

const SPEEDS = [
  { id: "watch", label: "Watch", hint: "Real time" },
  { id: "fast", label: "Fast", hint: "About five times real time" },
  { id: "train", label: "Train", hint: "Full speed; the view shows the latest finished attempt" },
] as const;

const STAGES: { id: Stage; label: string; hint: string }[] = [
  { id: "flight", label: "Flight", hint: "Watch the lander fly" },
  { id: "memory", label: "Memory", hint: "The graph it flies on, in 3D, growing as it learns" },
  { id: "analysis", label: "Analysis", hint: "The write-up, with every number's source" },
];

const PanelIcon = ({ side }: { side: "left" | "right" }) => (
  <svg viewBox="0 0 14 12" aria-hidden="true">
    <rect x=".7" y=".7" width="12.6" height="10.6" rx="1.4"
      fill="none" stroke="currentColor" strokeWidth="1.2" />
    <rect x={side === "left" ? 0.7 : 9.1} y=".7" width="4.2" height="10.6"
      fill="currentColor" opacity=".75" />
  </svg>
);

const Chevron = () => (
  <svg viewBox="0 0 10 6" className={s.chev} aria-hidden="true">
    <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" />
  </svg>
);

export function Toolbar({
  stage, onStage, reactorOn, onReactor, reactorAvailable, reactorMessage, rails, onRails,
}: {
  stage: Stage;
  onStage: (s: Stage) => void;
  reactorOn: boolean;
  onReactor: () => void;
  reactorAvailable: boolean;
  reactorMessage: string;
  rails: { left: boolean; right: boolean };
  onRails: (side: "left" | "right") => void;
}) {
  const { state, connection } = useConsole();
  const [open, setOpen] = useState(false);

  const ro = !!state?.read_only;
  const running = !!state?.running;
  const paused = !!state?.paused;

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [open]);

  // Space starts and stops the trainer; the digits jump between stages. Both are ignored while
  // a field has focus, so typing a snapshot name never launches anything.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (["INPUT", "SELECT", "TEXTAREA"].includes(t.tagName) || e.metaKey || e.ctrlKey) return;
      if (e.code === "Space" && !ro) {
        e.preventDefault();
        send(!running ? "run" : paused ? "resume" : "pause");
      }
      const i = ["Digit1", "Digit2", "Digit3"].indexOf(e.code);
      if (i >= 0) { e.preventDefault(); onStage(STAGES[i].id); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [running, paused, ro, onStage]);

  return (
    <header className={s.bar}>
      <div className={s.brand}>
        <span className={s.mark}><LanderMark size={18} /></span>
        <b>crashgraph</b>
      </div>

      <span className={s.sep} aria-hidden="true" />

      <div className={s.world}>
        <button
          className={s.worldBtn}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={e => { e.stopPropagation(); setOpen(o => !o); }}
        >
          <span>{state?.world.name ?? "—"}</span>
          <small className={s.hideSm}>{state ? worldPhysics(state.world) : ""}</small>
          <Chevron />
        </button>
        {open && state && (
          <div className={s.menu} role="menu" onClick={e => e.stopPropagation()}>
            {state.worlds.map(w => (
              <button
                key={w.key}
                role="menuitemradio"
                aria-checked={w.key === state.world.key}
                title={w.blurb}
                onClick={() => {
                  setOpen(false);
                  if (w.key === state.world.key) return;
                  send("set_world", w.key);
                  setTimeout(() => loadCurveInto(w.key), 800);
                }}
              >
                {w.name}
                <small>{worldPhysics(w)}</small>
              </button>
            ))}
          </div>
        )}
      </div>

      <span className={s.sep} aria-hidden="true" />

      <div className={s.grp}>
        <button
          className={`${s.tool} ${s.primary}`}
          disabled={ro}
          title="Start or pause the trainer (space)"
          onClick={() => send(!running ? "run" : paused ? "resume" : "pause")}
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d={!running || paused ? "M3 2l7 4-7 4z" : "M3 2h2v8H3zM7 2h2v8H7z"} fill="currentColor" />
          </svg>
          <span>{!running ? "Start" : paused ? "Resume" : "Pause"}</span>
        </button>
        <button
          className={s.tool}
          disabled={ro || !running}
          aria-label="Interrupt this attempt"
          title="End this attempt now; what it saw is still written to the graph"
          onClick={() => send("interrupt")}
        >
          <svg viewBox="0 0 12 12" aria-hidden="true"><rect x="3" y="3" width="6" height="6" fill="currentColor" /></svg>
        </button>
      </div>

      <span className={`${s.sep} ${s.hideMd}`} aria-hidden="true" />

      <div className={`${s.grp} ${s.hideMd}`}>
        <button className={s.tool} disabled={ro} aria-label="Gust pushing left"
          title="Shove the lander left mid-flight" onClick={() => send("gust", -1)}>
          <svg viewBox="0 0 14 12" aria-hidden="true">
            <path d="M9 2L4 6l5 4" fill="none" stroke="currentColor" strokeWidth="1.6"
              strokeLinecap="round" strokeLinejoin="round" />
            <path d="M12 6H4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
        <button className={s.tool} disabled={ro} aria-label="Gust pushing right"
          title="Shove the lander right mid-flight" onClick={() => send("gust", 1)}>
          <svg viewBox="0 0 14 12" aria-hidden="true">
            <path d="M5 2l5 4-5 4" fill="none" stroke="currentColor" strokeWidth="1.6"
              strokeLinecap="round" strokeLinejoin="round" />
            <path d="M2 6h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <span className={s.sep} aria-hidden="true" />

      <div className={s.seg} role="radiogroup" aria-label="Speed">
        {SPEEDS.map(sp => (
          <button key={sp.id} role="radio" aria-checked={state?.speed === sp.id} title={sp.hint}
            onClick={() => send("set_speed", sp.id)}>
            {sp.label}
          </button>
        ))}
      </div>

      <span className={s.sep} aria-hidden="true" />

      <div className={s.grp}>
        <button
          className={s.tool}
          aria-pressed={!!state?.exam}
          title="No exploration and no learning: tests only what the graph already knows"
          onClick={() => send("exam", !state?.exam)}
        >
          <span>Exam</span>
        </button>
        <button
          className={`${s.tool} ${s.hideSm}`}
          aria-pressed={reactorOn}
          disabled={!reactorAvailable}
          title={reactorMessage}
          onClick={onReactor}
        >
          <span>Photoreal</span>
        </button>
      </div>

      <span className={s.grow} />

      <div className={s.seg} role="radiogroup" aria-label="Stage">
        {STAGES.map((st, i) => (
          <button key={st.id} role="radio" aria-checked={stage === st.id}
            title={`${st.hint} (${i + 1})`} onClick={() => onStage(st.id)}>
            {st.label}
          </button>
        ))}
      </div>

      <span className={s.sep} aria-hidden="true" />

      {/* hide either rail to put the flight on its own, for showing the thing to a room */}
      <div className={s.grp}>
        <button
          className={s.tool}
          aria-pressed={!rails.left}
          title="Hide or show the left panel  ( [ )"
          aria-label="Hide or show the left panel"
          onClick={() => onRails("left")}
        >
          <PanelIcon side="left" />
        </button>
        <button
          className={s.tool}
          aria-pressed={!rails.right}
          title="Hide or show the right panel  ( ] )"
          aria-label="Hide or show the right panel"
          onClick={() => onRails("right")}
        >
          <PanelIcon side="right" />
        </button>
        <ThemeToggle className={s.tool} />
      </div>

      <span className={s.chip} data-state={connection} title={state?.db ?? ""}>
        <i />
        <span className={s.hideSm}>
          {connection === "open" ? "connected" : connection === "closed" ? "reconnecting" : "connecting"}
        </span>
      </span>
    </header>
  );
}
