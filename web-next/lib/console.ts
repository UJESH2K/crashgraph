"use client";

import { useSyncExternalStore } from "react";
import { store } from "./store";
import type { CurvePoint, Explanation, World } from "./types";

export const useConsole = () =>
  useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);

export const send = (cmd: string, arg?: unknown) => store.send(cmd, arg);

/**
 * Where the Python console is.
 *
 * Next can proxy /api to it with a rewrite, and that is what this used to rely on. It does not
 * hold: the whole-graph read is about 400 KB, and under training load Next's proxy hangs the
 * socket up partway through often enough to blank the memory view. The websocket already goes
 * straight to FastAPI, because rewrites do not carry upgrades; the plain requests now do too,
 * for the same reason — one less thing between the browser and the data. The rewrite stays in
 * next.config.mjs as a fallback for a deployment that sets no origin.
 */
export const API_ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN || "";
export const api = (path: string) => `${API_ORIGIN}${path}`;

/* ─────────────────────────── presentation constants ─────────────────────── */

export const ACTIONS = ["Coast", "Left thruster", "Main engine", "Right thruster"] as const;
/** The same four, for places with one short column to put them in. */
export const ACTIONS_SHORT = ["Coast", "Left", "Main", "Right"] as const;
export const ACT_KEYS = ["coast", "left_thruster", "main_engine", "right_thruster"] as const;

export const OUTCOME_TEXT: Record<string, string> = {
  landed_pad: "Landed on the pad",
  landed_off_pad: "Landed beside the pad",
  crashed: "Crashed",
  flew_off: "Flew out of bounds",
  timed_out: "Ran out of time hovering",
  interrupted: "Interrupted",
};

export const COLOR = {
  ok: "#3fbf93",
  bad: "#e85f70",
  warn: "#dba13a",
  ink: "#e8edf5",
  ink3: "rgba(232,237,245,.38)",
  hair: "rgba(255,255,255,.09)",
};

export const WORLD_ACCENT: Record<string, string> = {
  luna: "#8fb4dc",
  ares: "#e0855a",
  titan: "#d7b25c",
};

export const OUTCOME_COLOR: Record<string, string> = {
  landed_pad: COLOR.ok,
  landed_off_pad: "#5fae8f",
  crashed: COLOR.bad,
  flew_off: "#a8323f",
  timed_out: COLOR.warn,
  interrupted: COLOR.ink3,
};

/** Mix from crash red to landed jade. */
export function mixColor(f: number) {
  const a = [232, 95, 112], b = [63, 191, 147];
  return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * f)).join(",")})`;
}

/** One digit grouping for every viewer; the browser locale would mix 1,07,221 and 107,221. */
export const n0 = (v: number) => Number(v).toLocaleString("en-US");

export const worldPhysics = (w: World) =>
  `${w.wind ? `wind ${w.wind_power}` : "no wind"} · g ${w.gravity}`;

/* ─────────────────────────────── data loading ───────────────────────────── */

export async function fetchCurve(world?: string): Promise<CurvePoint[]> {
  const q = world ? `?world=${encodeURIComponent(world)}` : "";
  const r = await fetch(api(`/api/curve${q}`));
  return r.ok ? r.json() : [];
}

export async function fetchExplain(n: number): Promise<Explanation | null> {
  const r = await fetch(api(`/api/explain/${n}`));
  return r.ok ? r.json() : null;
}

export async function fetchWorlds(): Promise<World[]> {
  const r = await fetch(api("/api/worlds"));
  return r.ok ? r.json() : [];
}

export async function loadCurveInto(world?: string) {
  store.setCurve(await fetchCurve(world));
}

/** Smoothed score over a trailing window, the shape both learning charts draw. */
export function smooth(points: CurvePoint[], win = 50) {
  let sum = 0;
  const out: number[] = [];
  points.forEach((p, i) => {
    sum += p.score;
    if (i >= win) sum -= points[i - win].score;
    out.push(sum / Math.min(i + 1, win));
  });
  return out;
}
