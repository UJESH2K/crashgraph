"""crashgraph control room: python server.py  ->  http://localhost:8000"""
import asyncio
import json
import os

import uvicorn
from fastapi import Body, FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
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


def mem_for(world):
    return trainer.mem if world == trainer.world.key else GraphMemory(db, world)


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
            trainer.command(msg["cmd"], msg.get("arg"))
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
    return explain.learning_curve(mem_for(world or trainer.world.key))


@app.get("/api/explain/{n}")
def explain_ep(n: int, world: str = None):
    return explain.explain_episode(mem_for(world or trainer.world.key), n)


@app.get("/api/subgraph/{n}")
def subgraph(n: int, world: str = None):
    return explain.subgraph(mem_for(world or trainer.world.key), n)


@app.get("/api/hubs")
def hubs(world: str = None):
    return explain.danger_hubs(mem_for(world or trainer.world.key))


@app.get("/api/signatures")
def signatures(world: str = None, since: int = 0):
    return explain.crash_signatures(mem_for(world or trainer.world.key), since=since)


@app.get("/api/families")
def families(world: str = None):
    return explain.communities(mem_for(world or trainer.world.key))


@app.get("/api/frames/{n}")
def frames(n: int, world: str = None):
    d = trainer.load_frames(world or trainer.world.key, n)
    return d if d else JSONResponse({"error": "no recording for that attempt"}, status_code=404)


@app.get("/api/worlds")
def worlds():
    return [w.to_dict() | {"stats": GraphMemory(db, k).stats()} for k, w in WORLDS.items()]


app.mount("/static", StaticFiles(directory=os.path.join(HERE, "web")), name="static")


@app.get("/")
def index():
    return FileResponse(os.path.join(HERE, "web", "index.html"))


if __name__ == "__main__":
    uvicorn.run(app, host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ.get("PORT", 8000)))
