"""The lander's pilot. It has no neural network and no weights file.

Every decision:   read the tiles for the current state from FalkorDB -> sum -> pick an action.
After an attempt: write what changed back to FalkorDB (tiles, the situation path, the outcome).

Inside one attempt the pilot keeps a small working memory: tiles it has already
fetched this attempt and the not-yet-saved changes (Sarsa(lambda) with
eligibility traces). Between attempts it remembers nothing except the graph.
Delete the graph and the pilot is back to random flailing.
"""
from collections import defaultdict

import numpy as np

from .features import N_TILINGS, situation, situation_label, tile_keys

GAMMA = 0.99
LAMBDA = 0.9
ALPHA = 0.1 / N_TILINGS


class GraphPilot:
    def __init__(self, memory, seed=None):
        self.mem = memory
        self.rng = np.random.default_rng(seed)
        self.graph_reads = 0

    # exploration falls as the graph accumulates attempts
    @staticmethod
    def epsilon_for(n_episodes):
        return max(0.02, 0.5 * (0.995 ** n_episodes))

    def begin(self, epsilon, learn=True):
        self.eps = epsilon
        self.learn = learn
        self.cache = {}                         # tile values fetched from the graph this attempt
        self.delta = defaultdict(lambda: np.zeros(4))   # unsaved changes
        self.trace = {}
        self.prev = None                        # (keys, action, q[action])
        self.path = []                          # situation path for episodic memory
        self.graph_reads = 0

    def _values(self, keys):
        missing = [k for k in keys if k not in self.cache]
        if missing:
            got = self.mem.read_tiles(missing)
            self.graph_reads += 1
            for k in missing:
                self.cache[k] = np.array(got.get(k, [0.0, 0.0, 0.0, 0.0]), dtype=float)
        return sum(self.cache[k] + self.delta[k] for k in keys) if self.learn else sum(self.cache[k] for k in keys)

    def act(self, obs):
        keys = tile_keys(obs)
        q = self._values(keys)
        if self.rng.random() < self.eps:
            a = int(self.rng.integers(4))
        else:
            a = int(np.argmax(q))
        self._track_situation(obs, a)
        self._cur = (keys, a, float(q[a]))
        return a, q

    def observe(self, reward, next_obs, terminal):
        """Call after env.step. Does the Sarsa(lambda) bookkeeping in working memory."""
        if not self.learn:
            return
        keys, a, qa = self._cur
        for k in keys:
            self.trace.setdefault(k, np.zeros(4))
            self.trace[k][a] = 1.0
        if terminal:
            target = reward
        else:
            nk = tile_keys(next_obs)
            nq = self._values(nk)
            na = int(np.argmax(nq)) if self.rng.random() >= self.eps else int(self.rng.integers(4))
            self._forced = na
            target = reward + GAMMA * nq[na]
        err = target - qa
        dead = []
        for k, e in self.trace.items():
            self.delta[k] += ALPHA * err * e
            e *= GAMMA * LAMBDA
            if e.max() < 0.01:
                dead.append(k)
        for k in dead:
            del self.trace[k]

    def act_next(self, obs):
        """Use the on-policy action already chosen during observe() (true Sarsa)."""
        if self.learn and getattr(self, "_forced", None) is not None:
            keys = tile_keys(obs)
            q = self._values(keys)
            a = self._forced
            self._forced = None
            self._track_situation(obs, a)
            self._cur = (keys, a, float(q[a]))
            return a, q
        return self.act(obs)

    def _track_situation(self, obs, a):
        k, f = situation(obs)
        if not self.path or self.path[-1]["k"] != k:
            self.path.append({"k": k, "fields": f, "label": situation_label(f), "frames": 0, "acts": [0, 0, 0, 0]})
        self.path[-1]["frames"] += 1
        self.path[-1]["acts"][a] += 1

    def flush(self):
        """Write working memory back into the graph."""
        if not self.learn:
            return 0
        d = {k: v for k, v in self.delta.items() if np.abs(v).max() > 1e-9}
        self.mem.write_tiles(d)
        return len(d)
