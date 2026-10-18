"use client";

import { useEffect, useRef } from "react";
import { store } from "@/lib/store";
import { hudBus } from "@/lib/hudbus";
import { useConsole } from "@/lib/console";
import type { Frame, Terrain } from "@/lib/types";
import s from "./FlightMonitor.module.css";

/**
 * The flight, still visible once the stage has been given to something else.
 *
 * Leaving the memory view or the write-up should not mean losing sight of the thing that is
 * generating what you are reading — the whole point is that it keeps running. A corner of the
 * 3D viewport was the first idea and it fights every stage's layout, so this is a plain 2D
 * elevation instead: the Box2D terrain profile the physics actually computed, the pad, and the
 * craft on it. It costs a canvas and no GPU, and at this size it is easier to read than a
 * shrunken render would be.
 */
export function FlightMonitor() {
  const { state } = useConsole();
  const ref = useRef<HTMLCanvasElement>(null);
  const terrain = useRef<Terrain | null>(null);
  const frame = useRef<Frame | null>(null);
  const trail = useRef<[number, number][]>([]);
  const out = useRef<Record<string, HTMLElement | null>>({});
  // alt and descent rate are derived here rather than read off the shared bus: the readout
  // that normally fills that in is only mounted on the flight stage, and this is for the
  // stages where it is not.
  const alt = useRef<number | null>(null);
  const vy = useRef<number | null>(null);
  const prevY = useRef<number | null>(null);

  useEffect(() => store.onReset(t => {
    terrain.current = t;
    trail.current = [];
    prevY.current = null;
    alt.current = null;
    vy.current = null;
  }), []);

  useEffect(() => store.onFrame(f => {
    frame.current = f;
    alt.current = f[1] - (terrain.current?.pad[2] ?? 0);
    vy.current = prevY.current === null ? null : (f[1] - prevY.current) * 50;
    prevY.current = f[1];
    const tr = trail.current;
    const last = tr[tr.length - 1];
    if (!last || Math.hypot(f[0] - last[0], f[1] - last[1]) > 0.08) tr.push([f[0], f[1]]);
    if (tr.length > 420) tr.shift();
  }), []);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    let raf = 0;

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const ctx = c.getContext("2d");
      if (!ctx) return;
      const dpr = window.devicePixelRatio || 1;
      const W = c.clientWidth, H = c.clientHeight;
      if (!W || !H) return;
      if (c.width !== Math.round(W * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      const t = terrain.current;
      if (!t) {
        ctx.fillStyle = "rgba(147,161,181,.55)";
        ctx.font = '400 10px "IBM Plex Mono", monospace';
        ctx.fillText("waiting for an attempt", 9, H / 2);
        return;
      }

      const px = (x: number) => (x / t.w) * W;
      const py = (y: number) => H - (y / t.h) * H;

      // ground: the profile the physics is colliding with, not a decoration
      ctx.beginPath();
      ctx.moveTo(0, H);
      for (const [x, y] of t.ground) ctx.lineTo(px(x), py(y));
      ctx.lineTo(W, H);
      ctx.closePath();
      ctx.fillStyle = "rgba(118,131,151,.17)";
      ctx.fill();
      ctx.strokeStyle = "rgba(147,161,181,.45)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      t.ground.forEach(([x, y], i) => (i ? ctx.lineTo(px(x), py(y)) : ctx.moveTo(px(x), py(y))));
      ctx.stroke();

      // the pad
      const [x1, x2, py0] = t.pad;
      ctx.strokeStyle = "#3fbf93";
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(px(x1), py(py0)); ctx.lineTo(px(x2), py(py0));
      ctx.stroke();

      // where it has been this attempt
      const tr = trail.current;
      if (tr.length > 1) {
        ctx.strokeStyle = "rgba(111,168,220,.5)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        tr.forEach(([x, y], i) => (i ? ctx.lineTo(px(x), py(y)) : ctx.moveTo(px(x), py(y))));
        ctx.stroke();
      }

      // the craft, tilted the way it really is, with the plume when the main engine is lit
      const f = frame.current;
      if (f) {
        const [x, y, ang, , , action] = f;
        ctx.save();
        ctx.translate(px(x), py(y));
        ctx.rotate(-ang);
        if (action === 2) {
          ctx.fillStyle = "rgba(219,161,58,.75)";
          ctx.beginPath();
          ctx.moveTo(-2.4, 3); ctx.lineTo(2.4, 3); ctx.lineTo(0, 10 + Math.random() * 4);
          ctx.closePath(); ctx.fill();
        }
        ctx.fillStyle = "#dfe6f0";
        ctx.beginPath();
        ctx.moveTo(0, -5.4); ctx.lineTo(4.2, 3.4); ctx.lineTo(-4.2, 3.4);
        ctx.closePath(); ctx.fill();
        ctx.restore();
      }

      const tele = hudBus.tele;
      const set = (k: string, v: string) => {
        const el = out.current[k];
        if (el && el.textContent !== v) el.textContent = v;
      };
      set("n", tele.n ? `#${tele.n}` : "—");
      set("mode", tele.mode);
      set("alt", alt.current === null ? "—" : `${alt.current.toFixed(1)}m`);
      set("vy", vy.current === null ? "—" : `${vy.current.toFixed(1)}m/s`);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <section className={s.monitor} aria-label="The flight, still running">
      <header className={s.head}>
        <span className="cap">Still flying</span>
        <span className={`${s.mode} mono`} ref={el => { out.current.mode = el; }}>Live</span>
      </header>
      <div className={s.plot}>
        <canvas ref={ref} className={s.canvas} aria-label="Elevation view of the current attempt" />
        {state?.speed === "train" && (
          <p className={s.note}>Full speed — frames are not sent. The numbers still move.</p>
        )}
      </div>
      <dl className={s.tele}>
        <div><dt>attempt</dt><dd ref={el => { out.current.n = el; }}>—</dd></div>
        <div><dt>alt</dt><dd ref={el => { out.current.alt = el; }}>—</dd></div>
        <div><dt>v↓</dt><dd ref={el => { out.current.vy = el; }}>—</dd></div>
      </dl>
    </section>
  );
}
