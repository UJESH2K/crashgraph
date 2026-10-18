"use client";

import { useEffect, useRef, useState } from "react";
import { n0, useConsole } from "@/lib/console";
import { store } from "@/lib/store";
import s from "./StatusBar.module.css";

/**
 * The bar that shows the thing is running rather than posing.
 *
 * Physics rate and graph traffic are measured here, live, from the frame stream — not read off
 * stored stats. If the trainer stalls or the socket drops, these go to zero immediately, which
 * is exactly what a status bar is for.
 */
export function StatusBar() {
  const { state, lastEpisode, connection } = useConsole();
  const [hz, setHz] = useState(0);
  const frames = useRef(0);
  const eps = useRef<number[]>([]);
  const [apm, setApm] = useState(0);

  useEffect(() => store.onFrame(() => { frames.current += 1; }), []);

  useEffect(() => {
    const t = window.setInterval(() => {
      setHz(frames.current);
      frames.current = 0;
      const now = Date.now();
      eps.current = eps.current.filter(x => now - x < 60_000);
      setApm(eps.current.length);
    }, 1000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    if (lastEpisode) eps.current.push(Date.now());
  }, [lastEpisode]);

  const live = connection === "open";
  const running = !!state?.running && !state?.paused;

  return (
    <footer className={s.bar}>
      <span className={`${s.led} ${live ? (running ? s.go : s.idle) : s.off}`}>
        <i />
        {live ? (running ? "running" : "idle") : "disconnected"}
      </span>

      <span className={s.sep} />

      <Field label="physics" value={`${hz}`} unit="fps" hot={running && hz > 0} />
      <Field label="attempts" value={`${apm}`} unit="/min" hot={apm > 0} />

      <span className={s.sep} />

      <Field label="graph reads" value={lastEpisode ? n0(lastEpisode.graph_reads) : "—"}
        unit={lastEpisode ? "last" : undefined} />
      <Field label="tiles written" value={lastEpisode ? n0(lastEpisode.tiles_written) : "—"}
        unit={lastEpisode ? "last" : undefined} />
      <Field label="situations" value={lastEpisode ? n0(lastEpisode.situations) : "—"}
        unit={lastEpisode ? "last" : undefined} />

      <span className={s.grow} />

      <span className={s.meta}>{state?.world.name ?? "—"}</span>
      <span className={s.sep} />
      <span className={`${s.meta} mono`}>{state?.stats.graph ?? "—"}</span>
      {state?.read_only && <span className={s.ro}>read-only</span>}
    </footer>
  );
}

function Field({
  label, value, unit, hot,
}: { label: string; value: string; unit?: string; hot?: boolean }) {
  return (
    <span className={s.field}>
      <span className={s.label}>{label}</span>
      <b className={`${s.value} ${hot ? s.hot : ""}`}>{value}</b>
      {unit && <span className={s.unit}>{unit}</span>}
    </span>
  );
}
