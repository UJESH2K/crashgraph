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
        self._set_world(world)

    # ----------------------------------------------------------- lifecycle
    def _set_world(self, key):
        self.world = get_world(key)
        self.mem = GraphMemory(self.db, key)
        self.flight = Flight(self.world)
        self.pilot = GraphPilot(self.mem)

    def start(self):
        self.thread = threading.Thread(target=self._loop, daemon=True, name="trainer")
        self.thread.start()

    def state(self):
        return {"type": "state", "running": self.running, "paused": self.ctl.paused, "speed": self.speed,
                "exam": self.exam, "world": self.world.to_dict(), "worlds": [w.to_dict() for w in WORLDS.values()],
                "stats": self.mem.stats(), "snapshots": self.mem.snapshots()}

    # ------------------------------------------------------------ commands
    def command(self, cmd, arg=None):
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
        elif cmd in ("set_speed", "exam", "set_world", "snapshot", "restore", "wipe", "seed_from"):
            if cmd in ("set_world", "restore", "wipe", "seed_from"):
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
        self.broadcast(self.state())

    def log(self, text):
        self.broadcast({"type": "log", "text": text, "t": time.time()})

    # ---------------------------------------------------------------- loop
    def _loop(self):
        while not self.ctl.stop:
            try:
                while not self.cmds.empty():
                    self._apply(*self.cmds.get())
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

        def on_frame(fr, step, q, a, sit):
            self.broadcast({"type": "frame", "f": fr, "step": step, "q": [round(float(v), 2) for v in q],
                            "sit": sit})

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
        self.broadcast({"type": "episode", "ep": summary, "stats": self.mem.stats()})

    def _save_frames(self, n, terrain, frames):
        save_frames(self.data_dir, self.world.key, n, terrain, frames)

    def load_frames(self, world, n):
        p = os.path.join(self.data_dir, "frames", world, f"{n}.json.gz")
        if not os.path.exists(p):
            return None
        with gzip.open(p, "rt") as f:
            return json.load(f)
