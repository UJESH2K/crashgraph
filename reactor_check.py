"""Check the optional Reactor photoreal layer, with and without spending GPU credit.

    python reactor_check.py                 # free: key, account, model, SDK surface, budget
    python reactor_check.py --live --yes    # paid: stream a real trained landing through xmax/x2

The free pass answers "is this wired up correctly". The --live pass is the only part that
costs anything, so it is opt-in, time-capped, and reports what it used when it finishes.

Nothing here touches the lander's learning: Reactor only ever sees pixels we already rendered.
"""
import argparse
import asyncio
import glob
import json
import os
import sys
import time
import urllib.error
import urllib.request

from crashgraph import reactor_bridge
from crashgraph.memory import load_env

API = "https://api.reactor.inc"
MODEL = os.environ.get("REACTOR_MODEL", "xmax/x2")
# X2 wants an editing instruction, not a caption - the bridge holds the per-world wording.
def prompt_for(world):
    from crashgraph import reactor_bridge as rb
    return rb.PROMPTS.get(world, rb.PROMPTS["luna"])


def _get(path, key, timeout=25):
    req = urllib.request.Request(API + path, headers={"Authorization": f"Bearer {key}"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, e.read()[:200].decode("utf8", "replace")
    except Exception as e:
        return None, f"{type(e).__name__}: {e}"


def offline_checks():
    """Everything that can be known without starting a billable session."""
    load_env()
    key = os.environ.get("REACTOR_API_KEY")
    print(f"{'REACTOR_API_KEY':24} {'set (' + key[:6] + '...)' if key else 'MISSING'}")
    if not key:
        print("\nSet REACTOR_API_KEY in .env to enable the photoreal view. Everything else still runs.")
        return None

    try:
        import reactor_sdk
        print(f"{'reactor-sdk':24} {getattr(reactor_sdk, '__version__', 'installed')}")
    except ImportError:
        print(f"{'reactor-sdk':24} MISSING  (pip install reactor-sdk pillow)")
        return None

    status, me = _get("/me", key)
    print(f"{'account':24} {me.get('email') if isinstance(me, dict) else me} [{status}]")

    status, models = _get("/models", key)
    if isinstance(models, list):
        hit = next((m for m in models if m.get("name") == MODEL), None)
        print(f"{'model ' + MODEL:24} "
              + (f"{hit['status']}, {hit.get('gpu_type')}" if hit else f"NOT FOUND among {len(models)} models"))
    else:
        print(f"{'models':24} [{status}] {models}")

    from crashgraph import reactor_bridge
    ok, msg = reactor_bridge.available()
    print(f"{'bridge.available()':24} {ok} — {msg}")
    return key


def render_flight(out_dir, world="luna", n_frames=160):
    """Render a real landing flown from the graph. Costs nothing and uses no Reactor time."""
    import gymnasium as gym
    from PIL import Image

    from crashgraph.agent import GraphPilot
    from crashgraph.memory import GraphMemory, connect
    from crashgraph.worlds import get_world

    w = get_world(world)
    db, where = connect()
    mem = GraphMemory(db, world)
    print(f"  graph {where}: {mem.stats()['episodes']} attempts of experience")
    env = gym.make("LunarLander-v3", render_mode="rgb_array", **w.env_kwargs())
    pilot = GraphPilot(mem, seed=0)

    best = None
    for seed in (500000, 500002, 500003):
        obs, _ = env.reset(seed=seed)
        pilot.begin(0.0, learn=False)          # exam: graph only, no exploration, no writes
        frames, score, r, term = [], 0.0, 0.0, False
        a, _q = pilot.act(obs)
        for _ in range(1000):
            obs, r, term, trunc, _ = env.step(a)
            score += r
            frames.append(env.render())
            if term or trunc:
                break
            a, _q = pilot.act(obs)
        if term and r > -100 + 1e-6 and (best is None or score > best[1]):
            best = (frames, score, seed)
    env.close()
    if best is None:
        raise SystemExit("no landing to film — train this world first (python train.py)")

    frames, score, seed = best
    os.makedirs(out_dir, exist_ok=True)
    for f in glob.glob(os.path.join(out_dir, "*.jpg")):
        os.remove(f)
    keep = frames[::2][:n_frames]
    for i, f in enumerate(keep):
        Image.fromarray(f).resize((640, 448), Image.LANCZOS).save(
            os.path.join(out_dir, f"{i:04d}.jpg"), quality=88)
    print(f"  filmed seed {seed}: score {score:.1f}, {len(keep)} frames -> {out_dir}")
    return sorted(glob.glob(os.path.join(out_dir, "*.jpg")))


async def live(key, files, out_dir, cap, reference=None, world="luna"):
    """The billable part: stream our frames through X2 and keep what comes back."""
    import numpy as np
    from PIL import Image
    from reactor_sdk import Reactor, ReactorStatus

    imgs = [np.asarray(Image.open(f).convert("RGB")) for f in files]
    r = Reactor(model_name=MODEL, api_key=key, max_session_duration_seconds=int(cap))
    loop = asyncio.get_running_loop()
    ready = asyncio.Event()
    got = []

    @r.on_status(ReactorStatus.READY)
    def _ready(_s):
        loop.call_soon_threadsafe(ready.set)

    @r.on_error
    def _err(e):
        print("  sdk error:", repr(e)[:200])

    @r.track("main_video").on_frame
    def _frame(fr):
        got.append(fr)

    t0 = time.time()
    await r.connect()
    print(f"  connected ({time.time() - t0:.1f}s), session {r.get_session_id()}")
    await asyncio.wait_for(ready.wait(), timeout=90)
    t_ready = time.time()
    print(f"  READY after {t_ready - t0:.1f}s")

    names = []
    try:
        schema = await asyncio.wait_for(r.request_schema(), timeout=20)
        os.makedirs(out_dir, exist_ok=True)
        path = os.path.join(out_dir, "schema.json")
        with open(path, "w", encoding="utf8") as f:
            json.dump(schema, f, indent=1)
        names = reactor_bridge.commands_from_schema(schema)
        print(f"  schema saved to {path}")
        print(f"  commands the model accepts: {names}")
    except Exception as e:
        print(f"  request_schema failed: {type(e).__name__}: {str(e)[:150]}")

    src = await r.track("source").publish()
    if reference:
        ref_cmd = await reactor_bridge.set_reference_on(r, reference, names)
        print(f"  reference image {os.path.basename(reference)}: "
              f"{'sent via ' + ref_cmd if ref_cmd else 'FAILED (continuing without it)'}")
    used_cmd = await reactor_bridge.set_prompt_on(r, prompt_for(world), names)
    print(f"  prompt set via: {used_cmd or 'NO WORKING COMMAND (streaming unsteered)'}")

    for i, im in enumerate(imgs):
        if time.time() - t_ready > cap - 8:
            print(f"  stopped pushing at frame {i} (time cap)")
            break
        src.push_frame(im)
        await asyncio.sleep(1 / 16)
    print(f"  pushed {i + 1} frames, {len(got)} returned so far")

    deadline = time.time() + 6
    while time.time() < deadline and len(got) < 8:
        await asyncio.sleep(0.3)

    os.makedirs(out_dir, exist_ok=True)
    step = max(1, len(got) // 12) if got else 1
    for i, fr in enumerate(got[::step][:12]):
        Image.fromarray(fr).save(os.path.join(out_dir, f"out_{i:03d}.jpg"), quality=90)
    used = time.time() - t0
    await r.disconnect()
    print(f"\n  received {len(got)} restyled frames"
          + (f" {got[0].shape}" if got else "") + f", samples in {out_dir}")
    print(f"  session lasted {used:.1f}s")
    return used, len(got)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--live", action="store_true", help="run a real streaming session (uses GPU credit)")
    ap.add_argument("--yes", action="store_true", help="confirm the paid run without prompting")
    ap.add_argument("--seconds", type=float, default=None, help="session cap (default REACTOR_MAX_SECONDS)")
    ap.add_argument("--world", default="luna")
    ap.add_argument("--reference", default=os.environ.get("REACTOR_REFERENCE_IMAGE"),
                    help="photo of a real lander for X2 to swap in (set_reference_image)")
    a = ap.parse_args()

    key = offline_checks()
    if not a.live:
        print("\nAll free checks done. Add --live --yes to run a real session (this spends credit).")
        return
    if not key:
        raise SystemExit("cannot run --live without a working key and SDK")

    from crashgraph import reactor_bridge
    cap = a.seconds or min(float(os.environ.get("REACTOR_MAX_SECONDS", 60)), reactor_bridge.budget_left())
    if cap <= 0:
        raise SystemExit("REACTOR_BUDGET_SECONDS is used up; raise it in .env to continue")
    if not a.yes:
        print(f"\nThis will run xmax/x2 on a GPU for up to {cap:.0f}s and charge your Reactor account.")
        if input("Type 'yes' to continue: ").strip().lower() != "yes":
            return

    data = os.environ.get("CRASHGRAPH_DATA", "data")
    print("\nfilming a real landing (free, no Reactor time):")
    files = render_flight(os.path.join(data, "reactor_demo", "in"), a.world)
    print(f"\nstreaming through {MODEL} (cap {cap:.0f}s):")
    used, n = asyncio.run(live(key, files, os.path.join(data, "reactor_demo", "out"), cap,
                               reference=a.reference, world=a.world))
    reactor_bridge._add_usage(used)
    print(f"  budget left: {reactor_bridge.budget_left():.0f}s")
    if n == 0:
        print("\n  No frames came back. The session connected but produced nothing —\n"
              "  check the command names printed above against the model's schema.")
        sys.exit(1)


if __name__ == "__main__":
    main()
