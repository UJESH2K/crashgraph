"""Physics: Gymnasium's Box2D LunarLander, wrapped so we can read world-space
state for rendering, inject gusts, and classify how an attempt ended."""
import math
import gymnasium as gym
import numpy as np

from .worlds import World

SCALE = 30.0
VIEW_W, VIEW_H = 600 / SCALE, 400 / SCALE   # world units used by the env


class Flight:
    def __init__(self, world: World):
        self.world = world
        self.env = gym.make("LunarLander-v3", **world.env_kwargs())
        self.u = self.env.unwrapped
        self.obs = None
        self.gusts = 0
        self.fuel = 0.0

    def reset(self, seed=None):
        self.obs, _ = self.env.reset(seed=seed)
        self.gusts = 0
        self.fuel = 0.0
        return self.obs

    def terrain(self):
        """Ground profile + pad, in env world units (x right, y up)."""
        pts = [(p[0][0], p[0][1]) for p in self.u.sky_polys] + [self.u.sky_polys[-1][1][:2]]
        return {"w": VIEW_W, "h": VIEW_H,
                "ground": [[round(x, 3), round(y, 3)] for x, y in pts],
                "pad": [round(self.u.helipad_x1, 3), round(self.u.helipad_x2, 3), round(self.u.helipad_y, 3)]}

    def frame(self, action):
        L = self.u.lander
        return [round(L.position.x, 3), round(L.position.y, 3), round(L.angle, 4),
                int(self.u.legs[0].ground_contact), int(self.u.legs[1].ground_contact), int(action)]

    def step(self, action):
        obs, r, term, trunc, info = self.env.step(int(action))
        if action == 2:
            self.fuel += 0.3
        elif action in (1, 3):
            self.fuel += 0.03
        self.obs = obs
        return obs, float(r), term, trunc

    def gust(self, strength=1.0, direction=None):
        """A human-injected disturbance: a sideways (and slightly upward) shove."""
        if direction is None:
            direction = float(np.random.choice([-1.0, 1.0]))
        L = self.u.lander
        L.ApplyLinearImpulse((direction * 6.0 * strength, 1.5 * strength), L.worldCenter, True)
        L.ApplyAngularImpulse(direction * 0.6 * strength, True)
        self.gusts += 1
        return direction

    @staticmethod
    def outcome(obs, reward, term, trunc):
        if trunc:
            return "timed_out"
        if not term:
            return None
        if reward <= -100 + 1e-6:
            return "flew_off" if abs(obs[0]) >= 1.0 else "crashed"
        return "landed_pad" if abs(obs[0]) < 0.2 else "landed_off_pad"

    def close(self):
        self.env.close()
