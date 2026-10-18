"use client";

import { useEffect, useState } from "react";
import {
  ACTIONS, ACT_KEYS, OUTCOME_TEXT, api, mixColor, send, useConsole, loadCurveInto,
} from "@/lib/console";
import { store } from "@/lib/store";
import type { Explanation, ProofMessage } from "@/lib/types";
import s from "./panes.module.css";

const MIX_COLOR = ["#56627a", "#4b7fc4", "#8fb4dc", "#2f5d9e"];

/* ───────────────────────────── why this attempt ─────────────────────────── */

export function WhyPane({ x }: { x: Explanation | null }) {
  if (!x) return <p className={s.summary}>Pick an attempt, or wait for the next one to finish.</p>;
  if (x.error) return <p className={s.summary}>{x.error}</p>;

  const marks: Record<number, [string, string]> = {};
  if (x.point_of_no_return !== undefined) marks[x.point_of_no_return] = [s.ponr, "point of no return"];
  if (x.decision_point !== undefined) marks[x.decision_point] = [s.decision, "the decision that mattered"];
  if (x.closest_call !== undefined) marks[x.closest_call] = [s.decision, "closest call"];

  const L = x.lesson;
  const mixRow = (name: string, mix?: Record<string, number>) =>
    mix ? (
      <>
        <span>{name}</span>
        <div className={s.mixbar}>
          {Object.values(mix).map((v, i) => (
            <span key={i} style={{ width: `${v * 100}%`, background: MIX_COLOR[i] }}
              title={`${ACTIONS[i]} ${Math.round(v * 100)}%`} />
          ))}
        </div>
      </>
    ) : null;

  return (
    <>
      <p className={s.summary}>
        {x.summary ?? `${OUTCOME_TEXT[x.outcome] ?? x.outcome} (score ${x.score}).`}
      </p>

      <ol className={s.path}>
        {x.path.map(p => {
          const m = marks[p.i];
          return (
            <li key={p.i} className={m ? m[0] : undefined}>
              <span className={s.risk} style={{ background: mixColor(1 - p.risk) }}
                title={`${Math.round(p.risk * 100)}% of past attempts through here failed`} />
              <span className={s.label}>
                {p.label}
                {m && <span className={s.mark}> · {m[1]}</span>}
              </span>
              <span className={s.did}>
                {ACTIONS[ACT_KEYS.indexOf(p.did as (typeof ACT_KEYS)[number])]} · {Math.round(p.risk * 100)}%
              </span>
            </li>
          );
        })}
      </ol>

      {L && (
        <>
          <h3 className={s.h3}>At “{L.situation}”</h3>
          <div className={s.mix}>
            {mixRow("This attempt", L.this_attempt_did)}
            {mixRow("Attempts that landed", L.landing_attempts_did)}
            {mixRow("Attempts that failed", L.other_attempts_did)}
          </div>
          <div className={s.legend}>
            {ACTIONS.map((a, i) => (
              <span key={a}><i style={{ background: MIX_COLOR[i] }} />{a}</span>
            ))}
          </div>
        </>
      )}

      {x.safe_path && (
        <>
          <h3 className={s.h3}>
            Safest known route from there <small>weighted shortest path, p≈{x.safe_path.p_estimate}</small>
          </h3>
          <ol className={s.safe}>
            {x.safe_path.steps.slice(1).map((st, i) => <li key={i}>{st.replaceAll("_", " ")}</li>)}
          </ol>
        </>
      )}

      <details className={s.cypher}>
        <summary>Cypher behind this</summary>
        <pre>{x.cypher?.join("\n\n")}</pre>
      </details>
    </>
  );
}

/* ───────────────────────────── graph insights ───────────────────────────── */

export function GraphPane() {
  const [hubs, setHubs] = useState<any[]>([]);
  const [sigs, setSigs] = useState<any[]>([]);

  const load = async () => {
    const [h, g] = await Promise.all([
      fetch(api("/api/hubs")).then(r => r.json()).catch(() => ({ hubs: [] })),
      fetch(api("/api/signatures")).then(r => r.json()).catch(() => ({ signatures: [] })),
    ]);
    setHubs(h.hubs ?? []);
    setSigs(g.signatures ?? []);
  };
  useEffect(() => { load(); }, []);

  return (
    <>
      <h3 className={s.h3}>Danger hubs <small>PageRank × crash rate</small></h3>
      <ol className={s.rows}>
        {hubs.length ? hubs.slice(0, 5).map((x, i) => (
          <li key={i}>
            <span>{x.label}</span>
            <span className={s.n}>{Math.round(x.risk * 100)}% fail · {x.visits} visits</span>
          </li>
        )) : <li>Needs more attempts.</li>}
      </ol>

      <h3 className={s.h3}>How it crashes</h3>
      <ul className={s.rows}>
        {sigs.length ? sigs.map((x, i) => (
          <li key={i}><span>{x.why}</span><span className={s.n}>{Math.round(x.share * 100)}%</span></li>
        )) : <li>No crashes recorded yet.</li>}
      </ul>

      <div className={s.row} style={{ marginTop: 10 }}>
        <button className="btn" onClick={load}>Refresh</button>
      </div>
    </>
  );
}

/* ───────────────────── the removal test, run live ───────────────────────── */

/**
 * Did it actually learn? Compare the opening stretch of attempts with the most recent one.
 * This is the question the removal test cannot answer on its own: the removal test shows the
 * graph is load-bearing, this shows the graph got better.
 */
function LearningEvidence() {
  const { curve } = useConsole();
  if (curve.length < 40) {
    return <p className={s.summary}>Needs about forty attempts before a before/after is meaningful.</p>;
  }
  const win = Math.max(20, Math.floor(curve.length / 10));
  const first = curve.slice(0, win);
  const last = curve.slice(-win);
  const rate = (xs: typeof curve) =>
    (100 * xs.filter(p => p.outcome.startsWith("landed")).length) / xs.length;
  const avg = (xs: typeof curve) => xs.reduce((a, p) => a + p.score, 0) / xs.length;

  const r0 = rate(first), r1 = rate(last);
  const s0 = avg(first), s1 = avg(last);
  const better = r1 > r0 + 2 || s1 > s0 + 20;

  return (
    <>
      <div className={s.evidence}>
        <div className={s.evRow}>
          <span className={s.evLabel}>first {win}</span>
          <div className={s.evTrack}><i style={{ width: `${Math.max(1, r0)}%` }} className={s.evBad} /></div>
          <span className={s.evVal}>{r0.toFixed(0)}% · {s0.toFixed(0)}</span>
        </div>
        <div className={s.evRow}>
          <span className={s.evLabel}>last {win}</span>
          <div className={s.evTrack}><i style={{ width: `${Math.max(1, r1)}%` }} className={s.evOk} /></div>
          <span className={s.evVal}>{r1.toFixed(0)}% · {s1.toFixed(0)}</span>
        </div>
        <p className={s.evKey}>landing rate · mean score</p>
      </div>
      <p className={s.verdict} data-good={better}>
        {better
          ? `Landing rate went from ${r0.toFixed(0)}% to ${r1.toFixed(0)}% and mean score from ${s0.toFixed(0)} to ${s1.toFixed(0)}. The graph is getting better at this world.`
          : `Landing rate ${r0.toFixed(0)}% → ${r1.toFixed(0)}%, mean score ${s0.toFixed(0)} → ${s1.toFixed(0)}. No clear improvement yet — let it run, or check that the trainer is not in Exam mode.`}
      </p>
    </>
  );
}

export function ProofPane({ onConfirm }: { onConfirm: (o: any) => Promise<unknown> }) {
  const { state, proof } = useConsole();
  const [n, setN] = useState(10);

  const start = proof.find(p => p.stage === "start") as
    Extract<ProofMessage, { stage: "start" }> | undefined;
  const attempts = proof.filter(p => p.stage === "attempt") as
    Extract<ProofMessage, { stage: "attempt" }>[];
  const done = proof.some(p => p.stage === "done");
  const errored = proof.find(p => p.stage === "error") as
    Extract<ProofMessage, { stage: "error" }> | undefined;
  const running = !!start && !done && !errored;

  const wipedLanded = attempts.filter(a => a.phase === "wiped").at(-1)?.landed ?? null;

  return (
    <>
      <h3 className={s.h3}>Is it learning?</h3>
      <LearningEvidence />

      <h3 className={s.h3}>Does it need the graph?</h3>
      <p className={s.summary}>
        No weights, no model file, no fallback. Take the graph away and it should fail outright.
        This flies the same seeds three times to show it.
      </p>

      <div className={s.proof}>
        {start?.phases.map(ph => {
          const mine = attempts.filter(a => a.phase === ph.key);
          const last = mine.at(-1);
          const finished = last && last.i === last.of;
          const good = ph.key === "wiped" ? last?.landed === 0 : (last?.landed ?? 0) > 0;
          const cls = [s.phase,
            running && mine.length && !finished ? s.running : "",
            finished ? (good ? s.pass : s.fail) : ""].filter(Boolean).join(" ");
          return (
            <div key={ph.key} className={cls}>
              <div className={s.phaseHead}>
                <span className={s.phaseName}>{ph.label}</span>
                <span className={s.phaseScore}>
                  {last ? `${last.landed}/${last.of} landed · avg ${last.avg_score}` : "—"}
                </span>
              </div>
              <div className={s.track}>
                {Array.from({ length: start.per_phase }, (_, i) => {
                  const a = mine[i];
                  const k = !a ? "" :
                    a.outcome.startsWith("landed") ? s.landed :
                    a.outcome === "crashed" || a.outcome === "flew_off" ? s.crashed : s.other;
                  return <i key={i} className={k} />;
                })}
              </div>
            </div>
          );
        })}
      </div>

      <div className={s.row}>
        <button
          className="btn primary"
          disabled={running || !!state?.read_only}
          onClick={async () => {
            const go = await onConfirm({
              title: "Run the removal test?",
              body: `This flies ${n} seeded attempts with the graph, wipes ${state?.world.name}'s memory and flies the same ${n} again, then restores from a snapshot and repeats. Training pauses while it runs.`,
              ok: "Run it",
            });
            if (go) { store.clearProof(); send("prove", n); }
          }}
        >
          {running ? "Running…" : "Run removal test"}
        </button>
        <label className={s.inline}>
          <span>flights</span>
          <input type="number" className="mono" min={3} max={30} value={n}
            onChange={e => setN(Math.max(3, Math.min(30, Number(e.target.value) || 10)))} />
        </label>
      </div>

      <p className={s.summary} style={{ marginTop: 10 }}>
        {errored ? `Stopped: ${errored.why}. The memory was restored from the snapshot.`
          : done && wipedLanded === 0
            ? "With the graph gone the lander cannot land at all, and restoring the snapshot brings the skill straight back. The graph is the whole policy."
            : running ? "Running. Each tick is one flight from the same starting seed."
              : "Snapshots first, restores after. Nothing is lost."}
      </p>
    </>
  );
}

/* ─────────────────────────── memory operations ──────────────────────────── */

export function MemoryPane({ onConfirm }: { onConfirm: (o: any) => Promise<unknown> }) {
  const { state } = useConsole();
  const [snap, setSnap] = useState("");
  const [seed, setSeed] = useState("");
  const ro = !!state?.read_only;

  const snaps = state?.snapshots ?? [];
  const others = (state?.worlds ?? []).filter(w => w.key !== state?.world.key);

  return (
    <>
      <label className={s.fl} htmlFor="snap-list">Snapshots <small>GRAPH.COPY</small></label>
      <div className={s.row}>
        <select id="snap-list" value={snap} onChange={e => setSnap(e.target.value)}>
          {snaps.length ? snaps.map(t => <option key={t}>{t}</option>)
            : <option value="">No snapshots yet</option>}
        </select>
        <button className="btn" disabled={ro || !snaps.length} onClick={async () => {
          const t = snap || snaps[0];
          if (!t) return;
          const go = await onConfirm({
            title: "Restore this snapshot?", ok: "Restore",
            body: `${state?.world.name}'s current memory is replaced by snapshot “${t}”.`,
          });
          if (go) { send("restore", t); setTimeout(() => loadCurveInto(state?.world.key), 800); }
        }}>Restore</button>
        <button className="btn" disabled={ro} onClick={async () => {
          const t = await onConfirm({
            title: "Save a snapshot", ok: "Save",
            body: `Copies ${state?.world.name}'s memory with GRAPH.COPY so you can come back to it.`,
            input: `after-${state?.stats.episodes ?? 0}`, inputLabel: "Snapshot name",
          });
          if (typeof t === "string" && t) send("snapshot", t.replace(/[^\w-]/g, "_"));
        }}>Save</button>
      </div>

      <label className={s.fl} htmlFor="seed-list">
        Transfer skills <small>copy another world&apos;s tiles</small>
      </label>
      <div className={s.row}>
        <select id="seed-list" value={seed} onChange={e => setSeed(e.target.value)}>
          {others.map(w => <option key={w.key} value={w.key}>from {w.name}</option>)}
        </select>
        <button className="btn" disabled={ro} onClick={() => send("seed_from", seed || others[0]?.key)}>
          Copy
        </button>
      </div>

      <label className={s.fl}>Destructive <small>no undo except a snapshot</small></label>
      <div className={s.row}>
        <button className="btn danger" disabled={ro} onClick={async () => {
          const go = await onConfirm({
            title: `Wipe ${state?.world.name}'s memory?`, ok: "Wipe it",
            body: "Everything this world's lander has learned is deleted. Save a snapshot first if you may want it back. This is also what the removal test does, safely.",
          });
          if (go) { send("wipe"); setTimeout(() => loadCurveInto(state?.world.key), 800); }
        }}>Wipe this world&apos;s memory</button>
      </div>

      <p className={`${s.db} mono`}>{state?.db ? `FalkorDB: ${state.db} · graph ${state.stats.graph}` : ""}</p>
    </>
  );
}
