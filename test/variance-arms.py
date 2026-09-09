"""Run-to-run variance: compare the same arms across two corpus-arms files.

usage: python3 test/variance-arms.py first.json second.json arm ...
"""
import json
import statistics
import sys

a, b, *arms = sys.argv[1:]
A, B = json.load(open(a)), json.load(open(b))
for arm in arms:
    req, sec, flips = [], [], []
    for t in A:
        x, y = A[t]["arms"].get(arm), B.get(t, {}).get("arms", {}).get(arm)
        if not x or not y:
            continue
        if bool(x.get("ok")) != bool(y.get("ok")):
            flips.append(f"{t} ({'ok' if x.get('ok') else x.get('error')} -> {'ok' if y.get('ok') else y.get('error')})")
            continue
        if x.get("ok"):
            req.append(y["requests"] / max(x["requests"], 1))
            sec.append(y["seconds"] / max(x["seconds"], 0.05))
    if not req:
        print(f"{arm}: no paired completions")
        continue
    q = statistics.quantiles(req, n=10)
    print(f"{arm}: n={len(req)} request ratio second/first median={statistics.median(req):.2f} p10={q[0]:.2f} p90={q[-1]:.2f} "
          f"exact-same={sum(abs(r-1) < 1e-9 for r in req)} within10%={sum(abs(r-1) <= 0.1 for r in req)}; "
          f"wall-clock ratio median={statistics.median(sec):.2f}")
    big = [(t, A[t]["arms"][arm]["requests"], B[t]["arms"][arm]["requests"]) for t in A
           if A[t]["arms"].get(arm, {}).get("ok") and B.get(t, {}).get("arms", {}).get(arm, {}).get("ok")
           and abs(B[t]["arms"][arm]["requests"] / max(A[t]["arms"][arm]["requests"], 1) - 1) > 0.25]
    for t, r1, r2 in big:
        print(f"   >25% change: {t}: {r1:,} -> {r2:,}")
    for f in flips:
        print(f"   status flip: {f}")
