"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, n0, useConsole } from "@/lib/console";
import { store } from "@/lib/store";
import { keyIndex, risk, type MemoryGraph as Graph, type MemoryGrowth } from "@/lib/memory";
import { MemoryGraph, type GraphHandle } from "./MemoryGraph";
import { GrowthChart } from "./GrowthChart";
import s from "./MemoryStage.module.css";

/**
 * The memory itself, on the stage.
 *
 * This is the thing the project claims and otherwise only asserts: there is no model file, so
 * what the lander knows is this graph and nothing else. Watching it fill in — a node appearing
 * the first time the craft reaches a situation, an edge darkening as a transition is taken
 * again, red turning to jade where attempts stop dying — is the claim made visible.
 *
 * Every number on this screen comes from the two queries listed at the bottom.
 */

const PLAY_SECONDS = 14;

/* More than half of all transitions have been taken once or twice. Drawing every one of them
   buries the situations under a wall of lines, so the view opens on the ones with evidence
   behind them and the rest are a click away. */
const STRENGTH = [
  { n: 1, label: "All" },
  { n: 3, label: "3+" },
  { n: 10, label: "10+" },
  { n: 25, label: "25+" },
] as const;

export function MemoryStage({ selected }: { selected: number | null }) {
  const { state, lastEpisode } = useConsole();
  const world = state?.world.key;

  const [graph, setGraph] = useState<Graph | null>(null);
  const [growth, setGrowth] = useState<MemoryGrowth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [hover, setHover] = useState<number | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const [reveal, setReveal] = useState(Number.MAX_SAFE_INTEGER);
  const [following, setFollowing] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [unseen, setUnseen] = useState(0);
  const [minN, setMinN] = useState(3);
  const [lit, setLit] = useState<{ n: number; nodes: number; fresh: number; landed: boolean } | null>(null);

  const scene = useRef<GraphHandle>(null);

  const load = useCallback(async (w: string) => {
    setLoading(true);
    setError(null);
    try {
      const [g, gr] = await Promise.all([
        fetch(api(`/api/memory/graph?world=${w}`)).then(r => r.ok ? r.json() : Promise.reject(r.status)),
        fetch(api(`/api/memory/growth?world=${w}`)).then(r => r.ok ? r.json() : Promise.reject(r.status)),
      ]);
      // the read endpoints answer with a sentence rather than a 500 when a query cannot finish
      if (g?.error) throw new Error(g.error);
      setGraph(g);
      setGrowth(gr?.error ? null : gr);
      setUnseen(0);
      setPicked(null);
    } catch (e) {
      setError(
        `The memory could not be read: ${e instanceof Error ? e.message : String(e)}. The ` +
        `console is still connected — this view needs the whole graph, so it fails on its own ` +
        `rather than taking the flight down with it.`,
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (world) load(world); }, [world, load]);

  const index = useMemo(() => (graph ? keyIndex(graph) : null), [graph]);
  const maxAttempt = useMemo(() => {
    const fromGraph = graph ? graph.born.reduce((a, b) => Math.max(a, b), 0) : 0;
    return Math.max(fromGraph, state?.stats.episodes ?? 0, 1);
  }, [graph, state?.stats.episodes]);

  /* A finished attempt arrives as a list of situation keys. Ones this view already holds are
     bumped in place; ones it does not are counted, because they are new memory and the only
     honest way to show them is to reload rather than invent a position for them. */
  useEffect(() => {
    if (!lastEpisode?.path || !index || !graph) return;
    const landed = lastEpisode.outcome.startsWith("landed");
    const known: number[] = [];
    let fresh = 0;
    for (const k of lastEpisode.path) {
      const i = index.get(k);
      if (i === undefined) fresh += 1; else known.push(i);
    }
    scene.current?.applyEpisode(known, landed);
    if (fresh) setUnseen(u => u + fresh);
    setLit({ n: lastEpisode.n, nodes: known.length, fresh, landed });
    if (following) setReveal(Number.MAX_SAFE_INTEGER);
  }, [lastEpisode, index, graph, following]);

  /* Play runs the memory forward from nothing to now. */
  useEffect(() => {
    if (!playing) return;
    setFollowing(false);
    const started = performance.now();
    let raf = 0;
    const step = () => {
      const t = (performance.now() - started) / (PLAY_SECONDS * 1000);
      if (t >= 1) { setReveal(maxAttempt); setPlaying(false); return; }
      setReveal(Math.round(t * maxAttempt));
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, maxAttempt]);

  const shown = hover ?? picked;
  const atReveal = Math.min(reveal, maxAttempt);
  const live = reveal >= maxAttempt;

  /* How much memory existed at the revealed attempt, counted rather than estimated. */
  const sizeNow = useMemo(() => {
    if (!graph) return { nodes: 0, edges: 0 };
    let nodes = 0;
    for (const b of graph.born) if (b <= atReveal) nodes += 1;
    let edges = 0;
    for (let e = 0; e < graph.edges.length / 4; e++) {
      if (graph.edges[e * 4 + 2] < minN) continue;
      if (Math.max(graph.born[graph.edges[e * 4]], graph.born[graph.edges[e * 4 + 1]]) <= atReveal) {
        edges += 1;
      }
    }
    return { nodes, edges };
  }, [graph, atReveal, minN]);

  return (
    <section className={s.stage}>
      <header className={s.head}>
        <div className={s.title}>
          <h1>Memory</h1>
          <p>
            Every situation {state?.world.name ?? "this world"}&apos;s lander has ever been in, and
            every transition between them. This is the whole policy — there is nothing else.
          </p>
        </div>
        <dl className={s.counts}>
          <div><dt>situations</dt><dd>{n0(sizeNow.nodes)}</dd></div>
          <div><dt>transitions</dt><dd>{n0(sizeNow.edges)}</dd></div>
          <div><dt>at attempt</dt><dd>{live ? n0(maxAttempt) : n0(atReveal)}</dd></div>
        </dl>
      </header>

      <div className={s.canvas}>
        {graph && !loading && (
          <MemoryGraph
            ref={scene}
            g={graph}
            reveal={atReveal}
            minN={minN}
            live={live}
            onHover={setHover}
            onPick={setPicked}
            selected={picked}
          />
        )}

        {(loading || error) && (
          <div className={s.state}>
            {error
              ? <p className={s.error}>{error}</p>
              : <p>Reading the graph…</p>}
            {error && <button className="btn" onClick={() => world && load(world)}>Try again</button>}
          </div>
        )}

        {graph && !loading && (
          <>
            <div className={s.legend}>
              <p className={s.legendTitle}>How to read it</p>
              <ul>
                <li><b>up</b> altitude band — ground at the floor, high at the top</li>
                <li><b>across</b> where it is relative to the pad</li>
                <li><b>depth</b> how fast it is coming down</li>
                <li><b>size</b> how often it has been there</li>
                <li><b>lines</b> transitions — bright where they have been taken often</li>
              </ul>
              <div className={s.ramp}>
                <span>survives</span>
                <i />
                <span>crashes</span>
              </div>
            </div>

            <div className={s.readout} data-empty={!shown}>
              {shown !== null ? (
                <>
                  <b>{graph.labels[shown]}</b>
                  <dl>
                    <div><dt>visits</dt><dd>{n0(graph.visits[shown])}</dd></div>
                    <div><dt>crash rate</dt>
                      <dd>{Math.round(risk(graph.crashes[shown], graph.visits[shown]) * 100)}%</dd></div>
                    <div><dt>first seen</dt><dd>attempt {n0(graph.born[shown])}</dd></div>
                  </dl>
                </>
              ) : (
                <span>Hover a node for the situation it stands for. Drag to orbit, scroll to zoom.</span>
              )}
            </div>

            {lit && (
              <div className={s.lit} key={lit.n}>
                <span className={lit.landed ? s.ok : s.bad}>
                  attempt {n0(lit.n)} {lit.landed ? "landed" : "failed"}
                </span>
                <span>
                  {n0(lit.nodes)} situations re-weighted
                  {lit.fresh ? ` · ${lit.fresh} never seen before` : ""}
                </span>
              </div>
            )}

            {unseen > 0 && (
              <button className={s.refresh} onClick={() => world && load(world)}>
                {n0(unseen)} new situation{unseen === 1 ? "" : "s"} since this view loaded — reload
              </button>
            )}
          </>
        )}
      </div>

      <footer className={s.timeline}>
        <div className={s.controls}>
          <button
            className="btn primary"
            onClick={() => { if (playing) { setPlaying(false); } else { setReveal(0); setPlaying(true); } }}
            disabled={!graph}
          >
            {playing ? "Stop" : "Replay the growth"}
          </button>
          <button
            className="btn"
            disabled={!graph || live}
            onClick={() => { setPlaying(false); setFollowing(true); setReveal(Number.MAX_SAFE_INTEGER); }}
          >
            Back to now
          </button>
          <label className={s.slider}>
            <input
              type="range"
              min={0}
              max={maxAttempt}
              value={atReveal}
              disabled={!graph}
              aria-label="Show the memory as it stood after this attempt"
              onChange={e => {
                setPlaying(false);
                setFollowing(false);
                setReveal(Number(e.target.value));
              }}
            />
          </label>
          <span className={`${s.scrub} mono`}>
            {live ? "live" : `attempt ${n0(atReveal)} of ${n0(maxAttempt)}`}
          </span>

          <div className={s.strength} role="radiogroup" aria-label="Show transitions taken at least">
            <span className="cap">taken</span>
            {STRENGTH.map(x => (
              <button key={x.n} role="radio" aria-checked={minN === x.n}
                title={`Draw transitions taken at least ${x.n} time${x.n === 1 ? "" : "s"}`}
                onClick={() => setMinN(x.n)}>
                {x.label}
              </button>
            ))}
          </div>
        </div>

        <GrowthChart growth={growth} reveal={atReveal} max={maxAttempt} />

        <details className={s.cypher}>
          <summary>The two queries this view is built from</summary>
          <pre>{graph?.cypher.join("\n\n") ?? ""}</pre>
        </details>
      </footer>
    </section>
  );
}
