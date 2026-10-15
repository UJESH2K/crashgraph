"""MCP server: lets any LLM agent interrogate the lander's graph memory.

Run:  python mcp_server.py            (stdio, for Claude Desktop / Cursor / any MCP client)
Use FALKORDB_URL to point at the same FalkorDB the trainer writes to (e.g. Docker or FalkorDB Cloud).
With the embedded database, stop the control room first: only one process can own the embedded file.
"""
import json

try:                                   # mcp >= 2
    from mcp.server.mcpserver import MCPServer as Server
except ImportError:                    # mcp 1.x
    from mcp.server.fastmcp import FastMCP as Server

from crashgraph import explain
from crashgraph.memory import GraphMemory, connect
from crashgraph.worlds import WORLDS

db, WHERE = connect()
mcp = Server("crashgraph", instructions=(
    "Tools over a self-learning rocket lander's memory, stored in FalkorDB. Each world (luna, ares, titan) "
    "has its own graph. Attempts are Episode nodes; coarse states are Situation nodes linked by FLOWS edges "
    "carrying how often that transition happened on landing vs crashing attempts; Tile nodes hold the learned "
    "action values. Use explain_attempt to say why an attempt crashed, and cite the situations and numbers."))


def _mem(world):
    if world not in WORLDS:
        raise ValueError(f"world must be one of {list(WORLDS)}")
    return GraphMemory(db, world)


@mcp.tool()
def memory_stats(world: str = "luna") -> dict:
    """How much the lander has experienced and learned in a world (attempts, landings, crashes, graph size)."""
    return _mem(world).stats()


@mcp.tool()
def explain_attempt(attempt: int, world: str = "luna") -> dict:
    """Why one attempt ended the way it did: its path through situations with crash risk at each step,
    the point of no return, what landing attempts did differently there, and the safest known route
    (weighted shortest path via algo.SPpaths)."""
    return explain.explain_episode(_mem(world), attempt)


@mcp.tool()
def danger_hubs(world: str = "luna", k: int = 8) -> dict:
    """Situations that many attempts funnel through and that usually end in a crash (PageRank x crash rate)."""
    return explain.danger_hubs(_mem(world), k=k)


@mcp.tool()
def crash_signatures(world: str = "luna", since_attempt: int = 0) -> dict:
    """How the lander crashes: groups failed attempts by the situation they were in when they ended."""
    return explain.crash_signatures(_mem(world), since=since_attempt)


@mcp.tool()
def failure_families(world: str = "luna") -> dict:
    """Communities of situations (label propagation over FLOWS) with each family's crash rate."""
    return explain.communities(_mem(world))


@mcp.tool()
def learning_progress(world: str = "luna", window: int = 100) -> dict:
    """Landing rate and average score per window of attempts, to show whether the graph is getting smarter."""
    c = explain.learning_curve(_mem(world))
    out = []
    for i in range(0, len(c), window):
        w = c[i:i + window]
        out.append({"attempts": f"{w[0]['n']}-{w[-1]['n']}", "avg_score": round(sum(p["score"] for p in w) / len(w), 1),
                    "landed": sum(p["outcome"].startswith("landed") for p in w)})
    return {"windows": out}


@mcp.tool()
def read_cypher(query: str, world: str = "luna") -> str:
    """Run a READ-ONLY Cypher query against a world's graph (writes are rejected by FalkorDB's GRAPH.RO_QUERY).
    Labels: World, Episode, Situation, Outcome, Tile. Relationships: NEXT, VISITED, FLOWS, ENDED, RESULTED_IN."""
    res = _mem(world).q(query, ro=True)
    rows = [[str(v) if not isinstance(v, (int, float, str, list, type(None))) else v for v in r] for r in res.result_set[:200]]
    return json.dumps({"columns": [h[1] if isinstance(h, (list, tuple)) else h for h in res.header], "rows": rows})


if __name__ == "__main__":
    mcp.run()
