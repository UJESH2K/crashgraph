"use client";

import { useEffect, useRef } from "react";
import { COLOR, n0 } from "@/lib/console";
import type { MemoryGrowth } from "@/lib/memory";

/**
 * How the memory actually grew, and what that bought.
 *
 * Measured, not modelled: each bar is the number of situations whose earliest VISITED edge
 * comes from an attempt in that bucket, so it is the attempt the situation entered the graph.
 * The landing rate over the same buckets is drawn on top, because the point of the chart is
 * that the discovery of new states dries up at the same time as the craft starts landing — it
 * stops meeting the world for the first time, and begins knowing it.
 */
export function GrowthChart({
  growth, reveal, max, height = 86,
}: {
  growth: MemoryGrowth | null;
  reveal: number;
  max: number;
  height?: number;
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
      c.width = Math.max(1, W * dpr); c.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.font = '400 9px "IBM Plex Mono", monospace';

      const pts = growth?.points ?? [];
      if (pts.length < 2) {
        ctx.fillStyle = COLOR.ink3;
        ctx.fillText("The growth curve appears once there are attempts to read.", 2, H / 2);
        return;
      }

      const PAD_B = 13, PAD_T = 11;
      const span = Math.max(1, max);
      const x = (n: number) => (Math.min(n, span) / span) * W;
      const maxNew = Math.max(1, ...pts.map(p => p.new));

      // bars: situations entering the graph in this bucket
      const bw = Math.max(1, W / pts.length - 0.6);
      for (const p of pts) {
        const h = (p.new / maxNew) * (H - PAD_B - PAD_T);
        if (h <= 0) continue;
        ctx.fillStyle = p.n <= reveal ? "rgba(111,168,220,.62)" : "rgba(111,168,220,.16)";
        ctx.fillRect(x(p.n) - bw, H - PAD_B - h, bw, h);
      }

      // landing rate over the same buckets
      ctx.strokeStyle = COLOR.ok;
      ctx.lineWidth = 1.5;
      ctx.lineJoin = "round";
      ctx.beginPath();
      let started = false;
      for (const p of pts) {
        if (p.rate === null) continue;
        const Y = H - PAD_B - p.rate * (H - PAD_B - PAD_T);
        if (started) ctx.lineTo(x(p.n), Y); else { ctx.moveTo(x(p.n), Y); started = true; }
      }
      ctx.stroke();

      // where the slider is
      if (reveal < span) {
        ctx.strokeStyle = COLOR.ink;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x(reveal), 0); ctx.lineTo(x(reveal), H - PAD_B + 2);
        ctx.stroke();
      }

      ctx.fillStyle = COLOR.ink3;
      ctx.fillText(`${n0(maxNew)} new situations per ${n0(growth!.bucket)} attempts`, 2, 8);
      ctx.fillText("attempt 1", 2, H - 3);
      ctx.textAlign = "right";
      ctx.fillStyle = COLOR.ok;
      ctx.fillText("landing rate", W - 2, 8);
      ctx.fillStyle = COLOR.ink3;
      ctx.fillText(n0(span), W - 2, H - 3);
      ctx.textAlign = "left";
    };

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(c);
    return () => ro.disconnect();
  }, [growth, reveal, max, height]);

  return (
    <canvas
      ref={ref}
      height={height}
      aria-label="Situations entering the graph per attempt, with the landing rate over the same span"
    />
  );
}
