"""Rule 3, measured: take FalkorDB's memory away and see what the pilot can still do.

python removal_test.py --world luna --attempts 30

1. exam with the trained graph            (no exploration, no learning)
2. snapshot, then wipe the graph, exam again
3. restore the snapshot, exam again
Exam attempts write nothing to the procedural memory, and the snapshot/restore uses GRAPH.COPY.
"""
import argparse

import numpy as np

from crashgraph.agent import GraphPilot
from crashgraph.memory import GraphMemory, connect
from crashgraph.runner import run_episode
from crashgraph.sim import Flight
from crashgraph.worlds import get_world


def exam(mem, world, k):
    flight, pilot = Flight(get_world(world)), GraphPilot(mem, seed=0)
    res = []
    for j in range(k):
        ep = run_episode(flight, pilot, mem, mem.episode_count() + 1, learn=False, epsilon=0.0, seed=500000 + j)
        res.append(ep)
    flight.close()
    landed = sum(e["outcome"].startswith("landed") for e in res)
    return {"landed": landed, "of": k, "avg_score": round(float(np.mean([e["score"] for e in res])), 1)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--world", default="luna")
    ap.add_argument("--attempts", type=int, default=30)
    a = ap.parse_args()
    db, where = connect()
    mem = GraphMemory(db, a.world)
    print(f"FalkorDB {where}, graph {mem.name}: {mem.stats()}")
    with_graph = exam(mem, a.world, a.attempts)
    print("1. with the graph:        ", with_graph)
    mem.snapshot("removal_test")
    mem.wipe()
    print("2. graph wiped:           ", exam(mem, a.world, a.attempts))
    mem.restore("removal_test")
    print("3. graph restored:        ", exam(mem, a.world, a.attempts))
    print(mem.stats())


if __name__ == "__main__":
    main()
