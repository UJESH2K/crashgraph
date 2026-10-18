"use client";

import { useEffect, useRef } from "react";
import { COLOR, OUTCOME_COLOR, WORLD_ACCENT, mixColor, n0, smooth } from "@/lib/console";
import type { CurvePoint } from "@/lib/types";

/** Score per attempt with a trailing average, drawn on canvas because it redraws constantly. */
export function LearningChart({
  curve, world, height = 104, onNote,
}: {
  curve: CurvePoint[];
  world: string;
  height?: number;
  onNote?: (s: string) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const draw = () => {
      const ctx = c.getContext("2d");
      if (!ctx) return;
      const dpr = window.devicePixelRatio || 1;
      const W = c.clientWidth, H = height;
      c.width = W * dpr; c.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      const lo = -300, hi = 300;
      const y = (v: number) =>
        H - 14 - ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * (H - 24);

      ctx.font = '400 9.5px "IBM Plex Mono", monospace';
      for (const [v, label] of [[200, "solved 200"], [0, "0"], [-200, "−200"]] as const) {
        ctx.strokeStyle = v === 200 ? "rgba(63,191,147,.45)" : COLOR.hair;
        ctx.setLineDash(v === 200 ? [3, 3] : []);
        ctx.beginPath(); ctx.moveTo(0, y(v)); ctx.lineTo(W, y(v)); ctx.stroke();
        ctx.fillStyle = v === 200 ? COLOR.ok : COLOR.ink3;
        ctx.fillText(label, 2, y(v) - 3);
      }
      ctx.setLineDash([]);

      if (curve.length < 2) {
        ctx.fillStyle = COLOR.ink3;
        ctx.fillText("The curve appears after a few attempts.", 2, H - 3);
        return;
      }

      const n = curve.length;
      const avg = smooth(curve);
      const accent = WORLD_ACCENT[world] ?? WORLD_ACCENT.luna;

      ctx.fillStyle = "rgba(157,171,192,.2)";
      curve.forEach((p, i) => ctx.fillRect((i / (n - 1)) * W, y(p.score), 1.1, 1.1));

      const grad = ctx.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, `${accent}3a`);
      grad.addColorStop(1, `${accent}00`);
      ctx.beginPath(); ctx.moveTo(0, H);
      avg.forEach((v, i) => ctx.lineTo((i / (n - 1)) * W, y(v)));
      ctx.lineTo(W, H); ctx.closePath(); ctx.fillStyle = grad; ctx.fill();

      ctx.strokeStyle = accent; ctx.lineWidth = 1.7; ctx.lineJoin = "round";
      ctx.beginPath();
      avg.forEach((v, i) => {
        const X = (i / (n - 1)) * W;
        i ? ctx.lineTo(X, y(v)) : ctx.moveTo(X, y(v));
      });
      ctx.stroke();
      ctx.beginPath(); ctx.arc(W - 1, y(avg[n - 1]), 2.4, 0, 7); ctx.fillStyle = accent; ctx.fill();

      onNote?.(`last 50 average ${avg[n - 1].toFixed(0)} · ${n0(n)} attempts`);
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(c);
    return () => ro.disconnect();
  }, [curve, world, height, onNote]);

  return <canvas ref={ref} height={height} aria-label="Average score over the last 50 attempts" />;
}

/** Every attempt as one tick, oldest at the left. Clicking one replays it. */
export function AttemptStrip({
  curve, selected, onPick, className,
}: {
  curve: CurvePoint[];
  selected: number | null;
  onPick: (n: number) => void;
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const draw = () => {
      const ctx = c.getContext("2d");
      if (!ctx) return;
      const dpr = window.devicePixelRatio || 1;
      const W = c.clientWidth, H = 22;
      c.width = W * dpr; c.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const n = curve.length;
      if (!n) return;
      const bins = Math.min(n, Math.floor(W));
      const per = n / bins, bw = W / bins;
      for (let b = 0; b < bins; b++) {
        const from = Math.floor(b * per);
        const slice = curve.slice(from, Math.max(Math.floor((b + 1) * per), from + 1));
        const ok = slice.filter(p => p.outcome.startsWith("landed")).length / slice.length;
        const last = slice[slice.length - 1];
        ctx.fillStyle = slice.length === 1 ? OUTCOME_COLOR[last.outcome] : mixColor(ok);
        ctx.fillRect(b * bw, last.learned ? 0 : 4, Math.max(1, bw - (bw > 3 ? 1 : 0)),
                     last.learned ? H : H - 8);
      }
      if (selected !== null) {
        const i = curve.findIndex(p => p.n === selected);
        if (i >= 0) { ctx.fillStyle = COLOR.ink; ctx.fillRect((i / n) * W - 1, 0, 2, H); }
      }
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(c);
    return () => ro.disconnect();
  }, [curve, selected]);

  return (
    <canvas
      ref={ref}
      height={22}
      className={className}
      tabIndex={0}
      aria-label="Every attempt, oldest to newest. Click one to replay it."
      onClick={e => {
        if (!curve.length) return;
        const r = (e.target as HTMLCanvasElement).getBoundingClientRect();
        const i = Math.min(curve.length - 1,
          Math.floor(((e.clientX - r.left) / r.width) * curve.length));
        onPick(curve[i].n);
      }}
      onKeyDown={e => {
        if (!curve.length || !["ArrowLeft", "ArrowRight"].includes(e.key)) return;
        e.preventDefault();
        let i = curve.findIndex(p => p.n === selected);
        if (i < 0) i = curve.length - 1;
        i = e.key === "ArrowLeft" ? Math.max(0, i - 1) : Math.min(curve.length - 1, i + 1);
        onPick(curve[i].n);
      }}
    />
  );
}
