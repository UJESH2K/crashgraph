"use client";

import { useState } from "react";
import { n0, useConsole } from "@/lib/console";
import type { Explanation } from "@/lib/types";
import { AttemptStrip } from "./LearningChart";
import { Improvement } from "./Improvement";
import { GraphPane, MemoryPane, ProofPane, WhyPane } from "./panes";
import s from "./Panel.module.css";

const TABS = [
  { id: "why", label: "Why" },
  { id: "graph", label: "Graph" },
  { id: "proof", label: "Proof" },
  { id: "mem", label: "Memory" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function Panel({
  explanation, selected, onPick, onConfirm,
}: {
  explanation: Explanation | null;
  selected: number | null;
  onPick: (n: number) => void;
  onConfirm: (o: any) => Promise<unknown>;
}) {
  const { state, curve } = useConsole();
  const [tab, setTab] = useState<TabId>("why");

  const st = state?.stats;
  const rate = st?.episodes ? Math.round((100 * st.landed) / st.episodes) : 0;

  const tiles: [string, React.ReactNode, boolean][] = st
    ? [
        ["Attempts", n0(st.episodes), false],
        ["Landed", <>{rate}<small>%</small></>, true],
        ["Skill tiles", n0(st.tiles), false],
        ["Situations", n0(st.situations), false],
        ["Transitions", n0(st.flows), false],
        ["Crashed", n0(st.crashed), false],
      ]
    : [];

  return (
    <section className={s.panel} aria-label="Graph memory">
      <header className={s.head}>
        <h1>Graph memory</h1>
        <span className={`${s.graphName} mono`} title={state?.db ?? ""}>{st?.graph ?? "—"}</span>
      </header>

      <div className={s.body}>
        {/* the question a viewer actually has, answered at the top and answered live */}
        <Improvement curve={curve} world={state?.world.key ?? "luna"} />

        <section className={s.blk}>
          <header>
            <h2>How big the memory is</h2>
          </header>
          <div className={s.tiles}>
            {tiles.map(([k, v, good]) => (
              <dl key={k} className={`${s.tile} ${good ? s.good : ""}`}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </dl>
            ))}
          </div>
        </section>

        <section className={s.blk}>
          <header>
            <h2>Every attempt</h2>
            <span className={s.note}>{n0(curve.length)} so far</span>
          </header>
          <AttemptStrip curve={curve} selected={selected} onPick={onPick} className={s.strip} />
          <p className={s.hint}>
            One tick each, oldest at the left, red to green. Click one to replay it in 3D and read
            why it ended that way; the arrow keys step through them.
          </p>
        </section>

        <nav className={s.tabs} role="tablist" aria-label="Detail">
          {TABS.map(t => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>

        <section className={s.blk} role="tabpanel">
          {tab === "why" && (
            <>
              <header>
                <h2>Attempt <span className="mono">{explanation?.n ?? "—"}</span></h2>
              </header>
              <WhyPane x={explanation} />
            </>
          )}
          {tab === "graph" && (
            <>
              <header><h2>What it has learned</h2></header>
              <GraphPane />
            </>
          )}
          {tab === "proof" && (
            <>
              <header><h2>Does it need the graph?</h2></header>
              <ProofPane onConfirm={onConfirm} />
            </>
          )}
          {tab === "mem" && (
            <>
              <header><h2>Memory</h2></header>
              <MemoryPane onConfirm={onConfirm} />
            </>
          )}
        </section>
      </div>
    </section>
  );
}
