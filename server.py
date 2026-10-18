"""crashgraph control room: python server.py  ->  http://localhost:8000"""
import asyncio
import json
import os

import uvicorn
from fastapi import Body, FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles

from crashgraph import explain, reactor_bridge
from crashgraph.memory import GraphMemory, connect
from crashgraph.trainer import Trainer
from crashgraph.worlds import WORLDS

HERE = os.path.dirname(os.path.abspath(__file__))


def _load_env(path):
    """Tiny .env reader (KEY=VALUE lines) so secrets stay out of the code."""
    if os.path.exists(path):
        for line in open(path):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())


_load_env(os.path.join(HERE, ".env"))
os.environ.setdefault("CRASHGRAPH_DATA", os.path.join(HERE, "data"))
os.environ.setdefault("CRASHGRAPH_DB", os.path.join(HERE, "data", "crashgraph.db"))
app = FastAPI(title="crashgraph")
app.add_middleware(GZipMiddleware, minimum_size=1024)
# The Next console runs on its own origin and calls these routes directly rather than through
# its own proxy, so it has to be allowed to.
#
# Localhost is always allowed, because that is the setup the repo ships with. Anything else is
# opt-in through CRASHGRAPH_ORIGINS (comma-separated), which is what a split deployment needs:
# the console on a host like Vercel, this process somewhere that can run it. It is deliberately
# not a wildcard - these routes can wipe a world's memory, and that is not something an
# arbitrary page should be able to ask for.
_LOCAL = r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$"
_EXTRA = [o.strip().rstrip("/") for o in os.environ.get("CRASHGRAPH_ORIGINS", "").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_EXTRA,
    allow_origin_regex=_LOCAL,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)
@app.middleware("http")
async def cache_static(request, call_next):
    """Let the browser keep the heavy, never-changing things.

    The console ships ~19 MB of glTF and a hashed JS bundle. Without this every reload pulls
    them again, which on a small instance is most of the wait. Next's own output is content
    hashed, so it is safe to pin for a year; the models are pinned for a day because they sit
    at a stable path and a new build should still be able to replace them.
    """
    response = await call_next(request)
    path = request.url.path
    if path.startswith("/_next/static/"):
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    elif path.startswith("/assets/") or path.startswith("/static/assets/"):
        response.headers["Cache-Control"] = "public, max-age=86400"
    return response


clients: set = set()
loop: asyncio.AbstractEventLoop | None = None
db, DB_WHERE = connect()


def broadcast(msg):
    """Called from the trainer thread; hands the message to every websocket's queue."""
    if loop is None:
        return
    data = json.dumps(msg)
    for q in list(clients):
        def put(q=q):
            if q.qsize() > 400 and msg.get("type") == "frame":
                return  # slow client: drop frames, never block the physics
            q.put_nowait(data)
        loop.call_soon_threadsafe(put)


trainer = Trainer(db, world=os.environ.get("CRASHGRAPH_WORLD", "luna"),
                  data_dir=os.path.join(HERE, "data"), broadcast=broadcast)


@app.on_event("startup")
async def _startup():
    global loop
    loop = asyncio.get_running_loop()
    trainer.start()


@app.on_event("shutdown")
async def _shutdown():
    # Hand back the writer lease so the next run is not locked out for a lease period.
    trainer.ctl.stop = True
    trainer.release_writer()


def mem_for(world):
    return trainer.mem if world == trainer.world.key else GraphMemory(db, world)


def safe(fn, *a, **kw):
    """Run a read against the graph and answer with a sentence if it cannot be done.

    Every panel in the console has somewhere to put a message and nowhere to put a stack
    trace, and one slow query must not blank a screen that is otherwise working.
    """
    try:
        return fn(*a, **kw)
    except Exception as e:
        return JSONResponse({"error": f"the graph could not answer that: {e}"}, status_code=200)


@app.websocket("/ws")
async def ws(sock: WebSocket):
    await sock.accept()
    q: asyncio.Queue = asyncio.Queue()
    clients.add(q)
    await sock.send_text(json.dumps(trainer.state() | {"db": DB_WHERE}))

    async def pump():
        while True:
            await sock.send_text(await q.get())

    task = asyncio.create_task(pump())
    try:
        while True:
            msg = json.loads(await sock.receive_text())
            try:
                trainer.command(msg["cmd"], msg.get("arg"))
            except Exception as e:
                # A bad message from one client must not take down the control room.
                await sock.send_text(json.dumps({"type": "log", "text": f"ignored command: {e}"}))
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        task.cancel()
        clients.discard(q)


@app.get("/api/reactor")
def reactor_status():
    ok, msg = reactor_bridge.available()
    return {"available": ok, "message": msg, "model": reactor_bridge.MODEL}


@app.websocket("/ws/reactor")
async def ws_reactor(sock: WebSocket):
    """Browser sends JPEG frames of its own 3D render; we relay to Reactor and send restyled frames back."""
    await sock.accept()
    ok, msg = reactor_bridge.available()
    if not ok:
        await sock.send_text(json.dumps({"reactor": "unavailable", "why": msg}))
        await sock.close()
        return
    hello = json.loads(await sock.receive_text())

    async def out(data):
        try:
            await sock.send_bytes(data)
        except Exception:
            pass

    async def status(d):
        try:
            await sock.send_text(json.dumps(d))
        except Exception:
            pass

    sess = reactor_bridge.ReactorSession(hello.get("world", trainer.world.key), out, status)
    try:
        await sess.start()
        while not sess.closed:
            m = await sock.receive()
            if m.get("bytes"):
                await sess.push_jpeg(m["bytes"])
            elif m.get("text"):
                d = json.loads(m["text"])
                if "prompt" in d:
                    await sess.set_prompt(d["prompt"])
                if d.get("stop"):
                    break
            elif m.get("type") == "websocket.disconnect":
                break
    except Exception as e:
        await status({"reactor": "error", "why": str(e)[:300]})
    finally:
        await sess.stop()


@app.post("/api/cmd")
def cmd(body: dict = Body(...)):
    trainer.command(body["cmd"], body.get("arg"))
    return trainer.state()


@app.get("/api/state")
def state():
    return trainer.state() | {"db": DB_WHERE}


@app.get("/api/curve")
def curve(world: str = None):
    return safe(explain.learning_curve, mem_for(world or trainer.world.key))


@app.get("/api/explain/{n}")
def explain_ep(n: int, world: str = None):
    # A graph query that times out under load must not come back as a bare 500: the panel has
    # somewhere to put a sentence, and nowhere to put a stack trace.
    return safe(explain.explain_episode, mem_for(world or trainer.world.key), n)


@app.get("/api/subgraph/{n}")
def subgraph(n: int, world: str = None):
    return safe(explain.subgraph, mem_for(world or trainer.world.key), n)


@app.get("/api/hubs")
def hubs(world: str = None):
    return safe(explain.danger_hubs, mem_for(world or trainer.world.key))


@app.get("/api/signatures")
def signatures(world: str = None, since: int = 0):
    return safe(explain.crash_signatures, mem_for(world or trainer.world.key), since=since)


@app.get("/api/heatmap")
def heatmap(world: str = None):
    return safe(explain.risk_grid, mem_for(world or trainer.world.key))


@app.get("/api/memory/graph")
def memory_graph(world: str = None, min_n: int = 1):
    """The whole semantic memory as positions and weights, for the console's 3D graph view."""
    return safe(explain.memory_graph, mem_for(world or trainer.world.key), min_n=min_n)


@app.get("/api/memory/growth")
def memory_growth(world: str = None):
    """Situations first seen per attempt, measured from the graph rather than modelled."""
    return safe(explain.memory_growth, mem_for(world or trainer.world.key))


@app.get("/api/families")
def families(world: str = None):
    return safe(explain.communities, mem_for(world or trainer.world.key))


@app.get("/api/frames/{n}")
def frames(n: int, world: str = None):
    d = trainer.load_frames(world or trainer.world.key, n)
    return d if d else JSONResponse({"error": "no recording for that attempt"}, status_code=404)


@app.get("/api/worlds")
def worlds():
    return [w.to_dict() | {"stats": GraphMemory(db, k).stats()} for k, w in WORLDS.items()]


# ---------------------------------------------------------------- the console
# Two front ends, same backend. The vanilla one is always served, at /classic. The Next console
# is served too when it has been exported (`CRASHGRAPH_EXPORT=1 npm run build` in web-next),
# which is how the single-container deployment works: one process, one port, one origin, so no
# CORS to configure and no second host to keep in sync. Without the export this falls back to
# the vanilla console at / and the Next console is expected on its own port in development.
LEGACY = os.path.join(HERE, "web")
CONSOLE = os.path.join(HERE, "web-next", "out")

app.mount("/static", StaticFiles(directory=LEGACY), name="static")


@app.get("/classic")
def classic():
    return FileResponse(os.path.join(LEGACY, "index.html"))


if os.path.isfile(os.path.join(CONSOLE, "index.html")):
    # Mounted last so every /api and /ws route above still wins; html=True makes it answer /
    # with index.html.
    app.mount("/", StaticFiles(directory=CONSOLE, html=True), name="console")
else:
    @app.get("/")
    def index():
        return FileResponse(os.path.join(LEGACY, "index.html"))


if __name__ == "__main__":
    uvicorn.run(app, host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ.get("PORT", 8000)))
