"use client";

import { useEffect, useMemo, useState } from "react";
import { api, COLOR, n0, useConsole } from "@/lib/console";
import { FlightMonitor } from "@/components/shell/FlightMonitor";
import s from "./Sidebar.module.css";

interface Cell {
  alt: string; x: string; row: number; col: number;
  visits: number; states: number; risk: number | null;
  crashes?: number; lands?: number;
}
interface Grid { rows: string[]; cols: string[]; cells: Cell[] }

/** Green where attempts survive, red where they do not. Hatched means never been there. */
function riskColor(risk: number | null, visits: number) {
  if (risk === null || !visits) return "transparent";
  // 0 -> jade, .5 -> amber, 1 -> red
  const stops: [number, number[]][] = [
    [0, [63, 191, 147]],
    [0.5, [219, 161, 58]],
    [1, [232, 95, 112]],
  ];
  let a = stops[0], b = stops[1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (risk >= stops[i][0] && risk <= stops[i + 1][0]) { a = stops[i]; b = stops[i + 1]; }
  }
  const t = (risk - a[0]) / Math.max(1e-6, b[0] - a[0]);
  const c = a[1].map((v, i) => Math.round(v + (b[1][i] - v) * t));
  // faint where the lander has barely been, solid where the evidence is thick
  const alpha = 0.3 + 0.7 * Math.min(1, visits / 2500);
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${alpha})`;
}

const SHORT: Record<string, string> = {
  far_left: "f.left", left: "left", center: "pad", right: "right", far_right: "f.right",
};

export function Sidebar({ monitor }: { monitor: boolean }) {
  const { state, curve } = useConsole();
  const [grid, setGrid] = useState<Grid | null>(null);
  const [hover, setHover] = useState<Cell | null>(null);
  const world = state?.world.key;

  // reloaded every fifty attempts: the aggregate barely moves faster than that, and the query
  // walks every Situation node
  const generation = state?.stats.episodes ? Math.floor(state.stats.episodes / 50) : 0;
  useEffect(() => {
    if (!world) return;
    let live = true;
    fetch(api(`/api/heatmap?world=${world}`))
      .then(r => r.json())
      .then(d => { if (live) setGrid(d); })
      .catch(() => {});
    return () => { live = false; };
  }, [world, generation]);

  const outcomes = useMemo(() => {
    const total = curve.length || 1;
    const count = (f: (o: string) => boolean) => curve.filter(p => f(p.outcome)).length;
    return [
      { label: "Landed on the pad", n: count(o => o === "landed_pad"), color: COLOR.ok },
      { label: "Landed off pad", n: count(o => o === "landed_off_pad"), color: "#5fae8f" },
      { label: "Crashed", n: count(o => o === "crashed" || o === "flew_off"), color: COLOR.bad },
      { label: "Ran out of time", n: count(o => o === "timed_out"), color: COLOR.warn },
    ].map(r => ({ ...r, pct: (100 * r.n) / total }));
  }, [curve]);

  const w = state?.world;

  return (
    <section className={s.rail} aria-label="World and risk">
      <header className={s.head}><h1>{monitor ? "The flight" : "The world"}</h1></header>

      {monitor && <FlightMonitor />}

      <div className={s.body}>
        <section className={`${s.sec} ${s.world}`}>
          <div className={s.worldHead}>
            <b>{w?.name ?? "—"}</b>
            <span>{state?.stats.graph ?? ""}</span>
          </div>
          <p className={s.blurb}>{w?.blurb ?? ""}</p>
          <div className={s.facts}>
            <dl className={s.fact}><dt>gravity</dt><dd>{w ? w.gravity : "—"}</dd></dl>
            <dl className={s.fact}><dt>wind</dt><dd>{w ? (w.wind ? w.wind_power : "—") : "—"}</dd></dl>
            <dl className={s.fact}><dt>turbulence</dt><dd>{w ? (w.wind ? w.turbulence : "—") : "—"}</dd></dl>
          </div>
        </section>

        <section className={s.sec}>
          <h2>Where it goes wrong</h2>
          <p>Every situation in the graph, folded onto altitude against distance from the pad.</p>

          <div className={s.grid}>
            {grid?.rows.map(alt => (
              <div className={s.gridRow} key={alt}>
                <span className={s.rowLabel}>{alt}</span>
                {grid.cols.map(x => {
                  const cell = grid.cells.find(c => c.alt === alt && c.x === x);
                  if (!cell) return <div key={x} className={`${s.cell} ${s.empty}`} />;
                  return (
                    <div
                      key={x}
                      className={`${s.cell} ${cell.visits ? "" : s.empty}`}
                      style={{ background: riskColor(cell.risk, cell.visits) }}
                      onMouseEnter={() => setHover(cell)}
                      onMouseLeave={() => setHover(null)}
                      title={`${alt} / ${x.replace("_", " ")}`}
                    >
                      {cell.risk !== null && (
                        <span className={s.cellVal}>{Math.round(cell.risk * 100)}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>

          <div className={s.colLabels}>
            <span />
            {grid?.cols.map(c => <span className={s.colLabel} key={c}>{SHORT[c] ?? c}</span>)}
          </div>

          <div className={s.scale}>
            <span className={s.scaleTxt}>survives</span>
            <span className={s.scaleBar} />
            <span className={s.scaleTxt}>crashes</span>
          </div>

          <div className={s.readout}>
            {hover ? (
              <>
                <b>{hover.alt} altitude, {hover.x.replace("_", " ")}</b><br />
                {hover.visits
                  ? <>{Math.round((hover.risk ?? 0) * 100)}% of attempts that reached here went on
                      to crash · {n0(hover.visits)} visits across {n0(hover.states)} states</>
                  : <>never been here</>}
              </>
            ) : (
              <>Hover a cell. The safest place to be is low and over the pad; low and far to
                either side is where attempts stop being recoverable.</>
            )}
          </div>
        </section>

        <section className={s.sec}>
          <h2>How attempts end</h2>
          <div className={s.bars}>
            {outcomes.map(o => (
              <div className={s.bar} key={o.label}>
                <span className={s.barLabel}>
                  <span className={s.swatch} style={{ background: o.color }} />
                  {o.label}
                </span>
                <span className={s.barVal}>{o.pct.toFixed(0)}%</span>
                <span className={s.barTrack}>
                  <span className={s.barFill} style={{ width: `${o.pct}%`, background: o.color }} />
                </span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </section>
  );
}
