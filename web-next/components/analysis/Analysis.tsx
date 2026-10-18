"use client";

import { useEffect, useRef, useState } from "react";
import { api, COLOR, WORLD_ACCENT, fetchCurve, fetchWorlds, n0, smooth } from "@/lib/console";
import type { MemoryGrowth } from "@/lib/memory";
import type { CurvePoint, World } from "@/lib/types";
import s from "./Analysis.module.css";

type Row = World & { curve: CurvePoint[]; growth: MemoryGrowth | null };

/** Everything a reviewer would want to check, with the exact value next to its source. */
const REFS: [string, React.ReactNode, string][] = [
  ["Physics engine",
    <>Gymnasium <code>LunarLander-v3</code> on Box2D, used unmodified. Gravity, wind and turbulence
      are its own parameters; we only choose values inside its documented ranges.</>,
    "https://gymnasium.farama.org/environments/box2d/lunar_lander/"],
  ["World parameters",
    <>Luna <code>g −10</code>; Ares <code>g −11, wind 9, turbulence 0.8</code>; Titan{" "}
      <code>g −6, wind 4, turbulence 1.6</code>. Gymnasium permits <code>g ∈ (−12, 0)</code>,{" "}
      <code>wind ≤ 20</code>, <code>turbulence ≤ 2</code>.</>,
    "https://gymnasium.farama.org/environments/box2d/lunar_lander/"],
  ["Reward",
    <>The environment&apos;s own reward, unchanged: shaping on distance, speed and tilt,{" "}
      <code>−0.3</code> per main-engine frame, <code>±100</code> for landing or crashing. Scores
      therefore compare directly with any other LunarLander result.</>,
    "https://gymnasium.farama.org/environments/box2d/lunar_lander/"],
  ["Learning rule",
    <>Sarsa(λ) with tile coding — Sutton &amp; Barto, §9.5 and §12. <code>γ 0.99</code>,{" "}
      <code>λ 0.9</code>, <code>α 0.1/8</code>, 8 offset tilings, ε from{" "}
      <code>0.5·0.995ⁿ</code> down to <code>0.02</code>.</>,
    "http://incompleteideas.net/book/the-book-2nd.html"],
  ["Shortest safe route",
    <>FalkorDB <code>algo.SPpaths</code> over <code>FLOWS</code> edges weighted{" "}
      <code>cost = −log((land+0.5)/(n+1))</code>, so the cheapest path is the most survivable.</>,
    "https://docs.falkordb.com/algorithms/"],
  ["Danger hubs",
    <>FalkorDB <code>algo.pageRank</code> on <code>Situation</code>/<code>FLOWS</code>, multiplied
      by each node&apos;s own crash rate.</>,
    "https://docs.falkordb.com/algorithms/"],
  ["Failure families",
    <>FalkorDB <code>algo.labelPropagation</code> over <code>FLOWS</code> to group situations that
      lead into each other.</>,
    "https://docs.falkordb.com/algorithms/"],
  ["Graph database",
    <>FalkorDB 4.22, one graph per world. Snapshots and restores are <code>GRAPH.COPY</code>; the
      removal test uses nothing else.</>,
    "https://github.com/FalkorDB/FalkorDB"],
];

export function Analysis({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      const worlds = await fetchWorlds();
      const [curves, growths] = await Promise.all([
        Promise.all(worlds.map(w => fetchCurve(w.key))),
        Promise.all(worlds.map(w =>
          fetch(api(`/api/memory/growth?world=${w.key}`))
            .then(r => r.ok ? r.json() : null)
            .then(d => (d && !d.error ? d : null))
            .catch(() => null))),
      ]);
      if (live) setRows(worlds.map((w, i) => ({ ...w, curve: curves[i], growth: growths[i] })));
    })();
    return () => { live = false; };
  }, []);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  return (
    <section className={s.overlay}>
      <button className={s.close} onClick={onClose} aria-label="Close">✕</button>
      <div className={s.scroll}>

        <article className={s.brief}>
          <p className={s.eyebrow}>Graph Hacks · Agents That Act on Connected Data · Agent Memory</p>
          <h1>A lander that keeps its mind in a graph</h1>
          <p className={s.lede}>
            A reinforcement-learning agent normally ends up as a neural network: a block of weights
            that lands the craft but cannot tell you anything about it. When it crashes you can
            retrain, but you cannot ask <em>why</em>. There is nothing in there to query.
          </p>
          <p className={s.lede}>
            crashgraph removes the network. The pilot has no weights and no model file. Before every
            engine decision it reads FalkorDB; after every attempt it writes back what happened. The
            policy <em>is</em> the graph — about a hundred thousand state tiles, the situations the
            craft passes through, and the transitions between them. The memory it flies on is the
            same memory you can interrogate, with ordinary Cypher.
          </p>
          <div className={s.grid}>
            <div><b>The test</b><span>delete the graph and the craft must fail completely</span></div>
            <div><b>Physics</b><span>Gymnasium LunarLander-v3 on Box2D, unmodified</span></div>
            <div><b>Memory</b><span>one FalkorDB graph per world, isolated</span></div>
          </div>
        </article>

        <section className={s.card}>
          <header>
            <h2>Learning, per world</h2>
            <span className={s.note}>score per attempt, smoothed over 50</span>
          </header>
          <CompareChart rows={rows} />
        </section>

        <div className={s.cols}>
          <section className={s.card}>
            <header><h2>Worlds</h2></header>
            <div className={s.tablewrap}>
              <table>
                <thead>
                  <tr><th>World</th><th>Gravity</th><th>Wind</th><th>Attempts</th><th>Landed</th><th>Tiles</th></tr>
                </thead>
                <tbody>
                  {(rows ?? []).map(w => (
                    <tr key={w.key}>
                      <td className={s.name}>
                        <span className={s.swatch} style={{ background: WORLD_ACCENT[w.key] }} />
                        {w.name}
                      </td>
                      <td>{w.gravity}</td>
                      <td>{w.wind ? `${w.wind_power} / ${w.turbulence}` : "—"}</td>
                      <td>{n0(w.stats?.episodes ?? 0)}</td>
                      <td>{Math.round((100 * (w.stats?.landed ?? 0)) / Math.max(1, w.stats?.episodes ?? 1))}%</td>
                      <td>{n0(w.stats?.tiles ?? 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className={s.hint}>
              Ares and Titan were seeded with Luna&apos;s tiles, then trained on their own physics.
              Harder air means a lower landing rate on the same budget.
            </p>
          </section>

          <section className={s.card}>
            <header><h2>How the memory grew</h2></header>
            <GrowthChart rows={rows} />
            <p className={s.hint}>
              New situations appear quickly, then level off: the craft stops meeting states it has
              never seen, which is when the landing rate climbs.
            </p>
          </section>
        </div>

        <section className={s.card}>
          <header>
            <h2>Check the work</h2>
            <span className={s.note}>every number has a source</span>
          </header>
          <p className={s.summary}>
            Nothing here is hand-tuned. The physics, the reward and the learning rule are standard
            and published; the graph work is FalkorDB&apos;s own algorithms.
          </p>
          <div className={s.refs}>
            {REFS.map(([name, body, url]) => (
              <div className={s.ref} key={name}>
                <b>{name}</b>
                <p>{body}</p>
                <a href={url} target="_blank" rel="noopener noreferrer">source ↗</a>
              </div>
            ))}
          </div>
        </section>

      </div>
    </section>
  );
}

function CompareChart({ rows }: { rows: Row[] | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || !rows) return;
    const draw = () => {
      const ctx = c.getContext("2d");
      if (!ctx) return;
      const dpr = window.devicePixelRatio || 1;
      const W = c.clientWidth, H = 230;
      c.width = W * dpr; c.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const PAD = 42, lo = -320, hi = 320;
      const y = (v: number) => H - 20 - ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * (H - 34);
      const maxN = Math.max(1, ...rows.map(r => r.curve.length));

      ctx.font = '400 10px "IBM Plex Mono", monospace';
      for (const v of [200, 100, 0, -100, -200]) {
        ctx.strokeStyle = v === 200 ? "rgba(63,191,147,.4)" : COLOR.hair;
        ctx.setLineDash(v === 200 ? [3, 3] : []);
        ctx.beginPath(); ctx.moveTo(PAD, y(v)); ctx.lineTo(W, y(v)); ctx.stroke();
        // the number goes in the gutter and the word beside the line, rather than one long
        // right-aligned string that runs off the left edge
        ctx.fillStyle = v === 200 ? COLOR.ok : COLOR.ink3;
        ctx.textAlign = "right";
        ctx.fillText(String(v), PAD - 8, y(v) + 3);
        if (v === 200) {
          ctx.textAlign = "left";
          ctx.fillText("solved", PAD + 6, y(v) - 4);
        }
      }
      ctx.setLineDash([]); ctx.textAlign = "left";
      ctx.fillStyle = COLOR.ink3;
      ctx.fillText("attempt 1", PAD + 2, H - 4);
      ctx.textAlign = "right"; ctx.fillText(n0(maxN), W - 2, H - 4);

      for (const r of rows) {
        if (r.curve.length < 2) continue;
        const avg = smooth(r.curve);
        ctx.strokeStyle = WORLD_ACCENT[r.key] ?? "#888";
        ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.beginPath();
        avg.forEach((v, i) => {
          const X = PAD + (i / (maxN - 1)) * (W - PAD);
          i ? ctx.lineTo(X, y(v)) : ctx.moveTo(X, y(v));
        });
        ctx.stroke();
      }
    };
    draw();
    const ro = new ResizeObserver(draw); ro.observe(c);
    return () => ro.disconnect();
  }, [rows]);

  return (
    <>
      <canvas ref={ref} height={230} aria-label="Learning curves compared across worlds" />
      <div className={s.legend}>
        {(rows ?? []).map(r => (
          <span key={r.key}>
            <i style={{ background: WORLD_ACCENT[r.key] }} />
            {r.name} · ends at {r.curve.length ? smooth(r.curve).at(-1)!.toFixed(0) : "–"}
          </span>
        ))}
      </div>
    </>
  );
}

function GrowthChart({ rows }: { rows: Row[] | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || !rows) return;
    const draw = () => {
      const ctx = c.getContext("2d");
      if (!ctx) return;
      const dpr = window.devicePixelRatio || 1;
      const W = c.clientWidth, H = 140;
      c.width = W * dpr; c.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.font = '400 10px "IBM Plex Mono", monospace';

      // Measured, not modelled: each point is how many situations had entered that world's
      // graph by that attempt, from min(e.n) over every VISITED edge.
      const series = rows.filter(r => (r.growth?.points?.length ?? 0) > 1);
      if (!series.length) {
        ctx.fillStyle = COLOR.ink3;
        ctx.fillText("Needs attempts in the graph before the curve means anything.", 2, H / 2);
        return;
      }
      const max = Math.max(1, ...series.map(r => r.growth!.points.at(-1)!.total));
      const maxN = Math.max(1, ...series.map(r => r.growth!.points.at(-1)!.n));

      ctx.strokeStyle = COLOR.hair;
      ctx.beginPath(); ctx.moveTo(0, H - 16); ctx.lineTo(W, H - 16); ctx.stroke();

      for (const r of series) {
        ctx.strokeStyle = WORLD_ACCENT[r.key] ?? "#888";
        ctx.lineWidth = 1.8; ctx.lineJoin = "round";
        ctx.beginPath();
        r.growth!.points.forEach((p, i) => {
          const X = (p.n / maxN) * W;
          const Y = H - 16 - (p.total / max) * (H - 30);
          i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y);
        });
        ctx.stroke();
      }

      ctx.fillStyle = COLOR.ink3;
      ctx.fillText(`${n0(max)} situations`, 2, 11);
      ctx.fillText("attempts →", 2, H - 3);
      ctx.textAlign = "right";
      ctx.fillText(n0(maxN), W - 2, H - 3);
      ctx.textAlign = "left";
    };
    draw();
    const ro = new ResizeObserver(draw); ro.observe(c);
    return () => ro.disconnect();
  }, [rows]);

  return <canvas ref={ref} height={140} aria-label="Situations in each world's graph as attempts accumulate" />;
}
