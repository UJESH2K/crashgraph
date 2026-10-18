"""Why did it crash? Why did it land? Every answer here is a Cypher query or a
FalkorDB graph algorithm over the lander's own memory. These are also the
tools exposed to LLM agents over MCP (see mcp_server.py)."""
import math

from .features import ACTIONS
from .memory import SUCCESS

LANDED = list(SUCCESS)


def _risk(s_crash, s_visits):
    return (s_crash + 1.0) / (s_visits + 2.0)   # smoothed P(crash | passed through here)


def _mix(acts):
    tot = sum(acts) or 1
    return {ACTIONS[i]: round(acts[i] / tot, 2) for i in range(4)}


def _dominant(acts):
    i = max(range(4), key=lambda j: acts[j])
    return ACTIONS[i]


# ------------------------------------------------------------------ queries
Q_PATH = """
MATCH (e:Episode {n:$n})-[v:VISITED]->(s:Situation)
RETURN v.i, s.k, s.label, s.visits, s.crash_after, s.land_after, v.acts, v.frames
ORDER BY v.i"""

Q_ACTS_BY_OUTCOME = """
MATCH (e:Episode)-[v:VISITED]->(s:Situation {k:$k})
WHERE e.n < $before
WITH e.outcome IN $landed AS ok, collect(v.acts) AS acts
RETURN ok, size(acts), reduce(a=[0,0,0,0], x IN acts | [i IN range(0,3) | a[i] + x[i]])"""

Q_NEXT_STEPS = """
MATCH (s:Situation {k:$k})-[r:FLOWS]->(t:Situation)
RETURN t.label, r.n, r.land, r.crash
ORDER BY r.land DESC, r.n DESC LIMIT 4"""

Q_SAFE_PATH = """
MATCH (a:Situation {k:$k}), (o:Outcome {name:'landed_pad'})
CALL algo.SPpaths({sourceNode:a, targetNode:o, relTypes:['SAFE'],
                   weightProp:'cost', maxLen:12, pathCount:1})
YIELD path, pathWeight
RETURN [x IN nodes(path) | coalesce(x.label, x.name)], pathWeight"""

Q_HUBS = """
CALL algo.pageRank('Situation', 'FLOWS') YIELD node, score
WHERE node.visits >= $min_visits
RETURN node.k, node.label, score, node.visits, node.crash_after, node.land_after
ORDER BY score DESC LIMIT 200"""

Q_CURVE = """
MATCH (e:Episode) RETURN e.n, e.score, e.outcome, e.learned ORDER BY e.n"""

Q_LAST_SIT = """
MATCH (e:Episode)-[v:VISITED]->(s:Situation)
WHERE e.outcome IN $outs AND e.n > $since
WITH e, max(v.i) AS last
MATCH (e)-[v2:VISITED {i:last}]->(s2:Situation)
RETURN s2.alt, s2.vy, s2.x, s2.vx, s2.tilt, count(*) AS n
ORDER BY n DESC LIMIT 400"""

Q_COMMUNITIES = """
CALL algo.labelPropagation({nodeLabels:['Situation'], relationshipTypes:['FLOWS']})
YIELD node, communityId
RETURN communityId, count(node) AS size, sum(node.crash_after) AS crashes,
       sum(node.land_after) AS lands, collect(node.label)[0..3] AS examples
ORDER BY size DESC LIMIT 8"""

Q_SUBGRAPH = """
MATCH (e:Episode {n:$n})-[v:VISITED]->(s:Situation)
WITH collect(DISTINCT s) AS onpath
UNWIND onpath AS s
OPTIONAL MATCH (s)-[r:FLOWS]->(t:Situation) WHERE r.n >= $min_n
RETURN s.k, s.label, s.visits, s.crash_after, t.k, t.label, t.visits, t.crash_after, r.n, r.land"""


def explain_episode(mem, n):
    rows = mem.q(Q_PATH, {"n": n}, ro=True, timeout=SCAN_MS).result_set
    meta = mem.q("MATCH (e:Episode {n:$n}) RETURN e.outcome, e.score, e.steps, e.fuel, e.gusts",
                 {"n": n}, ro=True).result_set
    if not meta:
        return {"error": f"attempt {n} not in memory"}
    outcome, score, steps, fuel, gusts = meta[0]
    path = []
    for i, k, label, visits, crash, land, acts, frames in rows:
        path.append({"i": i, "k": k, "label": label, "visits": visits, "risk": round(_risk(crash, visits), 3),
                     "acts": acts, "frames": frames, "did": _dominant(acts)})
    out = {"n": n, "outcome": outcome, "score": score, "steps": steps, "fuel": fuel, "gusts": gusts,
           "path": path, "cypher": [Q_PATH.strip()]}
    if not path:
        return out

    failed = outcome not in SUCCESS
    if failed:
        # point of no return: first situation after which risk never drops back below 0.6
        ponr = None
        risky = [i for i, p in enumerate(path) if p["risk"] >= 0.75 and p["visits"] >= 5]
        if risky:
            # the start of the last stretch of high-risk situations
            ponr = risky[-1]
            while ponr - 1 in risky:
                ponr -= 1
        elif max(p["risk"] for p in path) >= 0.5:
            ponr = max(range(len(path)), key=lambda i: path[i]["risk"])
        if ponr is None:
            # nothing on the way was usually fatal: an unusual crash. Blame the last situation it acted in.
            out["unusual"] = True
            ponr = len(path) - 1
            decision = max(0, len(path) - 2) if path[-1]["frames"] <= 3 else len(path) - 1
        else:
            decision = max(0, ponr - 1)
        out["point_of_no_return"] = ponr
        out["decision_point"] = decision
    else:
        decision = max(range(len(path)), key=lambda i: path[i]["risk"])
        out["closest_call"] = decision

    d = path[decision]
    # What landing attempts did in that same situation, versus what this one did. This walks
    # every VISITED edge into a popular situation - tens of thousands of them on a trained
    # graph - so it is the query that times out first when something else is also running.
    # A missing comparison costs one sentence of the explanation; a 500 costs the whole panel.
    try:
        agg = {ok: (cnt, acts) for ok, cnt, acts in
               mem.q(Q_ACTS_BY_OUTCOME, {"k": d["k"], "before": n + 10**9, "landed": LANDED},
                     ro=True, timeout=5000).result_set}
    except Exception:
        agg = {}
    lesson = {"situation": d["label"], "this_attempt_did": _mix(d["acts"])}
    if True in agg:
        lesson["landing_attempts_did"] = _mix(agg[True][1])
        lesson["landing_attempts_seen"] = agg[True][0]
    if False in agg:
        lesson["other_attempts_did"] = _mix(agg[False][1])
    out["lesson"] = lesson
    out["next_from_decision"] = [{"to": t, "n": c, "landed": l, "crashed": x}
                                 for t, c, l, x in mem.q(Q_NEXT_STEPS, {"k": d["k"]}, ro=True).result_set]
    try:
        sp = mem.q(Q_SAFE_PATH, {"k": d["k"]}, ro=True, timeout=4000).result_set
    except Exception:
        sp = []
    if sp:
        labels, w = sp[0]
        out["safe_path"] = {"steps": labels, "p_estimate": round(math.exp(-w), 4)}
    else:
        out["no_safe_path"] = True
    out["cypher"] += [Q_ACTS_BY_OUTCOME.strip(), Q_NEXT_STEPS.strip(), Q_SAFE_PATH.strip()]
    out["summary"] = summarize(out)
    return out


def summarize(x):
    p = x["path"]
    if x["outcome"] in SUCCESS:
        c = p[x["closest_call"]]
        s = (f"Attempt {x['n']} {x['outcome'].replace('_', ' ')} (score {x['score']}). "
             f"Riskiest moment: '{c['label']}' where {int(c['risk'] * 100)}% of past attempts failed; "
             f"it chose {c['did'].replace('_', ' ')} there and recovered.")
        return s
    pn, dp = p[x["point_of_no_return"]], p[x["decision_point"]]
    if x.get("unusual"):
        worst = max(p, key=lambda q: q["risk"])
        s = (f"Attempt {x['n']} {x['outcome'].replace('_', ' ')} (score {x['score']}), an unusual crash: "
             f"no situation on its path usually ends badly (the riskiest, '{worst['label']}', fails "
             f"{int(worst['risk'] * 100)}% of the time). It went wrong at the very end, at '{dp['label']}', "
             f"where it mostly chose {dp['did'].replace('_', ' ')}.")
    else:
        s = (f"Attempt {x['n']} {x['outcome'].replace('_', ' ')} (score {x['score']}). "
             f"Point of no return: '{pn['label']}' ({int(pn['risk'] * 100)}% of {pn['visits']} past attempts "
             f"through here failed). The decision that mattered came one step earlier at '{dp['label']}', "
             f"where it mostly chose {dp['did'].replace('_', ' ')}.")
    L = x.get("lesson", {})
    if "landing_attempts_did" in L:
        best = max(L["landing_attempts_did"], key=L["landing_attempts_did"].get)
        s += (f" Attempts that landed from there mostly used {best.replace('_', ' ')} "
              f"({int(L['landing_attempts_did'][best] * 100)}% of frames, {L['landing_attempts_seen']} attempts).")
    if "safe_path" in x:
        s += f" Best-known route to the pad from there has {len(x['safe_path']['steps']) - 2} more situations."
    elif x.get("no_safe_path"):
        s += " No attempt has yet reached the pad from that situation, so the graph has no safe route to suggest."
    return s


def danger_hubs(mem, k=8, min_visits=10):
    rows = mem.q(Q_HUBS, {"min_visits": min_visits}, ro=True, timeout=SCAN_MS).result_set
    hubs = []
    for key, label, pr, visits, crash, land in rows:
        risk = _risk(crash, visits)
        hubs.append({"k": key, "label": label, "pagerank": round(pr, 5), "visits": visits,
                     "risk": round(risk, 3), "danger": pr * risk})
    hubs.sort(key=lambda h: -h["danger"])
    return {"hubs": hubs[:k], "cypher": Q_HUBS.strip()}


def crash_signatures(mem, since=0, k=6):
    rows = mem.q(Q_LAST_SIT, {"outs": ["crashed", "flew_off"], "since": since},
                 ro=True, timeout=SCAN_MS).result_set
    sig = {}
    for alt, vy, x, vx, tilt, c in rows:
        reasons = []
        if vy in ("plunging", "fast"):
            reasons.append("came down too fast")
        if tilt not in ("upright",):
            reasons.append("touched down tilted")
        if x not in ("center",):
            reasons.append("off the pad")
        if vx != "still":
            reasons.append("still drifting sideways")
        key = " + ".join(reasons) or "unclear (upright, slow, centered)"
        sig[key] = sig.get(key, 0) + c
    tot = sum(sig.values()) or 1
    return {"signatures": [{"why": w, "count": c, "share": round(c / tot, 3)}
                           for w, c in sorted(sig.items(), key=lambda t: -t[1])[:k]],
            "cypher": Q_LAST_SIT.strip()}


def communities(mem):
    try:
        rows = mem.q(Q_COMMUNITIES, ro=True, timeout=SCAN_MS).result_set
    except Exception as e:
        return {"error": str(e)}
    return {"families": [{"id": c, "size": s, "crash_rate": round(_risk(cr, cr + l), 3), "examples": ex}
                         for c, s, cr, l, ex in rows], "cypher": Q_COMMUNITIES.strip()}


def learning_curve(mem):
    rows = mem.q(Q_CURVE, ro=True, timeout=SCAN_MS).result_set
    return [{"n": n, "score": s, "outcome": o, "learned": l} for n, s, o, l in rows]


def subgraph(mem, n, min_n=3):
    rows = mem.q(Q_SUBGRAPH, {"n": n, "min_n": min_n}, ro=True).result_set
    nodes, edges = {}, []
    for sk, sl, sv, sc, tk, tl, tv, tc, rn, rl in rows:
        nodes[sk] = {"id": sk, "label": sl, "visits": sv, "risk": round(_risk(sc, sv), 3), "onpath": True}
        if tk:
            nodes.setdefault(tk, {"id": tk, "label": tl, "visits": tv, "risk": round(_risk(tc, tv), 3), "onpath": False})
            edges.append({"s": sk, "t": tk, "n": rn, "land": rl})
    return {"nodes": list(nodes.values()), "edges": edges}


# Order the coarse bands the way they appear in the world, so the grid reads like the scene:
# high altitude at the top, far_left at the left.
ALT_ROWS = ["high", "mid", "low", "ground"]
X_COLS = ["far_left", "left", "center", "right", "far_right"]


def risk_grid(mem):
    """Crash risk over (altitude band x horizontal band): the whole graph as one picture.

    Every Situation already carries its own band fields and running counts, so this is a plain
    aggregation - no sampling, no modelling. Cells the lander has never been in come back with
    visits 0 and are drawn as holes rather than as 'safe'.

    The grouping is done here rather than in Cypher: FalkorDB 4.22 returns the *same* value for
    every aggregate column when several aggregations share one GROUP BY, so
    `RETURN s.alt, s.x, sum(s.visits), sum(s.crash_after), sum(s.land_after)` comes back with
    visits == crashes == lands. Ungrouped aggregates are fine. There are only a couple of
    thousand Situation nodes, so folding them in Python costs nothing and is provably right.
    """
    res = mem.q("""
        MATCH (s:Situation)
        RETURN s.alt AS alt, s.x AS x, s.visits AS visits,
               s.crash_after AS crashes, s.land_after AS lands
    """, ro=True, timeout=SCAN_MS)

    by = {}
    for alt, x, visits, crashes, lands in res.result_set:
        d = by.setdefault((alt, x), {"visits": 0, "crashes": 0, "lands": 0, "states": 0})
        d["visits"] += int(visits or 0)
        d["crashes"] += int(crashes or 0)
        d["lands"] += int(lands or 0)
        d["states"] += 1

    cells = []
    for r, alt in enumerate(ALT_ROWS):
        for c, x in enumerate(X_COLS):
            d = by.get((alt, x))
            if not d or not d["visits"]:
                cells.append({"alt": alt, "x": x, "row": r, "col": c,
                              "visits": 0, "risk": None, "states": 0})
                continue
            decided = d["crashes"] + d["lands"]
            cells.append({
                "alt": alt, "x": x, "row": r, "col": c,
                "visits": d["visits"], "states": d["states"],
                "crashes": d["crashes"], "lands": d["lands"],
                "risk": round(d["crashes"] / decided, 3) if decided else None,
            })
    return {
        "rows": ALT_ROWS, "cols": X_COLS, "cells": cells,
        "cypher": ["MATCH (s:Situation)\nRETURN s.alt, s.x, s.visits, s.crash_after, s.land_after"],
    }


# ------------------------------------------------- the memory, as a picture
# The console draws the whole semantic memory in 3D. Rather than a force layout (which turns
# 1,700 situations into a hairball and moves every node whenever one is added), the nodes are
# placed by their own band fields, so the picture of the memory has the same shape as the world
# the lander flies in: altitude up the screen, distance from the pad across it, descent speed in
# depth. A node's position is therefore a fact about it, stable between frames and between runs.
BANDS = {
    "alt":  ["ground", "low", "mid", "high"],
    "vy":   ["plunging", "fast", "steady", "slow"],
    "x":    ["far_left", "left", "center", "right", "far_right"],
    "vx":   ["drift_left", "still", "drift_right"],
    "tilt": ["hard_left", "left", "upright", "right", "hard_right"],
}

Q_MEM_NODES = """
MATCH (s:Situation)
RETURN s.k, s.alt, s.vy, s.x, s.vx, s.tilt, s.legs, s.visits, s.crash_after, s.land_after, s.label"""

Q_MEM_EDGES = """
MATCH (a:Situation)-[r:FLOWS]->(b:Situation) WHERE r.n >= $min_n
RETURN a.k, b.k, r.n, r.land, r.crash"""

Q_MEM_BORN = """
MATCH (e:Episode)-[:VISITED]->(s:Situation)
WITH s, min(e.n) AS born RETURN s.k, born"""


# FalkorDB ships with a 1-second global read TIMEOUT. The whole-graph reads below sit close
# enough to it that the first one after a cold start loses, so they say how long they are
# allowed to take rather than inheriting a limit meant for interactive queries.
SCAN_MS = 20000


def memory_graph(mem, min_n=1, max_edges=14000):
    """The whole situation graph in one payload, as parallel arrays.

    Sent as arrays rather than objects because the browser re-reads this every few hundred
    attempts and an object per node triples the bytes for no gain. Every node carries the
    attempt it was first seen on, which is what makes growth visible rather than asserted.
    """
    born = dict(mem.q(Q_MEM_BORN, ro=True, timeout=SCAN_MS).result_set)
    rows = mem.q(Q_MEM_NODES, ro=True, timeout=SCAN_MS).result_set
    idx, keys, bands, visits, crashes, lands, borns, labels = {}, [], [], [], [], [], [], []
    for k, alt, vy, x, vx, tilt, legs, v, c, l, label in rows:
        idx[k] = len(keys)
        keys.append(k)
        bands += [BANDS["alt"].index(alt) if alt in BANDS["alt"] else 0,
                  BANDS["vy"].index(vy) if vy in BANDS["vy"] else 0,
                  BANDS["x"].index(x) if x in BANDS["x"] else 0,
                  BANDS["vx"].index(vx) if vx in BANDS["vx"] else 0,
                  BANDS["tilt"].index(tilt) if tilt in BANDS["tilt"] else 0,
                  int(legs or 0)]
        visits.append(int(v or 0))
        crashes.append(int(c or 0))
        lands.append(int(l or 0))
        borns.append(int(born.get(k, 0)))
        labels.append(label)

    edges, dropped = [], 0
    for a, b, n, land, crash in mem.q(Q_MEM_EDGES, {"min_n": min_n}, ro=True, timeout=SCAN_MS).result_set:
        if a not in idx or b not in idx:
            continue
        if len(edges) >= max_edges * 4:
            dropped += 1
            continue
        edges += [idx[a], idx[b], int(n or 0), int(land or 0)]

    return {"bands": BANDS, "keys": keys, "labels": labels, "b": bands, "visits": visits,
            "crashes": crashes, "lands": lands, "born": borns,
            "edges": edges, "dropped_edges": dropped, "min_n": min_n,
            "cypher": [Q_MEM_NODES.strip(), Q_MEM_EDGES.strip(), Q_MEM_BORN.strip()]}


def memory_growth(mem, buckets=160):
    """How the memory actually grew: situations first seen at each attempt, bucketed.

    Measured, not modelled - `min(e.n)` over every VISITED edge is the attempt a situation
    entered the graph. Paired with the landing rate over the same buckets, because the point of
    the chart is that the curve flattens just as the landing rate climbs.
    """
    born = mem.q(Q_MEM_BORN, ro=True, timeout=SCAN_MS).result_set
    eps = mem.q("MATCH (e:Episode) RETURN e.n, e.outcome ORDER BY e.n",
                ro=True, timeout=SCAN_MS).result_set
    total = max([n for _, n in born] + [n for n, _ in eps] + [1])
    size = max(1, total // max(1, buckets))

    new = {}
    for _, n in born:
        new[int(n) // size] = new.get(int(n) // size, 0) + 1
    landed, flown = {}, {}
    for n, outcome in eps:
        bk = int(n) // size
        flown[bk] = flown.get(bk, 0) + 1
        landed[bk] = landed.get(bk, 0) + (outcome in SUCCESS)

    points, running = [], 0
    for bk in range(0, total // size + 1):
        running += new.get(bk, 0)
        f = flown.get(bk, 0)
        points.append({"n": bk * size + size, "new": new.get(bk, 0), "total": running,
                       "flown": f, "rate": round(landed.get(bk, 0) / f, 3) if f else None})
    return {"points": points, "bucket": size, "situations": len(born),
            "cypher": [Q_MEM_BORN.strip()]}
