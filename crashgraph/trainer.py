"""A long-running trainer the control room can steer without ever stopping the process.

Immediate controls (take effect on the next physics frame):
  pause / resume, interrupt (end this attempt now), gust (shove the lander)
Queued controls (run between attempts):
  set_world, set_speed, exam on/off, snapshot, restore, wipe, seed_from, stop
"""
import gzip
import json
import os
import queue
import threading
import time
import traceback

from .agent import GraphPilot
from .memory import GraphMemory
from .runner import run_episode
from .sim import Flight
from .worlds import WORLDS, get_world

SPEEDS = {"watch": (True, 1), "fast": (False, 4), "train": (False, 0)}   # (realtime, broadcast every Nth frame)


def save_frames(data_dir, world, n, terrain, frames):
    """Flight recordings for replay. Not memory: the pilot never reads these."""
    d = os.path.join(data_dir, "frames", world)
    os.makedirs(d, exist_ok=True)
    with gzip.open(os.path.join(d, f"{n}.json.gz"), "wt") as f:
        json.dump({"n": n, "world": world, "terrain": terrain, "frames": frames}, f)


class Control:
    def __init__(self):
        self.paused = False
        self.interrupt = False
        self.stop = False
        self.pending_gust = None


class Trainer:
    def __init__(self, db, world="luna", data_dir="data", broadcast=None):
        self.db = db
        self.data_dir = data_dir
        self.broadcast = broadcast or (lambda msg: None)
        self.ctl = Control()
        self.cmds = queue.Queue()
        self.speed = "watch"
        self.exam = False
        self.running = False      # False = idle between attempts (still alive)
        self.thread = None
        self.read_only = False    # set when another process holds the writer lease
        self.writer_id = ""
        self._set_world(world)

    # ----------------------------------------------------------- lifecycle
    def _set_world(self, key):
        if getattr(self, "mem", None) is not None and not self.read_only:
            self.release_writer()          # the lease is per graph, so hand back the old world's
        self.world = get_world(key)
        self.mem = GraphMemory(self.db, key)
        self.flight = Flight(self.world)
        self.pilot = GraphPilot(self.mem)
        if getattr(self, "thread", None) is not None:
            self.claim_writer()

    # ------------------------------------------------------- writer lock
    # Two trainers on one graph corrupt it: both write episodes under the same numbers and both
    # rewrite tiles. Only the process holding this lease may write; a second one opens read-only.
    LEASE_SECONDS = 30

    def _lock_key(self):
        return f"crashgraph:writer:{self.mem.name}"

    def claim_writer(self):
        self.writer_id = f"{os.getpid()}-{time.time():.0f}"
        try:
            conn = self.db.connection
            got = conn.set(self._lock_key(), self.writer_id, nx=True, ex=self.LEASE_SECONDS)
            if not got:
                holder = conn.get(self._lock_key())
                holder = holder.decode() if isinstance(holder, bytes) else holder
                self.read_only = True
                self.log(f"Another crashgraph process (writer {holder}) is already training "
                         f"{self.world.name}. This one is read-only, so the memory stays consistent.")
                return False
        except Exception:
            return True          # a database without the lock command must not block training
        self.read_only = False
        threading.Thread(target=self._renew_lease, daemon=True, name="trainer-lease").start()
        return True

    def _renew_lease(self):
        while not self.ctl.stop and not self.read_only:
            time.sleep(self.LEASE_SECONDS / 3)
            try:
                conn = self.db.connection
                if (conn.get(self._lock_key()) or b"").decode() == self.writer_id:
                    conn.expire(self._lock_key(), self.LEASE_SECONDS)
            except Exception:
                pass

    def release_writer(self):
        try:
            conn = self.db.connection
            if (conn.get(self._lock_key()) or b"").decode() == self.writer_id:
                conn.delete(self._lock_key())
        except Exception:
            pass

    def start(self):
        self.claim_writer()
        self.thread = threading.Thread(target=self._loop, daemon=True, name="trainer")
        self.thread.start()

    def state(self):
        return {"type": "state", "running": self.running, "paused": self.ctl.paused, "speed": self.speed,
                "exam": self.exam, "world": self.world.to_dict(), "worlds": [w.to_dict() for w in WORLDS.values()],
                "stats": self.mem.stats(), "snapshots": self.mem.snapshots(), "read_only": self.read_only}

    # ------------------------------------------------------------ commands
    WRITES = {"run", "resume", "interrupt", "gust", "snapshot", "restore", "wipe", "seed_from", "prove"}

    def command(self, cmd, arg=None):
        if self.read_only and cmd in self.WRITES:
            self.log("This window is read-only: another crashgraph process is training this world. "
                     "Close the other one, then reload.")
            return
        if cmd == "pause":
            self.ctl.paused = True
        elif cmd == "resume":
            self.ctl.paused = False
            self.running = True
        elif cmd == "run":
            self.running = True
            self.ctl.paused = False
        elif cmd == "idle":
            self.running = False
            self.ctl.interrupt = True
        elif cmd == "interrupt":
            self.ctl.interrupt = True
        elif cmd == "gust":
            self.ctl.pending_gust = float(arg or 1.0)
        elif cmd in ("set_speed", "exam", "set_world", "snapshot", "restore", "wipe", "seed_from", "prove"):
            if cmd in ("set_world", "restore", "wipe", "seed_from", "prove"):
                self.ctl.interrupt = True          # these change memory: end the current attempt first
            self.cmds.put((cmd, arg))
        else:
            raise ValueError(f"unknown command {cmd}")
        self.broadcast(self.state())

    def _apply(self, cmd, arg):
        if cmd == "set_speed":
            if arg in SPEEDS:
                self.speed = arg
        elif cmd == "exam":
            self.exam = bool(arg)
        elif cmd == "set_world":
            self.flight.close()
            self._set_world(arg)
        elif cmd == "snapshot":
            tag = arg or time.strftime("%H%M%S")
            self.mem.snapshot(tag)
            self.log(f"Saved memory snapshot '{tag}' ({self.mem.stats()['episodes']} attempts)")
        elif cmd == "restore":
            self.mem.restore(arg)
            self.log(f"Restored memory snapshot '{arg}'")
        elif cmd == "wipe":
            self.mem.wipe()
            self.log("Memory wiped. The lander starts from nothing.")
        elif cmd == "seed_from":
            n = self.mem.seed_from(arg)
            self.log(f"Copied {n} procedural tiles from {arg} into {self.world.name}")
        elif cmd == "prove":
            self._prove(int(arg or 10))
        self.broadcast(self.state())

    # --------------------------------------------------------------- proof
    PROOF_PHASES = [
        ("with_graph", "Flying with the FalkorDB graph"),
        ("wiped", "Graph wiped - the pilot has nothing left"),
        ("restored", "Graph restored from a GRAPH.COPY snapshot"),
    ]

    def _prove(self, per_phase=10):
        """Rule 3, run live: the same seeded flights with the graph, without it, and with it back.

        There is no model file and no fallback policy, so wiping the graph has to collapse the
        landing rate to zero. Each phase flies the same seeds with no exploration and no learning,
        so the only thing that differs between them is whether the memory exists.
        """
        tag = "__proof__"
        was_running, was_exam = self.running, self.exam
        self.running = False
        # `prove` is queued with ctl.interrupt set, to cut the attempt that was in flight.
        # Clear it here or the first measured flight ends immediately and scores a false 0.
        self.ctl.interrupt = False
        self.broadcast({"type": "proof", "stage": "start", "per_phase": per_phase,
                        "phases": [{"key": k, "label": lbl} for k, lbl in self.PROOF_PHASES]})
        try:
            self.mem.snapshot(tag)
            for key, label in self.PROOF_PHASES:
                if key == "wiped":
                    self.mem.wipe()
                elif key == "restored":
                    self.mem.restore(tag)
                self.pilot = GraphPilot(self.mem, seed=0)
                landed, scores = 0, []
                for j in range(per_phase):
                    if self.ctl.stop:
                        raise RuntimeError("stopped")
                    ep = run_episode(self.flight, self.pilot, self.mem,
                                     self.mem.episode_count() + 1, learn=False, epsilon=0.0,
                                     seed=500000 + j, control=self.ctl)
                    self.ctl.interrupt = False      # a phase runs to completion
                    landed += ep["outcome"].startswith("landed")
                    scores.append(ep["score"])
                    self.broadcast({"type": "proof", "stage": "attempt", "phase": key, "label": label,
                                    "i": j + 1, "of": per_phase, "landed": landed,
                                    "outcome": ep["outcome"], "score": ep["score"],
                                    "avg_score": round(sum(scores) / len(scores), 1)})
            self.broadcast({"type": "proof", "stage": "done"})
        except Exception as e:
            self.broadcast({"type": "proof", "stage": "error", "why": str(e)[:200]})
            try:
                self.mem.restore(tag)               # never leave the memory wiped
            except Exception:
                pass
        finally:
            self.pilot = GraphPilot(self.mem)
            self.exam, self.running = was_exam, was_running
            self.ctl.interrupt = False

    def log(self, text):
        self.broadcast({"type": "log", "text": text, "t": time.time()})

    # ---------------------------------------------------------------- loop
    def _loop(self):
        while not self.ctl.stop:
            try:
                while not self.cmds.empty():
                    self._apply(*self.cmds.get())
                if self.read_only:
                    # A killed process leaves its lease to expire rather than releasing it, so
                    # keep trying: this window becomes writable again on its own.
                    time.sleep(2)
                    if self.claim_writer():
                        self.log(f"Took over training for {self.world.name}.")
                        self.broadcast(self.state())
                    continue
                if not self.running:
                    time.sleep(0.1)
                    continue
                self.ctl.interrupt = False
                self._one_attempt()
            except Exception:
                self.log("Trainer error: " + traceback.format_exc(limit=3))
                time.sleep(1)

    def _one_attempt(self):
        n = self.mem.episode_count() + 1
        realtime, every = SPEEDS[self.speed]
        seed = (100000 + n) if self.exam else n
        self.flight.reset(seed=seed)  # so terrain matches what run_episode will reset to
        terrain = self.flight.terrain()
        if every:
            self.broadcast({"type": "reset", "n": n, "terrain": terrain, "exam": self.exam,
                            "world": self.world.key})

        def on_frame(fr, step, q, a, sit, sitk):
            self.broadcast({"type": "frame", "f": fr, "step": step, "q": [round(float(v), 2) for v in q],
                            "sit": sit, "sitk": sitk})

        ep = run_episode(self.flight, self.pilot, self.mem, n, seed=seed,
                         learn=not self.exam, epsilon=0.0 if self.exam else None,
                         on_frame=on_frame if every else None, control=self.ctl,
                         frame_every=every or 1, realtime=realtime)
        if not realtime and every:
            time.sleep(0.002 * ep["steps"])           # "fast" ~ 4-8x real time, still watchable
        self._save_frames(n, terrain, ep["frames"])
        if n % 25 == 0:
            self.mem.refresh_costs()
        summary = {k: ep[k] for k in ("n", "score", "outcome", "steps", "fuel", "epsilon", "learned",
                                      "gusts", "tiles_written", "graph_reads")}
        summary["situations"] = len(ep["path"])
        # The situation keys this attempt touched, in order. The console lights them up in
        # its 3D memory view so a finished attempt is visible as a change to the graph
        # rather than only as a number: nodes it has never reached before appear, and the
        # transitions it took thicken. Keys, not ids, because the browser may be holding a
        # graph snapshot older than the nodes this attempt just created.
        summary["path"] = [p["k"] for p in ep["path"]]
        self.broadcast({"type": "episode", "ep": summary, "stats": self.mem.stats()})

    def _save_frames(self, n, terrain, frames):
        save_frames(self.data_dir, self.world.key, n, terrain, frames)

    def load_frames(self, world, n):
        p = os.path.join(self.data_dir, "frames", world, f"{n}.json.gz")
        if not os.path.exists(p):
            return None
        with gzip.open(p, "rt") as f:
            return json.load(f)
