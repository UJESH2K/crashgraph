"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, n0, useConsole } from "@/lib/console";
import { store } from "@/lib/store";
import { LiveMap } from "@/lib/livemap";
import { riskRGB, type MemoryGraph } from "@/lib/memory";
import s from "./LiveMemoryMap.module.css";

/**
 * The memory, growing, on the stage where the flying happens.
 *
 * The Memory tab shows the whole graph and lets you wind it back; this is the other half of
 * the same question — not "what does it know" but "watch it learn something". The craft walks
 * its own memory as it flies: the node it is standing on lights, the transition it just took
 * brightens, and when it reaches a situation it has never been in before, a node is born in
 * the middle of the map and everything else shifts to make room.
 *
 * Frames arrive fifty times a second, so none of this goes through React state. The socket
 * writes into a ref, and the canvas reads that ref on its own animation frame.
 */

const LIMIT = 190;          // how many situations the map holds before dropping the quietest
const SIZE = 300;           // css pixels, square

export function LiveMemoryMap() {
  const { state } = useConsole();
  const world = state?.world.key;

  const canvas = useRef<HTMLCanvasElement>(null);
  const map = useRef(new LiveMap());
  const here = useRef<number | null>(null);
  const pending = useRef<{ key: string; label: string } | null>(null);
  const finished = useRef<{ keys: string[]; landed: boolean } | null>(null);
  const counts = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(true);
  const [ready, setReady] = useState(false);

  /* Seed from the graph so the map opens on what the lander already knows, rather than
     pretending it is learning from nothing. Only the busiest situations: this is the working
     set, not the archive. */
  const seed = useCallback(async (w: string) => {
    setReady(false);
    map.current = new LiveMap();
    here.current = null;
    try {
      const g: MemoryGraph = await fetch(api(`/api/memory/graph?world=${w}&min_n=3`))
        .then(r => r.json());
      if (g?.error || !g?.keys) { setReady(true); return; }

      const top = g.keys.map((_, i) => i)
        .sort((a, b) => g.visits[b] - g.visits[a])
        .slice(0, LIMIT);
      const wanted = new Set(top);
      const slot = new Map<number, number>();
      for (const i of top) {
        slot.set(i, map.current.seed(g.keys[i], g.labels[i], g.visits[i], g.crashes[i], g.lands[i]));
      }
      for (let e = 0; e < g.edges.length / 4; e++) {
        const a = g.edges[e * 4], b = g.edges[e * 4 + 1];
        if (!wanted.has(a) || !wanted.has(b)) continue;
        map.current.link(slot.get(a)!, slot.get(b)!, g.edges[e * 4 + 2]);
      }
      // let it find a shape before it is first drawn, rather than exploding out of the centre
      for (let i = 0; i < 220; i++) map.current.step(SIZE / 2 - 14);
    } catch {
      /* the map is an extra; the flight does not depend on it */
    }
    setReady(true);
  }, []);

  useEffect(() => { if (world) seed(world); }, [world, seed]);

  /* the socket: both channels write to refs only */
  useEffect(() => store.onFrame((_f, _step, _q, sit, sitk) => {
    if (sitk) pending.current = { key: sitk, label: sit ?? "" };
  }), []);

  useEffect(() => store.onReset(() => { here.current = null; }), []);

  /* The store notifies on every slow-channel change, not just finished attempts, so the
     attempt number is tracked to avoid replaying the same one on an unrelated update. */
  const seenEpisode = useRef(-1);
  useEffect(() => store.subscribe(() => {
    const ep = store.getSnapshot().lastEpisode;
    if (!ep?.path || ep.n === seenEpisode.current) return;
    seenEpisode.current = ep.n;
    finished.current = { keys: ep.path, landed: ep.outcome.startsWith("landed") };
  }), []);

  useEffect(() => {
    if (!ready || !open) return;
    const c = canvas.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let discovered = 0;

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const m = map.current;
      const t = performance.now();

      // 1. the situation the craft is standing on this instant
      const p = pending.current;
      if (p) {
        pending.current = null;
        const before = m.nodes.length;
        here.current = m.visit(p.key, p.label, here.current, t);
        if (m.nodes.length > before) discovered += 1;
      }

      // 2. an attempt that has just ended
      const done = finished.current;
      if (done) {
        finished.current = null;
        const idx = done.keys.map(k => m.index.get(k)).filter((i): i is number => i !== undefined);
        m.settle(idx, done.landed);
        const keep = new Set(idx);
        if (here.current !== null) keep.add(here.current);
        const remap = m.prune(LIMIT, keep);
        if (remap && here.current !== null) here.current = remap.get(here.current) ?? null;
      }

      m.step(SIZE / 2 - 14);
      draw(ctx, m, here.current, t);

      const el = counts.current;
      if (el) {
        const label = `${n0(m.nodes.length)} situations · ${n0(m.edges.length)} transitions`
          + (discovered ? ` · ${n0(discovered)} new` : "");
        if (el.textContent !== label) el.textContent = label;
      }
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [ready, open]);

  return (
    <section className={`${s.map} ${open ? "" : s.closed}`} aria-label="The memory, live">
      <button className={s.head} onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <span className="cap">Memory, live</span>
        <svg viewBox="0 0 10 6" className={s.chev} aria-hidden="true">
          <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>

      {open && (
        <>
          <div className={s.plot}>
            <canvas ref={canvas} width={SIZE * 2} height={SIZE * 2}
              style={{ width: SIZE, height: SIZE }}
              aria-label="The situations the lander keeps meeting, lighting up as it flies" />
            {!ready && <p className={s.wait}>Reading the graph…</p>}
          </div>
          <p className={s.foot}>
            <span className={`${s.counts} mono`} ref={counts}>—</span>
            <span className={s.legend}>
              the craft walks its own memory · a node appears where it has never been
            </span>
          </p>
        </>
      )}
    </section>
  );
}

/* ───────────────────────────────── drawing ──────────────────────────────── */

function draw(ctx: CanvasRenderingContext2D, m: LiveMap, here: number | null, t: number) {
  const W = ctx.canvas.width, H = ctx.canvas.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  // the backing store is twice the css size, and the layout works in css pixels around (0, 0)
  ctx.setTransform(2, 0, 0, 2, W / 2, H / 2);

  const maxVisits = m.nodes.reduce((a, n) => Math.max(a, n.visits), 1);

  for (const e of m.edges) {
    const a = m.nodes[e.a], b = m.nodes[e.b];
    if (!a || !b) continue;
    const fresh = Math.max(0, 1 - (t - e.lit) / 1100);
    const weight = Math.min(1, 0.1 + Math.sqrt(e.n / 40));
    ctx.strokeStyle = fresh > 0
      ? `rgba(255,255,255,${0.2 + 0.7 * fresh})`
      : `rgba(129,152,184,${0.07 + 0.2 * weight})`;
    ctx.lineWidth = fresh > 0 ? 1.1 + fresh : 0.45 + weight * 0.6;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  for (let i = 0; i < m.nodes.length; i++) {
    const n = m.nodes[i];
    const decided = n.crashes + n.lands;
    const [r, g, b] = riskRGB(decided ? n.crashes / decided : 0.5);
    const rad = 1.6 + 4.4 * Math.sqrt(n.visits / maxVisits);

    // a ring that expands and fades where a situation has just been discovered
    const age = n.born ? t - n.born : Infinity;
    if (age < 1400) {
      const k = age / 1400;
      ctx.strokeStyle = `rgba(255,255,255,${(1 - k) * 0.85})`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(n.x, n.y, rad + 2 + k * 15, 0, Math.PI * 2);
      ctx.stroke();
    }

    const lit = Math.max(0, 1 - (t - n.lit) / 900);
    ctx.fillStyle = `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
    ctx.globalAlpha = 0.55 + 0.45 * Math.max(lit, Math.min(1, n.visits / (maxVisits * 0.25)));
    ctx.beginPath();
    ctx.arc(n.x, n.y, rad + lit * 1.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    if (i === here) {
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(n.x, n.y, rad + 4 + Math.sin(t / 170) * 1.1, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}
