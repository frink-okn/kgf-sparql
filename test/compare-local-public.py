"""Compare the August local-server two-arm run with the public-deployment arms run.

usage: python3 test/compare-local-public.py test/corpus-results-fullcoverage.json test/corpus-arms-public.json
"""
import json
import statistics
import sys

local = json.load(open(sys.argv[1]))
public = json.load(open(sys.argv[2]))
pairs = [("base", "brtpf"), ("void", "void")]
for larm, parm in pairs:
    both, req_ratio, sec_ratio, per_req = [], [], [], []
    l_ok = p_ok = 0
    for t, lv in local.items():
        pv = public.get(t)
        if not pv or parm not in pv["arms"]:
            continue
        l, p = lv[larm], pv["arms"][parm]
        l_ok += bool(l.get("ok")); p_ok += bool(p.get("ok"))
        if l.get("ok") and p.get("ok"):
            both.append(t)
            req_ratio.append(p["requests"] / max(l["requests"], 1))
            sec_ratio.append(p["seconds"] / max(l["secs"], 0.05))
            if p["requests"] >= 50:
                per_req.append((p["seconds"] / p["requests"], l["secs"] / l["requests"]))
    print(f"{larm}(local) vs {parm}(public): local ok={l_ok} public ok={p_ok} both={len(both)}")
    print(f"  median request ratio public/local = {statistics.median(req_ratio):.2f}  (requests are plan-driven; ~1.0 expected)")
    print(f"  median wall-clock ratio public/local = {statistics.median(sec_ratio):.2f}")
    if per_req:
        print(f"  tasks with >=50 requests: median seconds/request public={statistics.median(a for a,_ in per_req)*1000:.0f} ms, local={statistics.median(b for _,b in per_req)*1000:.0f} ms")
    lost = [t for t, lv in local.items() if lv[larm].get("ok") and public.get(t, {}).get("arms", {}).get(parm, {}).get("ok") is False]
    gained = [t for t, lv in local.items() if not lv[larm].get("ok") and public.get(t, {}).get("arms", {}).get(parm, {}).get("ok")]
    print(f"  completed locally but not publicly ({len(lost)}): {', '.join(lost)}")
    print(f"  completed publicly but not locally ({len(gained)}): {', '.join(gained)}")
