/** Shapes the Python console sends over the websocket and the /api routes. */

export type Outcome =
  | "landed_pad" | "landed_off_pad" | "crashed" | "flew_off" | "timed_out" | "interrupted";

export interface World {
  key: string;
  name: string;
  gravity: number;
  wind: boolean;
  wind_power: number;
  turbulence: number;
  sky: string;
  ground: string;
  blurb: string;
  stats?: Stats;
}

export interface Stats {
  world: string;
  graph: string;
  episodes: number;
  landed: number;
  crashed: number;
  tiles: number;
  situations: number;
  flows: number;
}

export interface Terrain {
  w: number;
  h: number;
  /** [x1, x2, y] of the landing pad */
  pad: [number, number, number];
  ground: [number, number][];
}

/** [x, y, angle, legL, legR, action] */
export type Frame = [number, number, number, number, number, number];

export interface ConsoleState {
  type: "state";
  running: boolean;
  paused: boolean;
  speed: "watch" | "fast" | "train";
  exam: boolean;
  read_only: boolean;
  world: World;
  worlds: World[];
  stats: Stats;
  snapshots: string[];
  db?: string;
}

/** Which of the three stages owns the viewport. */
export type Stage = "flight" | "memory" | "analysis";

export interface EpisodeSummary {
  n: number;
  score: number;
  outcome: Outcome;
  steps: number;
  fuel: number;
  epsilon: number;
  learned: boolean;
  gusts: number;
  tiles_written: number;
  graph_reads: number;
  situations: number;
  /** Situation keys this attempt passed through, in order; the memory view animates them. */
  path?: string[];
}

export interface CurvePoint {
  n: number;
  score: number;
  outcome: Outcome;
  learned: boolean;
}

export interface PathStep {
  i: number;
  k: string;
  label: string;
  visits: number;
  risk: number;
  acts: [number, number, number, number];
  frames: number;
  did: string;
}

export interface Explanation {
  n: number;
  outcome: Outcome;
  score: number;
  summary?: string;
  path: PathStep[];
  point_of_no_return?: number;
  decision_point?: number;
  closest_call?: number;
  lesson?: {
    situation: string;
    this_attempt_did: Record<string, number>;
    landing_attempts_did: Record<string, number>;
    other_attempts_did: Record<string, number>;
  };
  safe_path?: { steps: string[]; p_estimate: number };
  cypher: string[];
  error?: string;
}

/** Messages pushed from the trainer. */
export type ServerMessage =
  | ConsoleState
  | { type: "log"; text: string }
  | { type: "reset"; n: number; terrain: Terrain; exam: boolean; world: string }
  | { type: "frame"; f: Frame; step: number; q: number[]; sit: string; sitk: string }
  | { type: "episode"; ep: EpisodeSummary; stats: Stats }
  | ProofMessage;

export type ProofMessage =
  | { type: "proof"; stage: "start"; per_phase: number; phases: { key: string; label: string }[] }
  | {
      type: "proof"; stage: "attempt"; phase: string; label: string;
      i: number; of: number; landed: number; outcome: Outcome; score: number; avg_score: number;
    }
  | { type: "proof"; stage: "done" }
  | { type: "proof"; stage: "error"; why: string };

export type Command =
  | "run" | "pause" | "resume" | "idle" | "interrupt" | "gust"
  | "set_speed" | "exam" | "set_world" | "snapshot" | "restore" | "wipe" | "seed_from" | "prove";
