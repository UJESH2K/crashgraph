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
    rows = mem.q(Q_PATH, {"n": n}, ro=True).result_set
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
    # what landing attempts did in that same situation, vs what this one did
    agg = {ok: (cnt, acts) for ok, cnt, acts in
           mem.q(Q_ACTS_BY_OUTCOME, {"k": d["k"], "before": n + 10**9, "landed": LANDED}, ro=True).result_set}
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
    rows = mem.q(Q_HUBS, {"min_visits": min_visits}, ro=True).result_set
    hubs = []
    for key, label, pr, visits, crash, land in rows:
        risk = _risk(crash, visits)
        hubs.append({"k": key, "label": label, "pagerank": round(pr, 5), "visits": visits,
                     "risk": round(risk, 3), "danger": pr * risk})
    hubs.sort(key=lambda h: -h["danger"])
    return {"hubs": hubs[:k], "cypher": Q_HUBS.strip()}


def crash_signatures(mem, since=0, k=6):
    rows = mem.q(Q_LAST_SIT, {"outs": ["crashed", "flew_off"], "since": since}, ro=True).result_set
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
        rows = mem.q(Q_COMMUNITIES, ro=True).result_set
    except Exception as e:
        return {"error": str(e)}
    return {"families": [{"id": c, "size": s, "crash_rate": round(_risk(cr, cr + l), 3), "examples": ex}
                         for c, s, cr, l, ex in rows], "cypher": Q_COMMUNITIES.strip()}


def learning_curve(mem):
    rows = mem.q(Q_CURVE, ro=True).result_set
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
