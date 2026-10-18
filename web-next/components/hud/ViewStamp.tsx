"use client";

import { useEffect, useRef } from "react";
import { hudBus } from "@/lib/hudbus";
import s from "@/app/page.module.css";

/**
 * Which attempt is on screen and whether it is live, an exam or a replay.
 *
 * It reads the same mutable bus the 3D scene writes to, on its own animation frame, because
 * both values change between attempts that can finish several times a second at full speed —
 * putting them in React state would re-render the shell each time.
 */
export function ViewStamp() {
  const mode = useRef<HTMLSpanElement>(null);
  const n = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const t = hudBus.tele;
      const m = mode.current, num = n.current;
      if (m && m.textContent !== t.mode) m.textContent = t.mode;
      const label = t.n ? `attempt ${t.n}` : "no attempt yet";
      if (num && num.textContent !== label) num.textContent = label;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className={s.stamp}>
      <span className={s.stampMode} ref={mode}>Live</span>
      <span className={s.stampN} ref={n}>no attempt yet</span>
    </div>
  );
}
