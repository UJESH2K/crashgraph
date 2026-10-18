"use client";

import type {
  ConsoleState, CurvePoint, EpisodeSummary, Frame, ProofMessage, ServerMessage, Terrain,
} from "./types";

/**
 * One connection to the Python console, shared by the whole app.
 *
 * Frames arrive about fifty times a second. Routing those through React state would re-render
 * the tree on every physics step, so they go down a separate imperative channel that only the
 * 3D scene listens to. Everything slower - console state, finished attempts, the proof run -
 * is ordinary subscribable state that components read with useSyncExternalStore.
 */

type Listener = () => void;
type FrameListener = (f: Frame, step: number, q: number[] | null, sit: string | null,
                      sitk: string | null) => void;
type ResetListener = (terrain: Terrain, n: number, world: string, exam: boolean) => void;
type OutcomeListener = (outcome: string) => void;

export type Connection = "connecting" | "open" | "closed";

export interface Snapshot {
  connection: Connection;
  state: ConsoleState | null;
  curve: CurvePoint[];
  lastEpisode: EpisodeSummary | null;
  log: string;
  proof: ProofMessage[];
}

/** Where the Python console is, for the socket.
 *
 * Baked in for the two-process local setup, worked out from the page's own origin otherwise —
 * which is what the static export relies on, so the same build runs behind any hostname. */
const wsOrigin = () =>
  process.env.NEXT_PUBLIC_WS_ORIGIN ||
  (typeof window !== "undefined" ? window.location.origin.replace(/^http/, "ws") : "");

class ConsoleStore {
  private snap: Snapshot = {
    connection: "connecting", state: null, curve: [], lastEpisode: null, log: "", proof: [],
  };
  private subs = new Set<Listener>();
  private frameSubs = new Set<FrameListener>();
  private resetSubs = new Set<ResetListener>();
  private outcomeSubs = new Set<OutcomeListener>();
  private ws: WebSocket | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;

  getSnapshot = (): Snapshot => this.snap;
  getServerSnapshot = (): Snapshot => this.snap;

  subscribe = (fn: Listener) => {
    this.subs.add(fn);
    this.connect();
    return () => { this.subs.delete(fn); };
  };

  onFrame = (fn: FrameListener) => { this.frameSubs.add(fn); return () => { this.frameSubs.delete(fn); }; };
  onReset = (fn: ResetListener) => { this.resetSubs.add(fn); return () => { this.resetSubs.delete(fn); }; };
  onOutcome = (fn: OutcomeListener) => { this.outcomeSubs.add(fn); return () => { this.outcomeSubs.delete(fn); }; };

  private set(patch: Partial<Snapshot>) {
    this.snap = { ...this.snap, ...patch };
    this.subs.forEach(fn => fn());
  }

  private connect() {
    if (typeof window === "undefined" || this.ws) return;
    const ws = new WebSocket(`${wsOrigin()}/ws`);
    this.ws = ws;
    ws.onopen = () => this.set({ connection: "open" });
    ws.onclose = () => {
      this.ws = null;
      this.set({ connection: "closed" });
      if (!this.retry) this.retry = setTimeout(() => { this.retry = null; this.connect(); }, 1500);
    };
    ws.onmessage = e => this.handle(JSON.parse(e.data) as ServerMessage);
  }

  private handle(m: ServerMessage) {
    switch (m.type) {
      case "state":
        this.set({ state: m });
        break;
      case "log":
        this.set({ log: m.text });
        break;
      case "reset":
        this.resetSubs.forEach(fn => fn(m.terrain, m.n, m.world, m.exam));
        break;
      case "frame":
        this.frameSubs.forEach(fn => fn(m.f, m.step, m.q ?? null, m.sit ?? null, m.sitk ?? null));
        break;
      case "episode": {
        const point: CurvePoint = {
          n: m.ep.n, score: m.ep.score, outcome: m.ep.outcome, learned: m.ep.learned,
        };
        this.outcomeSubs.forEach(fn => fn(m.ep.outcome));
        this.set({
          curve: [...this.snap.curve, point],
          lastEpisode: m.ep,
          state: this.snap.state ? { ...this.snap.state, stats: m.stats } : this.snap.state,
        });
        break;
      }
      case "proof":
        this.set({
          proof: m.stage === "start" ? [m] : [...this.snap.proof, m],
        });
        break;
    }
  }

  send(cmd: string, arg?: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ cmd, arg }));
  }

  /** Replace the curve wholesale, e.g. after switching world or restoring a snapshot. */
  setCurve(curve: CurvePoint[]) { this.set({ curve }); }
  clearProof() { this.set({ proof: [] }); }

  /** Push a frame by hand, used when replaying a recorded attempt. */
  emitFrame(f: Frame, step: number) { this.frameSubs.forEach(fn => fn(f, step, null, null, null)); }
  emitReset(t: Terrain, n: number, world: string, exam: boolean) {
    this.resetSubs.forEach(fn => fn(t, n, world, exam));
  }
  emitOutcome(o: string) { this.outcomeSubs.forEach(fn => fn(o)); }
}

export const store = new ConsoleStore();
