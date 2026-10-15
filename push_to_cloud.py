"""Copy every crashgraph memory graph from one FalkorDB to another (e.g. local -> FalkorDB Cloud).

    python push_to_cloud.py --to "redis://falkordb:PASSWORD@HOST:PORT"
    python push_to_cloud.py --from redis://localhost:6379 --to ...     (Docker -> Cloud)

Uses Redis DUMP / RESTORE on each graph key, so the copy is exact (nodes, edges, indexes).
Special characters in the password must be URL-encoded in the URL (# -> %23, @ -> %40).
"""
import argparse
import os

from falkordb import FalkorDB

from crashgraph.memory import connect, load_env


def main():
    load_env()
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="src", default=None, help="source URL; default = local (embedded or Docker)")
    ap.add_argument("--to", dest="dst", default=os.environ.get("FALKORDB_CLOUD_URL"), required=False)
    ap.add_argument("--snapshots", action="store_true", help="also copy snapshot graphs")
    a = ap.parse_args()
    if not a.dst:
        raise SystemExit("give --to redis://user:pass@host:port (or set FALKORDB_CLOUD_URL in .env)")
    if a.src:
        src = FalkorDB.from_url(a.src)
    else:
        os.environ.pop("FALKORDB_URL", None) if os.name != "nt" else None
        src, where = connect()
        print("source:", where)
    dst = FalkorDB.from_url(a.dst)
    names = [g.decode() if isinstance(g, bytes) else g for g in src.connection.execute_command("GRAPH.LIST")]
    names = [n for n in names if n.startswith("crashgraph_") and (a.snapshots or "__snap__" not in n)]
    for n in names:
        blob = src.connection.dump(n)
        dst.connection.restore(n, 0, blob, replace=True)
        r = dst.select_graph(n).ro_query("MATCH (w:World) RETURN w.key, w.episodes, w.landed").result_set
        print(f"copied {n}: {r}")


if __name__ == "__main__":
    main()
