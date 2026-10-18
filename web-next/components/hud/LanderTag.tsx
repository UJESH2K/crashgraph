"use client";

import { useEffect, useRef } from "react";
import { store } from "@/lib/store";
import { hudBus } from "@/lib/hudbus";
import { ACTIONS, ACTIONS_SHORT } from "@/lib/console";
import s from "./LanderTag.module.css";

/**
 * Telemetry pinned to the craft. It writes straight into the DOM on its own animation frame
 * rather than re-rendering: the values behind it change every physics step.
 */
export function LanderTag({ hidden }: { hidden: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const line = useRef<SVGLineElement>(null);
  const out = useRef<Record<string, HTMLElement | null>>({});
  const bars = useRef<HTMLDivElement>(null);
  const prevY = useRef<number | null>(null);

  // telemetry arrives on the socket, never through React state
  useEffect(() => store.onFrame((f, step, q, sit) => {
    const t = hudBus.tele;
    t.alt = f[1] - t.padY;
    t.tilt = f[2] * 57.3;
    t.vy = prevY.current === null ? null : (f[1] - prevY.current) * 50;
    prevY.current = f[1];
    t.step = step;
    t.action = f[5];
    if (sit) t.sit = sit;
    if (q) t.q = q;
  }), []);

  useEffect(() => {
    let raf = 0;
    const set = (k: string, v: string) => {
      const el = out.current[k];
      if (el && el.textContent !== v) el.textContent = v;
    };

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const el = root.current;
      if (!el || hidden) return;
      const p = hudBus.screen;
      el.style.visibility = p.visible ? "visible" : "hidden";
      if (!p.visible) return;

      el.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px)`;

      // Flip so the readout stays inside the viewport whichever way the camera is pointed.
      // Measured against the viewport, not the window: the 3D view is one cell of the shell
      // now, and against the window the box runs under the right-hand rail.
      const h = box.current?.offsetHeight ?? 190;
      const w = box.current?.offsetWidth ?? 212;
      const vw = p.w || el.parentElement?.clientWidth || window.innerWidth;
      const vh = p.h || el.parentElement?.clientHeight || window.innerHeight;
      el.dataset.v = p.y - h - 30 < 8 ? "down" : "up";
      el.dataset.h = p.x + w + 30 > vw ? "left" : "right";
      if (p.y + h + 30 > vh && el.dataset.v === "down") el.dataset.v = "up";

      const t = hudBus.tele;
      set("mode", t.mode);
      set("n", String(t.n || "—"));
      set("alt", t.alt === null ? "—" : t.alt.toFixed(1));
      set("vy", t.vy === null ? "—" : t.vy.toFixed(1));
      set("tilt", t.tilt === null ? "—" : `${t.tilt.toFixed(0)}°`);
      set("step", String(t.step || "—"));
      set("sit", t.sit);

      if (t.q && bars.current) {
        const lo = Math.min(...t.q), hi = Math.max(...t.q);
        const span = Math.max(1e-6, hi - lo);
        const kids = bars.current.children;
        for (let i = 0; i < kids.length; i++) {
          const row = kids[i] as HTMLElement;
          const fill = row.querySelector<HTMLElement>(`.${s.fill}`);
          if (fill) fill.style.width = `${8 + 92 * ((t.q[i] - lo) / span)}%`;
          row.classList.toggle(s.chosen, i === t.action);
        }
      }

      if (box.current && line.current) {
        const b = box.current.getBoundingClientRect();
        line.current.setAttribute("x2", String(Math.round(b.left + b.width / 2 - p.x)));
        line.current.setAttribute("y2", String(Math.round((el.dataset.v === "down" ? b.top : b.bottom) - p.y)));
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [hidden]);

  if (hidden) return null;

  return (
    <div ref={root} className={s.tag} data-v="up" data-h="right">
      <svg className={s.leader} aria-hidden="true">
        <line ref={line} x1="0" y1="0" x2="0" y2="0" />
      </svg>
      <div ref={box} className={s.box}>
        <div className={s.head}>
          <span className={s.mode} ref={el => { out.current.mode = el; }}>Live</span>
          <span className="mono">#<b ref={el => { out.current.n = el; }}>—</b></span>
        </div>
        <dl className={s.rows}>
          <div><dt>alt</dt><dd><span ref={el => { out.current.alt = el; }}>—</span><u>m</u></dd></div>
          <div><dt>v↓</dt><dd><span ref={el => { out.current.vy = el; }}>—</span><u>m/s</u></dd></div>
          <div><dt>tilt</dt><dd><span ref={el => { out.current.tilt = el; }}>—</span></dd></div>
          <div><dt>frame</dt><dd><span ref={el => { out.current.step = el; }}>—</span></dd></div>
        </dl>
        <p className={s.sit} ref={el => { out.current.sit = el; }}>Waiting for the first attempt</p>
        <div className={s.qbars} ref={bars}>
          {ACTIONS_SHORT.map((a, i) => (
            <div className={s.qbar} key={a} title={ACTIONS[i]}>
              <span>{a}</span>
              <div className={s.track}><div className={s.fill} style={{ width: "8%" }} /></div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
