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

# X2 takes an *editing instruction*, not a caption: "Set the editing instruction that guides the
# re-render (for example a character swap or insertion)". Phrasing these as replace-X-with-Y is
# what makes it restyle the craft and not just the scenery.
PROMPTS = {
    "luna": "Replace the flat purple polygon spacecraft with a photorealistic gold-foil Apollo "
            "lunar module with landing legs and a bright engine plume. Turn the white ground into "
            "real grey moon regolith under harsh sunlight against a black starry sky. Cinematic 35mm.",
    "ares": "Replace the flat purple polygon spacecraft with a photorealistic Mars lander with "
            "landing legs and a retro-rocket plume. Turn the ground into rust-red Martian dust "
            "under a thin orange haze with wind-blown dust. Cinematic documentary.",
    "titan": "Replace the flat purple polygon spacecraft with a photorealistic space probe "
             "descending on landing legs. Turn the ground into icy golden dunes under Titan's "
             "thick orange haze and dim light. Cinematic.",
}

# Optional: a photo of a real lander for X2 to swap in (set_reference_image). Any aspect ratio;
# Reactor scales and pads it. Use a public-domain or your own image.
REFERENCE_IMAGE = os.environ.get("REACTOR_REFERENCE_IMAGE")


def commands_from_schema(schema):
    """Command names a model accepts, read out of the OpenAPI document request_schema() returns.

    Reactor exposes each command as a path, and most are auto-generated `set_<field>` setters
    whose payload key is the field itself. Names differ per model, so we discover rather than
    hardcode: X2 takes `set_prompt`, not the `setPrompt` spelling other models use.
    """
    if not isinstance(schema, dict):
        return []
    names = []
    for path in (schema.get("paths") or {}):
        names.append(str(path).strip("/").split("/")[-1])
    for key in ("commands", "x-reactor"):
        block = schema.get(key)
        if isinstance(block, dict):
            names += [str(k) for k in (block.get("commands") or block).keys()]
    seen = set()
    return [n for n in names if n and not (n in seen or seen.add(n))]


def pick_command(names, *keywords):
    """The command whose name mentions every keyword, preferring a `set_` setter."""
    hits = [n for n in names if all(k in n.lower() for k in keywords)]
    return next((h for h in hits if h.lower().startswith("set")), hits[0] if hits else None)


async def set_prompt_on(reactor, prompt, names=None):
    """Set the text prompt, trying the discovered name first and known spellings after.

    Returns the command name that worked, or None. A model that takes no prompt is not an
    error: the session still restyles, it just is not steered by text.
    """
    tried, candidates = [], []
    if names:
        found = pick_command(names, "prompt")
        if found:
            candidates.append(found)
    candidates += ["set_prompt", "setPrompt", "prompt"]
    for name in candidates:
        if name in tried:
            continue
        tried.append(name)
        try:
            await reactor.send_command(name, {"prompt": prompt})
            return name
        except Exception:
            continue
    return None


async def set_reference_on(reactor, path, names=None):
    """Upload a reference image and hand it to the model, so it swaps the craft itself.

    Without this X2 restyles the scenery but leaves the lander as the flat polygon it sees.
    The file is uploaded first and passed as an upload reference, which is what the schema's
    ReactorUploadReference expects. Returns the command used, or None if it did not take.
    """
    if not path or not os.path.exists(path):
        return None
    name = (pick_command(names, "reference", "image") if names else None) or "set_reference_image"
    try:
        ref = await reactor.upload_file(path)
        await reactor.send_command(name, {"reference_image": ref})
        return name
    except Exception:
        return None


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
        self.commands = []
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

        # Ask the model what it accepts instead of assuming. An unknown command raises and would
        # otherwise abort a session that is already being billed.
        try:
            schema = await asyncio.wait_for(self.r.request_schema(), timeout=20)
            self.commands = commands_from_schema(schema)
        except Exception:
            self.commands = []
        # The reference image goes first: changing it mid-run restarts the stream.
        ref_used = await set_reference_on(self.r, REFERENCE_IMAGE, self.commands)
        used = await set_prompt_on(self.r, PROMPTS.get(self.world, PROMPTS["luna"]), self.commands)

        await self.send_status({"reactor": "live", "limit": int(self.limit),
                                "prompt_command": used or "none",
                                "reference": os.path.basename(REFERENCE_IMAGE) if ref_used else None})
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
            await set_prompt_on(self.r, prompt[:1000], self.commands)

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
