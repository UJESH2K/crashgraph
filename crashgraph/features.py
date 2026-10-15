"""Turn the 8 raw lander numbers into graph keys.

Two layers of keys, both stored as graph nodes:

* Tile keys (procedural memory). Several offset grids ("tilings") cover the
  6 continuous dimensions. A state activates one tile per tiling; the value of
  an action is the sum of those tiles' values. Overlapping tiles let one
  experience generalise to nearby states (Sutton & Barto, ch. 9.5).

* Situation keys (semantic memory). One coarse, human-readable bucket such as
  "alt=low|vy=fast|x=C|vx=still|tilt=up|legs=0". These are what explanations,
  failure chains and graph algorithms run over.
"""
import numpy as np

ACTIONS = ["coast", "left_thruster", "main_engine", "right_thruster"]

# x, y, vx, vy, angle, angular velocity
LO = np.array([-1.0, -0.1, -1.5, -1.5, -1.0, -1.5])
HI = np.array([1.0, 1.5, 1.5, 0.5, 1.0, 1.5])
NBINS = np.array([8, 6, 8, 8, 8, 6])
WIDTH = (HI - LO) / NBINS
N_TILINGS = 8
_rng = np.random.default_rng(20261015)   # fixed so keys are stable across runs
OFFSETS = _rng.random((N_TILINGS, 6)) * WIDTH


def legs_of(obs) -> int:
    return int(obs[6] > 0.5) + int(obs[7] > 0.5)


def tile_keys(obs):
    s = np.clip(np.asarray(obs[:6], dtype=float), LO, HI - 1e-6)
    legs = legs_of(obs)
    idx = np.floor((s - LO + OFFSETS) / WIDTH).astype(int)   # (tilings, 6)
    return [f"{t}:{legs}:" + ".".join(map(str, row)) for t, row in enumerate(idx)]


def _band(v, cuts, names):
    for c, n in zip(cuts, names):
        if v < c:
            return n
    return names[-1]


def situation(obs):
    """Return (key, fields) for the coarse situation the lander is in."""
    x, y, vx, vy, ang, _av = obs[:6]
    f = {
        "alt": _band(y, [0.12, 0.45, 1.0], ["ground", "low", "mid", "high"]),
        "vy": _band(vy, [-0.6, -0.25, -0.05], ["plunging", "fast", "steady", "slow"]),
        "x": _band(x, [-0.4, -0.12, 0.12, 0.4], ["far_left", "left", "center", "right", "far_right"]),
        "vx": _band(vx, [-0.25, 0.25], ["drift_left", "still", "drift_right"]),
        "tilt": _band(ang, [-0.35, -0.1, 0.1, 0.35], ["hard_right", "right", "upright", "left", "hard_left"]),
        "legs": legs_of(obs),
    }
    key = "|".join(f"{k}={v}" for k, v in f.items())
    return key, f


def situation_label(f) -> str:
    parts = [f"{f['alt']} altitude", f"{f['vy']} descent" if f['vy'] != "slow" else "slow/rising",
             f"{f['x'].replace('_', ' ')} of pad" if f['x'] != "center" else "over the pad",
             f['vx'].replace('_', ' ') if f['vx'] != "still" else "no drift",
             f"tilted {f['tilt'].replace('_', ' ')}" if f['tilt'] != "upright" else "upright"]
    if f["legs"]:
        parts.append(f"{f['legs']} leg(s) down")
    return ", ".join(parts)
