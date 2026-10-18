"use client";

import { useEffect, useRef, useState } from "react";
import { OUTCOME_TEXT, useConsole } from "@/lib/console";
import s from "./Banner.module.css";

/** How the attempt ended, shown briefly over the scene. */
export function Banner() {
  const { lastEpisode, state } = useConsole();
  const [shown, setShown] = useState<typeof lastEpisode>(null);
  const timer = useRef<number>();

  useEffect(() => {
    // at full training speed attempts finish several times a second; a banner each time is noise
    if (!lastEpisode || state?.speed === "train") return;
    setShown(lastEpisode);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setShown(null), 2200);
    return () => window.clearTimeout(timer.current);
  }, [lastEpisode, state?.speed]);

  if (!shown) return null;

  const kind = shown.outcome.startsWith("landed")
    ? s.landed
    : shown.outcome === "crashed" || shown.outcome === "flew_off"
      ? s.crashed
      : s.warn;

  return (
    <div className={`${s.banner} ${kind}`} role="status">
      {OUTCOME_TEXT[shown.outcome] ?? shown.outcome}
      <small>
        attempt {shown.n} · score {shown.score.toFixed(0)} · {shown.situations} situations ·{" "}
        {shown.tiles_written} tiles written
      </small>
    </div>
  );
}
