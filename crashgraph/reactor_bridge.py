"""Optional photoreal render layer using Reactor's XMAX X2 (real-time video-to-video).

What goes to Reactor: only the pixels of our own 3D render (the `source` track) plus a text prompt.
What comes back: a restyled video (`main_video`) that the control room shows over the scene.
Physics, learning and the graph never depend on it. Training never uses it.

Spend guard:
  REACTOR_MAX_SECONDS     hard cap per session (default 90), enforced by the SDK and by us
  REACTOR_BUDGET_SECONDS  cap across all sessions (default 900 = 15 min), tracked in data/reactor_usage.json
"""
import asyncio
import io
import json
import os
import time

MODEL = os.environ.get("REACTOR_MODEL", "xmax/x2")

PROMPTS = {
    "luna": "Photorealistic NASA footage of a gold-foil lunar lander descending over grey regolith, "
            "harsh sunlight, black sky, engine plume kicking up moon dust, cinematic 35mm",
    "ares": "Photorealistic footage of a spacecraft landing on Mars, rust-red dusty terrain, "
            "thin orange haze, wind-blown dust, retro-rocket plume, cinematic documentary",
    "titan": "Photorealistic footage of a probe landing on Saturn's moon Titan, thick golden haze, "
             "dim orange light, icy dunes, Saturn faintly visible, cinematic",
}


def available():
    if not os.environ.get("REACTOR_API_KEY"):
        return False, "Set REACTOR_API_KEY to enable the photoreal view."
    try:
        import reactor_sdk  # noqa: F401
    except ImportError:
        return False, "pip install reactor-sdk pillow to enable the photoreal view."
    left = budget_left()
    if left <= 0:
        return False, "Reactor budget used up (REACTOR_BUDGET_SECONDS)."
    return True, f"{int(left)} s of Reactor time left in budget"


def _usage_path():
    return os.path.join(os.environ.get("CRASHGRAPH_DATA", "data"), "reactor_usage.json")


def budget_left():
    total = float(os.environ.get("REACTOR_BUDGET_SECONDS", 900))
    try:
        with open(_usage_path()) as f:
            used = json.load(f).get("seconds", 0.0)
    except (FileNotFoundError, ValueError):
        used = 0.0
    return total - used


def _add_usage(sec):
    p = _usage_path()
    os.makedirs(os.path.dirname(p), exist_ok=True)
    try:
        with open(p) as f:
            d = json.load(f)
    except (FileNotFoundError, ValueError):
        d = {"seconds": 0.0, "sessions": []}
    d["seconds"] = d.get("seconds", 0.0) + sec
    d.setdefault("sessions", []).append({"ended": time.time(), "seconds": round(sec, 1), "model": MODEL})
    with open(p, "w") as f:
        json.dump(d, f, indent=1)


class ReactorSession:
    """One browser <-> Reactor relay. send_out(bytes) delivers a JPEG to the browser."""

    def __init__(self, world, send_out, send_status):
        self.world = world
        self.send_out = send_out
        self.send_status = send_status
        self.r = None
        self.src = None
        self.started = None
        self.limit = min(float(os.environ.get("REACTOR_MAX_SECONDS", 90)), budget_left())
        self.closed = False

    async def start(self):
        from reactor_sdk import Reactor, ReactorStatus
        self.r = Reactor(model_name=MODEL, api_key=os.environ["REACTOR_API_KEY"],
                         max_session_duration_seconds=int(max(5, self.limit)))
        loop = asyncio.get_running_loop()
        ready = asyncio.Event()

        @self.r.on_status(ReactorStatus.READY)
        def _ready(_status):
            loop.call_soon_threadsafe(ready.set)

        out = self.r.track("main_video")

        @out.on_frame
        def _frame(frame):   # RGB numpy (h, w, 3)
            from PIL import Image
            buf = io.BytesIO()
            Image.fromarray(frame).save(buf, format="JPEG", quality=80)
            data = buf.getvalue()
            loop.call_soon_threadsafe(lambda: asyncio.ensure_future(self.send_out(data)))

        await self.send_status({"reactor": "connecting", "model": MODEL})
        self.started = time.time()        # bill conservatively from the moment we connect
        await self.r.connect()
        await asyncio.wait_for(ready.wait(), timeout=60)
        self.src = await self.r.track("source").publish()
        await self.r.send_command("setKeepBacklog", {"keep_backlog": False})
        await self.r.send_command("setPrompt", {"prompt": PROMPTS.get(self.world, PROMPTS["luna"])})
        await self.send_status({"reactor": "live", "limit": int(self.limit)})
        asyncio.ensure_future(self._watchdog())

    async def push_jpeg(self, data: bytes):
        if self.src is None or self.closed:
            return
        import numpy as np
        from PIL import Image
        img = np.asarray(Image.open(io.BytesIO(data)).convert("RGB"))
        self.src.push_frame(img)

    async def set_prompt(self, prompt):
        if self.r and not self.closed:
            await self.r.send_command("setPrompt", {"prompt": prompt[:1000]})

    async def _watchdog(self):
        while not self.closed:
            await asyncio.sleep(1)
            if self.started and time.time() - self.started >= self.limit:
                await self.send_status({"reactor": "stopped", "why": "session time cap reached"})
                await self.stop()

    async def stop(self):
        if self.closed:
            return
        self.closed = True
        if self.started:
            _add_usage(time.time() - self.started)
        try:
            if self.r:
                await self.r.disconnect()
        except Exception:
            pass
