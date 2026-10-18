"""Copy crashgraph memory graphs from one FalkorDB to another (e.g. local Docker -> FalkorDB Cloud).

    python push_to_cloud.py --to "redis://falkordb:PASSWORD@HOST:PORT"
    python push_to_cloud.py --to ... --only luna          # just the headline world
    python push_to_cloud.py --from redis://localhost:6379 --to ...

Uses Redis DUMP / RESTORE on each graph key, so the copy is exact (nodes, edges, indexes).
Special characters in the password must be URL-encoded in the URL (# -> %23, @ -> %40).

FalkorDB Cloud's free tier caps memory (~100 MB) with maxmemory-policy noeviction, so a RESTORE
that does not fit fails outright. This script therefore pushes one graph at a time, largest-benefit
first, checks the headroom before each, and stops cleanly instead of half-filling the instance.
"""
import argparse
import os

from falkordb import FalkorDB

from crashgraph.memory import connect, load_env

ORDER = ["luna", "ares", "titan"]       # luna first: it carries the removal-test result


def mem(conn):
    """(used_bytes, max_bytes) for a destination instance; max 0 means unlimited."""
    info = conn.info("memory")
    return int(info.get("used_memory", 0)), int(info.get("maxmemory", 0) or 0)


def main():
    load_env()
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="src", default=None, help="source URL; default = local (embedded or Docker)")
    ap.add_argument("--to", dest="dst", default=os.environ.get("FALKORDB_CLOUD_URL"))
    ap.add_argument("--only", nargs="*", default=None, help="worlds to push, e.g. --only luna ares")
    ap.add_argument("--snapshots", action="store_true", help="also copy __snap__ graphs")
    ap.add_argument("--force", action="store_true", help="push even when the headroom estimate says it will not fit")
    a = ap.parse_args()
    if not a.dst:
        raise SystemExit("give --to redis://user:pass@host:port (or set FALKORDB_CLOUD_URL in .env)")

    if a.src:
        src = FalkorDB.from_url(a.src)
        print("source:", a.src.split("@")[-1])
    else:
        src, where = connect()
        print("source:", where)
    dst = FalkorDB.from_url(a.dst)

    names = [g.decode() if isinstance(g, bytes) else g for g in src.connection.execute_command("GRAPH.LIST")]
    names = [n for n in names if n.startswith("crashgraph_") and (a.snapshots or "__snap__" not in n)]
    if a.only:
        want = {f"crashgraph_{w}" for w in a.only}
        names = [n for n in names if n in want]
    names.sort(key=lambda n: ORDER.index(n.replace("crashgraph_", "")) if n.replace("crashgraph_", "") in ORDER else 99)
    if not names:
        raise SystemExit("nothing to push")

    used, cap = mem(dst.connection)
    print(f"destination: {used/1e6:.1f} MB used"
          + (f" of {cap/1e6:.1f} MB cap" if cap else " (no cap)"))

    pushed, skipped = [], []
    for n in names:
        blob = src.connection.dump(n)
        size = len(blob)
        used, cap = mem(dst.connection)
        # A restored graph needs roughly its serialized size again while loading, so require 2x.
        if cap and used + size * 2 > cap and not a.force:
            print(f"  skip {n}: {size/1e6:.1f} MB serialized does not fit in "
                  f"{(cap-used)/1e6:.1f} MB of headroom")
            skipped.append(n)
            continue
        try:
            dst.connection.restore(n, 0, blob, replace=True)
        except Exception as e:
            print(f"  FAILED {n} ({size/1e6:.1f} MB): {type(e).__name__}: {str(e)[:160]}")
            skipped.append(n)
            continue
        r = dst.select_graph(n).ro_query("MATCH (w:World) RETURN w.key, w.episodes, w.landed").result_set
        now, _ = mem(dst.connection)
        print(f"  copied {n}: {r} [{size/1e6:.1f} MB -> instance now {now/1e6:.1f} MB]")
        pushed.append(n)

    used, cap = mem(dst.connection)
    print(f"\npushed {len(pushed)}: {', '.join(pushed) or 'none'}")
    if skipped:
        print(f"skipped {len(skipped)}: {', '.join(skipped)}")
        print("The free tier is small. The pushed world(s) are enough to demo a live graph;\n"
              "run the rest against the local Docker instance, or use --force to try anyway.")
    print(f"destination now {used/1e6:.1f} MB" + (f" of {cap/1e6:.1f} MB" if cap else ""))


if __name__ == "__main__":
    main()
