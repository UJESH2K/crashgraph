"""Worlds the lander can fly in. Each world gets its own isolated FalkorDB graph.

The physics values are Gymnasium LunarLander parameters (game units, not SI):
gravity must be in (-12, 0), wind_power in [0, 20], turbulence_power in [0, 2].
The names are themes; the numbers are what the agent actually feels.
"""
from dataclasses import dataclass, asdict


@dataclass(frozen=True)
class World:
    key: str
    name: str
    gravity: float
    wind: bool
    wind_power: float
    turbulence: float
    sky: str          # renderer theme
    ground: str
    blurb: str

    def env_kwargs(self):
        return dict(gravity=self.gravity, enable_wind=self.wind,
                    wind_power=self.wind_power, turbulence_power=self.turbulence)

    def to_dict(self):
        return asdict(self)


WORLDS = {
    "luna": World("luna", "Luna", -10.0, False, 0.0, 0.0,
                  "#05060b", "#8d8d94", "Calm vacuum, standard gravity. The training ground."),
    "ares": World("ares", "Ares", -11.0, True, 9.0, 0.8,
                  "#2b130b", "#a5502e", "Heavier pull and steady crosswinds with gusts."),
    "titan": World("titan", "Titan", -6.0, True, 4.0, 1.6,
                   "#2a2410", "#9a8248", "Low gravity, thick turbulent air. Drifts punish late corrections."),
}


def get_world(key: str) -> World:
    if key not in WORLDS:
        raise KeyError(f"unknown world '{key}', choose from {list(WORLDS)}")
    return WORLDS[key]
