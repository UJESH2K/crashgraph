/**
 * The lander's semantic memory, laid out for the 3D view.
 *
 * A force-directed layout was the obvious first idea and the wrong one. Seventeen hundred
 * situations relax into a hairball that says nothing, every node moves whenever one is added,
 * and the same graph looks different on every load — so growth, which is the thing worth
 * seeing, becomes impossible to follow.
 *
 * Instead each node is placed by its own band fields, so the picture of the memory has the
 * shape of the world it describes: altitude up the screen, distance from the pad across it,
 * descent speed in depth, with tilt, drift and legs spreading nodes inside their cell. A
 * position is therefore a fact about the situation. It is stable across frames, across reloads
 * and across worlds, which is what makes "attempt 400 added these twelve nodes" legible.
 */

export interface MemoryGraph {
  bands: Record<"alt" | "vy" | "x" | "vx" | "tilt", string[]>;
  keys: string[];
  labels: string[];
  /** six ints per node: alt, vy, x, vx, tilt, legs */
  b: number[];
  visits: number[];
  crashes: number[];
  lands: number[];
  /** the attempt this situation was first seen on */
  born: number[];
  /** four ints per edge: source index, target index, times taken, times it led to a landing */
  edges: number[];
  dropped_edges: number;
  cypher: string[];
  /** the read routes answer with a sentence rather than a 500 when a query cannot finish */
  error?: string;
}

export interface MemoryGrowth {
  points: { n: number; new: number; total: number; flown: number; rate: number | null }[];
  bucket: number;
  situations: number;
}

/* Spacing between band centres, and the smaller spread inside one cell. The cell spread is
   kept well under the band spacing so a node is never ambiguous about which band it is in. */
const X_BAND = 7.2, X_TILT = 1.25;
const Y_BAND = 7.0, Y_LEGS = 1.15;
const Z_BAND = 6.0, Z_DRIFT = 1.5;

export const EXTENT = {
  x: 2 * X_BAND + 2 * X_TILT,
  y: 3 * Y_BAND + 2 * Y_LEGS,
  z: 1.5 * Z_BAND + Z_DRIFT,
};

/** Where one situation sits, from its bands alone. */
export function nodePosition(b: number[], i: number): [number, number, number] {
  const o = i * 6;
  const [alt, vy, x, vx, tilt, legs] = [b[o], b[o + 1], b[o + 2], b[o + 3], b[o + 4], b[o + 5]];
  return [
    (x - 2) * X_BAND + (tilt - 2) * X_TILT,
    alt * Y_BAND + legs * Y_LEGS,
    (vy - 1.5) * Z_BAND + (vx - 1) * Z_DRIFT,
  ];
}

/** Smoothed P(crash | passed through here) — the same estimate the explanations use. */
export const risk = (crashes: number, visits: number) => (crashes + 1) / (visits + 2);

const RAMP: [number, [number, number, number]][] = [
  [0, [0.247, 0.749, 0.576]],   // jade  — attempts survive this
  [0.5, [0.859, 0.631, 0.227]], // amber
  [1, [0.910, 0.372, 0.439]],   // red   — attempts die here
];

/** Risk as a colour, matching the heatmap in the left rail so the two read as one scale. */
export function riskRGB(r: number): [number, number, number] {
  const v = Math.max(0, Math.min(1, r));
  let a = RAMP[0], b = RAMP[1];
  for (let i = 0; i < RAMP.length - 1; i++) {
    if (v >= RAMP[i][0] && v <= RAMP[i + 1][0]) { a = RAMP[i]; b = RAMP[i + 1]; }
  }
  const t = (v - a[0]) / Math.max(1e-6, b[0] - a[0]);
  return [0, 1, 2].map(i => a[1][i] + (b[1][i] - a[1][i]) * t) as [number, number, number];
}

/** Node radius from how often the lander has been there. Square root, so a node visited a
 *  thousand times is ten times the radius of one visited ten times, not a hundred. The floor
 *  matters as much as the scale: a situation seen once still has to be findable. */
export function nodeRadius(visits: number, maxVisits: number) {
  return 0.24 + 0.74 * Math.sqrt(visits / Math.max(1, maxVisits));
}

/** Draw order: oldest first. Revealing memory up to attempt t is then a count, not a rebuild.
 *  `minN` drops transitions taken fewer than that many times — more than half of them have
 *  been taken once or twice, and drawing those buries the nodes under a wall of lines. */
export function orderByBirth(g: MemoryGraph, minN = 1) {
  const nodes = g.keys.map((_, i) => i).sort((a, b) => g.born[a] - g.born[b] || a - b);
  const rank = new Int32Array(g.keys.length);
  nodes.forEach((n, i) => { rank[n] = i; });

  const m = g.edges.length / 4;
  const edges = Array.from({ length: m }, (_, i) => i)
    .filter(i => g.edges[i * 4 + 2] >= minN)
    .sort((a, b) => {
      const ba = Math.max(g.born[g.edges[a * 4]], g.born[g.edges[a * 4 + 1]]);
      const bb = Math.max(g.born[g.edges[b * 4]], g.born[g.edges[b * 4 + 1]]);
      return ba - bb || a - b;
    });
  return { nodes, rank, edges };
}

export const keyIndex = (g: MemoryGraph) => {
  const m = new Map<string, number>();
  g.keys.forEach((k, i) => m.set(k, i));
  return m;
};

export const edgeIndex = (g: MemoryGraph) => {
  const m = new Map<number, number>();
  for (let e = 0; e < g.edges.length / 4; e++) {
    m.set(g.edges[e * 4] * 1e6 + g.edges[e * 4 + 1], e);
  }
  return m;
};
