"""Headless training: python train.py --world luna --episodes 2000"""
import argparse
import time

import numpy as np

from crashgraph.agent import GraphPilot
from crashgraph.memory import GraphMemory, connect
from crashgraph.runner import run_episode
from crashgraph.sim import Flight
from crashgraph.trainer import save_frames
from crashgraph.worlds import get_world


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--world", default="luna")
    ap.add_argument("--episodes", type=int, default=500)
    ap.add_argument("--fresh", action="store_true", help="wipe this world's graph first")
    ap.add_argument("--seed-from", default=None, help="copy procedural memory from another world first")
    ap.add_argument("--exam", type=int, default=0, help="after training, fly N greedy attempts without learning")
    args = ap.parse_args()

    db, where = connect()
    mem = GraphMemory(db, args.world)
    if args.fresh:
        mem.wipe()
    if args.seed_from:
        print("seeded tiles:", mem.seed_from(args.seed_from))
    print(f"FalkorDB: {where}  graph: {mem.name}  start: {mem.stats()}")
    flight, pilot = Flight(get_world(args.world)), GraphPilot(mem)
    scores, t0 = [], time.time()
    start = mem.episode_count()
    for i in range(args.episodes):
        n = start + i + 1
        ep = run_episode(flight, pilot, mem, n, seed=n)
        save_frames("data", args.world, n, flight.terrain(), ep["frames"])
        scores.append(ep["score"])
        if n % 50 == 0:
            mem.refresh_costs()
            print(f"attempt {n:5d}  avg50 {np.mean(scores[-50:]):7.1f}  last {ep['outcome']:<14} "
                  f"{mem.stats()['tiles']} tiles  {time.time() - t0:5.0f}s", flush=True)
    mem.refresh_costs()
    if args.exam:
        ex = [run_episode(flight, pilot, mem, mem.episode_count() + 1, learn=False, epsilon=0.0,
                          seed=100000 + j) for j in range(args.exam)]
        land = sum(e["outcome"].startswith("landed") for e in ex)
        print(f"EXAM {args.exam} attempts: avg {np.mean([e['score'] for e in ex]):.1f}, landed {land}")
    print(mem.stats())


if __name__ == "__main__":
    main()
