"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { COLOR, WORLD_ACCENT, n0 } from "@/lib/console";
import type { CurvePoint } from "@/lib/types";
import s from "./Improvement.module.css";

/**
 * Is it getting better, right now?
 *
 * The score curve answers that eventually; this answers it while you watch. Landing rate is
 * the headline because it is the thing a person can read at a glance and check against the
 * craft in the viewport — a run of green ticks and the number climbs.
 *
 * The marker is what makes it live rather than historical: it is drawn where the page was
 * opened, so everything to the right of it happened while you were looking at it, and the two
 * figures under the chart are before and after that line rather than before and after the run.
 */

const WIN = 50;
/* How many attempts the chart shows. All of them would be the honest default and the useless
   one: with three thousand behind it, everything that happens while you watch lands on the
   last pixel. A trailing window scrolls, so a run of landings is visible as it happens.
   The other view earns its place on a graph that is already trained, where the last three
   hundred attempts are flat and the whole point is the climb that got there. */
const SHOWN = 300;

function rolling(curve: CurvePoint[], win: number) {
  const rate: number[] = [];
  const mean: number[] = [];
  let landed = 0, total = 0;
  for (let i = 0; i < curve.length; i++) {
    landed += curve[i].outcome.startsWith("landed") ? 1 : 0;
    total += curve[i].score;
    if (i >= win) {
      landed -= curve[i - win].outcome.startsWith("landed") ? 1 : 0;
      total -= curve[i - win].score;
    }
    const n = Math.min(i + 1, win);
    rate.push(landed / n);
    mean.push(total / n);
  }
  return { rate, mean };
}

export function Improvement({ curve, world }: { curve: CurvePoint[]; world: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [all, setAll] = useState(false);

  /* where the curve stood when this page was opened */
  const opened = useRef<number | null>(null);
  if (opened.current === null && curve.length) opened.current = curve.length;

  const series = useMemo(() => rolling(curve, WIN), [curve]);

  const at = opened.current ?? 0;
  const since = Math.max(0, curve.length - at);
  const now = series.rate.at(-1) ?? 0;
  const then = at > 0 ? (series.rate[at - 1] ?? 0) : 0;
  const nowScore = series.mean.at(-1) ?? 0;
  const thenScore = at > 0 ? (series.mean[at - 1] ?? 0) : 0;
  const delta = now - then;

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    let raf = 0;

    const draw = () => {
      const ctx = c.getContext("2d");
      if (!ctx) return;
      const dpr = window.devicePixelRatio || 1;
      const W = c.clientWidth, H = 108;
      c.width = Math.max(1, W * dpr); c.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.font = '400 9px "IBM Plex Mono", monospace';

      const T = 10, B = 14;
      const yRate = (v: number) => H - B - v * (H - B - T);
      const yScore = (v: number) =>
        H - B - ((Math.max(-300, Math.min(300, v)) + 300) / 600) * (H - B - T);

      for (const v of [0.25, 0.5, 0.75]) {
        ctx.strokeStyle = COLOR.hair;
        ctx.beginPath(); ctx.moveTo(0, yRate(v)); ctx.lineTo(W, yRate(v)); ctx.stroke();
      }

      const total = series.rate.length;
      if (total < 2) {
        ctx.fillStyle = COLOR.ink3;
        ctx.fillText("A few attempts and this starts moving.", 2, H / 2);
        return;
      }
      const from = all ? 0 : Math.max(0, total - SHOWN);
      const n = total - from;
      const x = (i: number) => ((i - from) / Math.max(1, n - 1)) * W;

      // landing rate, filled: the headline
      ctx.beginPath();
      ctx.moveTo(0, H - B);
      for (let i = from; i < total; i++) ctx.lineTo(x(i), yRate(series.rate[i]));
      ctx.lineTo(W, H - B);
      ctx.closePath();
      const grad = ctx.createLinearGradient(0, T, 0, H - B);
      grad.addColorStop(0, "rgba(63,191,147,.34)");
      grad.addColorStop(1, "rgba(63,191,147,.02)");
      ctx.fillStyle = grad; ctx.fill();

      ctx.strokeStyle = COLOR.ok; ctx.lineWidth = 1.7; ctx.lineJoin = "round";
      ctx.beginPath();
      for (let i = from; i < total; i++) {
        const X = x(i), Y = yRate(series.rate[i]);
        i === from ? ctx.moveTo(X, Y) : ctx.lineTo(X, Y);
      }
      ctx.stroke();

      // mean score, as a second reading on the same picture
      ctx.strokeStyle = WORLD_ACCENT[world] ?? WORLD_ACCENT.luna;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let i = from; i < total; i++) {
        const X = x(i), Y = yScore(series.mean[i]);
        i === from ? ctx.moveTo(X, Y) : ctx.lineTo(X, Y);
      }
      ctx.stroke();

      // where this page was opened — everything right of it happened while you watched
      if (at > from + 1 && at < total) {
        const X = x(at - 1);
        ctx.strokeStyle = "rgba(223,230,240,.55)";
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 3]);
        ctx.beginPath(); ctx.moveTo(X, 0); ctx.lineTo(X, H - B); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = COLOR.ink3;
        // flip the label to the left of the line once it is too near the right edge to fit
        const right = X + 36 < W;
        ctx.textAlign = right ? "left" : "right";
        ctx.fillText("opened", X + (right ? 3 : -3), T + 2);
        ctx.textAlign = "left";
      }

      // the newest attempt, breathing, so a still screenshot is the only time it looks static
      const pulse = 2 + Math.sin(performance.now() / 260) * 0.9;
      ctx.beginPath();
      ctx.arc(W - 1.5, yRate(series.rate[total - 1]), pulse, 0, 7);
      ctx.fillStyle = COLOR.ok; ctx.fill();

      ctx.fillStyle = COLOR.ink3;
      ctx.fillText(from ? `last ${n0(n)}` : "attempt 1", 2, H - 3);
      ctx.textAlign = "right";
      ctx.fillText(`attempt ${n0(total)}`, W - 2, H - 3);
      ctx.textAlign = "left";
    };

    const loop = () => { draw(); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    const ro = new ResizeObserver(draw);
    ro.observe(c);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [series, world, at, curve.length, all]);

  return (
    <section className={s.block}>
      <header className={s.head}>
        <h2>Is it improving?</h2>
        <div className={s.range} role="radiogroup" aria-label="Span">
          <button role="radio" aria-checked={!all} onClick={() => setAll(false)}
            title="The last few hundred attempts, scrolling as they finish">Live</button>
          <button role="radio" aria-checked={all} onClick={() => setAll(true)}
            title="Every attempt in the graph, so the whole climb is visible">All</button>
        </div>
      </header>

      <div className={s.figures}>
        <div className={s.big}>
          <b>{Math.round(now * 100)}<small>%</small></b>
          <span>landing rate</span>
        </div>
        <div className={s.big}>
          <b className={s.score}>{nowScore.toFixed(0)}</b>
          <span>mean score</span>
        </div>
        <div className={`${s.delta} ${delta >= 0.005 ? s.up : delta <= -0.005 ? s.down : ""}`}>
          <b>
            {delta >= 0 ? "+" : "−"}{Math.abs(Math.round(delta * 100))}
            <small>pts</small>
          </b>
          <span>{since ? `over ${n0(since)} attempts here` : "since you opened this"}</span>
        </div>
      </div>

      <canvas ref={ref} height={108}
        aria-label="Landing rate and mean score over the last fifty attempts, updating live" />

      <p className={s.key}>
        <i className={s.kRate} />landing rate
        <i className={s.kScore} style={{ background: WORLD_ACCENT[world] ?? WORLD_ACCENT.luna }} />
        mean score
        <span className={s.was}>
          {since
            ? `was ${Math.round(then * 100)}% · ${thenScore.toFixed(0)} when this page opened`
            : "start the trainer and this moves"}
        </span>
      </p>
    </section>
  );
}
