"""FalkorDB graph memory. This is the only place the lander's knowledge lives.

Graph per world: `crashgraph_<world>` (FalkorDB multi-graph = one isolated
memory per world/tenant inside one database instance).

Nodes
  (:World      {key, episodes, landed, crashed})                 one per graph
  (:Tile       {k, q:[4 floats], n})                             procedural memory: action values
  (:Situation  {k, alt, vy, x, vx, tilt, legs, label,
                visits, crash_after, land_after})                semantic memory: what tends to follow what
  (:Outcome    {name})                                           landed_pad, landed_off_pad, crashed, flew_off, timed_out, interrupted
  (:Episode    {n, score, outcome, steps, fuel, epsilon,
                learned, world, ts, gusts})                      episodic memory: every attempt

Relationships
  (:Episode)-[:NEXT]->(:Episode)                                 timeline
  (:Episode)-[:VISITED {i, frames, acts:[4]}]->(:Situation)       the path one attempt took
  (:Situation)-[:FLOWS {n, crash, land, cost}]->(:Situation)      aggregated transitions across all attempts
  (:Situation)-[:ENDED {n}]->(:Outcome)                           where attempts finished
  (:Situation)-[:SAFE {cost}]->(:Situation|:Outcome)              derived: transitions proven to lead to landings
  (:Episode)-[:RESULTED_IN]->(:Outcome)
"""
import os
import time
import threading

OUTCOMES = ["landed_pad", "landed_off_pad", "crashed", "flew_off", "timed_out", "interrupted"]
SUCCESS = {"landed_pad", "landed_off_pad"}
FAIL = {"crashed", "flew_off"}


def load_env(path=None):
    """Tiny .env reader (KEY=VALUE lines) so secrets stay out of the code. Real env vars win."""
    path = path or os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")
    if os.path.exists(path):
        for line in open(path):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())


def connect():
    """FALKORDB_URL (e.g. redis://user:pass@host:port for FalkorDB Cloud/Docker)
    or an embedded FalkorDBLite database on disk."""
    load_env()
    url = os.environ.get("FALKORDB_URL")
    if not url and os.name == "nt":
        url = "redis://localhost:6379"   # FalkorDBLite has no Windows build: use Docker (docker compose up -d)
    if url:
        from falkordb import FalkorDB
        return FalkorDB.from_url(url), url
    from redislite.falkordb_client import FalkorDB
    path = os.environ.get("CRASHGRAPH_DB", os.path.join(os.getcwd(), "data", "crashgraph.db"))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    return FalkorDB(path), f"embedded:{path}"


class GraphMemory:
    def __init__(self, db, world: str):
        self.db = db
        self.world = world
        self.name = f"crashgraph_{world}"
        self.g = db.select_graph(self.name)
        self.lock = threading.Lock()
        self.ensure_schema()

    # ------------------------------------------------------------------ schema
    def q(self, cypher, params=None, ro=False, timeout=None):
        if ro:
            return self.g.ro_query(cypher, params or {}, timeout=timeout)
        return self.g.query(cypher, params or {}, timeout=timeout)

    def ensure_schema(self):
        for label, prop in [("Tile", "k"), ("Situation", "k"), ("Episode", "n"), ("Outcome", "name")]:
            try:
                self.q(f"CREATE INDEX FOR (x:{label}) ON (x.{prop})")
            except Exception:
                pass  # index already exists
        self.q("MERGE (w:World {key:$w}) ON CREATE SET w.episodes=0, w.landed=0, w.crashed=0",
               {"w": self.world})
        self.q("UNWIND $os AS o MERGE (:Outcome {name:o})", {"os": OUTCOMES})

    # ------------------------------------------------------- procedural memory
    def read_tiles(self, keys):
        """Action values for the given tile keys. Missing tiles are unknown (zeros)."""
        res = self.q("MATCH (t:Tile) WHERE t.k IN $ks RETURN t.k, t.q", {"ks": list(keys)}, ro=True)
        return {k: v for k, v in res.result_set}

    def write_tiles(self, deltas):
        """deltas: {key: [d0,d1,d2,d3]}. Adds to stored values (creates unseen tiles)."""
        rows = [{"k": k, "d": [float(x) for x in d]} for k, d in deltas.items()]
        for i in range(0, len(rows), 2000):
            self.q("""UNWIND $rows AS r
                      MERGE (t:Tile {k:r.k}) ON CREATE SET t.q=[0.0,0.0,0.0,0.0], t.n=0
                      SET t.q=[i IN range(0,3) | t.q[i] + r.d[i]], t.n=t.n+1""",
                   {"rows": rows[i:i + 2000]})

    # --------------------------------------------- episodic + semantic memory
    def episode_count(self):
        r = self.q("MATCH (w:World {key:$w}) RETURN w.episodes", {"w": self.world}, ro=True)
        return r.result_set[0][0] if r.result_set else 0

    def record_episode(self, ep):
        """ep: dict with n, score, outcome, steps, fuel, epsilon, learned, gusts,
        path: [ {k, fields, label, frames, acts:[4]} ...] (consecutive situations)."""
        o = ep["outcome"]
        success, fail = int(o in SUCCESS), int(o in FAIL)
        path = ep["path"]
        sits = {}
        for p in path:
            sits.setdefault(p["k"], p)
        self.q("""MATCH (w:World {key:$w})
                  SET w.episodes = w.episodes + 1, w.landed = w.landed + $s, w.crashed = w.crashed + $f
                  CREATE (e:Episode {n:$n, world:$w, score:$score, outcome:$o, steps:$steps, fuel:$fuel,
                                     epsilon:$eps, learned:$learned, gusts:$gusts, ts:$ts})
                  WITH e
                  MATCH (out:Outcome {name:$o}) CREATE (e)-[:RESULTED_IN]->(out)
                  WITH e
                  OPTIONAL MATCH (prev:Episode {n:$n - 1})
                  FOREACH (_ IN CASE WHEN prev IS NULL THEN [] ELSE [1] END | CREATE (prev)-[:NEXT]->(e))""",
               {"w": self.world, "n": ep["n"], "score": float(ep["score"]), "o": o, "steps": ep["steps"],
                "fuel": float(ep["fuel"]), "eps": float(ep["epsilon"]), "learned": ep["learned"],
                "gusts": ep.get("gusts", 0), "ts": time.time(), "s": success, "f": fail})
        # situations touched by this attempt (counted once per attempt for risk stats)
        self.q("""UNWIND $sits AS s
                  MERGE (x:Situation {k:s.k})
                  ON CREATE SET x += s.f, x.label=s.label, x.visits=0, x.crash_after=0, x.land_after=0
                  SET x.visits = x.visits + 1, x.crash_after = x.crash_after + $f, x.land_after = x.land_after + $s""",
               {"sits": [{"k": k, "f": p["fields"], "label": p["label"]} for k, p in sits.items()],
                "s": success, "f": fail})
        # the path itself
        self.q("""MATCH (e:Episode {n:$n})
                  UNWIND $path AS p
                  MATCH (x:Situation {k:p.k})
                  CREATE (e)-[:VISITED {i:p.i, frames:p.frames, acts:p.acts}]->(x)""",
               {"n": ep["n"], "path": [{"i": i, "k": p["k"], "frames": p["frames"], "acts": p["acts"]}
                                        for i, p in enumerate(path)]})
        # aggregated transitions
        pairs = [{"a": path[i]["k"], "b": path[i + 1]["k"]} for i in range(len(path) - 1)]
        if pairs:
            self.q("""UNWIND $pairs AS p
                      MATCH (a:Situation {k:p.a}), (b:Situation {k:p.b})
                      MERGE (a)-[r:FLOWS]->(b) ON CREATE SET r.n=0, r.crash=0, r.land=0
                      SET r.n=r.n+1, r.crash=r.crash+$f, r.land=r.land+$s""",
                   {"pairs": pairs, "s": success, "f": fail})
        if path:
            self.q("""MATCH (a:Situation {k:$k}), (o:Outcome {name:$o})
                      MERGE (a)-[r:ENDED]->(o) ON CREATE SET r.n=0 SET r.n=r.n+1""",
                   {"k": path[-1]["k"], "o": o})

    def refresh_costs(self):
        """Edge cost for safe-path search: -log P(this transition was on a landing attempt), smoothed."""
        self.q("""MATCH ()-[r:FLOWS]->()
                  SET r.cost = -log((toFloat(r.land) + 0.5) / (toFloat(r.n) + 1.0))""")
        self.q("""MATCH ()-[r:ENDED]->(o:Outcome)
                  SET r.cost = CASE WHEN o.name IN ['landed_pad','landed_off_pad'] THEN 0.0 ELSE 50.0 END""")
        # SAFE: the sparse subgraph of transitions that have led to a landing at least twice.
        # Safe-route search runs on it; running path search over every FLOWS loop is needlessly expensive.
        self.q("MATCH ()-[s:SAFE]->() DELETE s")
        self.q("""MATCH (a:Situation)-[r:FLOWS]->(b:Situation) WHERE r.land >= 2
                  CREATE (a)-[:SAFE {cost: r.cost, n: r.n, land: r.land}]->(b)""")
        self.q("""MATCH (a:Situation)-[r:ENDED]->(o:Outcome {name:'landed_pad'}) WHERE r.n >= 2
                  CREATE (a)-[:SAFE {cost: 0.0, n: r.n, land: r.n}]->(o)""")

    # ----------------------------------------------------------- maintenance
    def stats(self):
        r = self.q("""MATCH (w:World {key:$w})
                      OPTIONAL MATCH (t:Tile) WITH w, count(t) AS tiles
                      OPTIONAL MATCH (s:Situation) WITH w, tiles, count(s) AS sits
                      OPTIONAL MATCH ()-[f:FLOWS]->() WITH w, tiles, sits, count(f) AS flows
                      RETURN w.episodes, w.landed, w.crashed, tiles, sits, flows""",
                   {"w": self.world}, ro=True)
        e, l, c, t, s, f = r.result_set[0]
        return {"world": self.world, "graph": self.name, "episodes": e, "landed": l, "crashed": c,
                "tiles": t, "situations": s, "flows": f}

    def wipe(self):
        try:
            self.g.delete()
        except Exception:
            pass
        self.g = self.db.select_graph(self.name)
        self.ensure_schema()

    def _graphs(self):
        return [x.decode() if isinstance(x, bytes) else x for x in self.db.connection.execute_command("GRAPH.LIST")]

    def snapshot(self, tag: str):
        dst = f"{self.name}__snap__{tag}"
        if dst in self._graphs():
            self.db.select_graph(dst).delete()
        self.db.connection.execute_command("GRAPH.COPY", self.name, dst)
        return dst

    def snapshots(self):
        pre = f"{self.name}__snap__"
        return sorted(g[len(pre):] for g in self._graphs() if g.startswith(pre))

    def restore(self, tag: str):
        src = f"{self.name}__snap__{tag}"
        if src not in self._graphs():
            raise KeyError(tag)
        try:
            self.g.delete()
        except Exception:
            pass
        self.db.connection.execute_command("GRAPH.COPY", src, self.name)
        self.g = self.db.select_graph(self.name)

    def seed_from(self, other_world: str):
        """Shared procedural memory: copy another world's tiles into this one (episodes stay separate)."""
        src = self.db.select_graph(f"crashgraph_{other_world}")
        res = src.ro_query("MATCH (t:Tile) RETURN t.k, t.q")
        rows = [{"k": k, "q": q} for k, q in res.result_set]
        for i in range(0, len(rows), 2000):
            self.q("""UNWIND $rows AS r MERGE (t:Tile {k:r.k})
                      ON CREATE SET t.n=0 SET t.q=r.q""", {"rows": rows[i:i + 2000]})
        self.q("MATCH (w:World {key:$w}) SET w.seeded_from=$o", {"w": self.world, "o": other_world})
        return len(rows)
