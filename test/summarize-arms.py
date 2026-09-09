"""Summarize a corpus-arms results file.

usage: python3 test/summarize-arms.py <results.json> [arm ...]
"""
import json
import statistics
import sys

path = sys.argv[1]
data = json.load(open(path))
tasks = list(data)
arms = sys.argv[2:] or sorted({a for t in data.values() for a in t["arms"]}, key=lambda a: [
    "qpf", "brtpf", "void", "page10k", "ramp", "void+ramp", "all", "qpf+void", "block256"].index(a)
    if a in ["qpf", "brtpf", "void", "page10k", "ramp", "void+ramp", "all", "qpf+void", "block256"] else 99)


def res(t, a):
    return data[t]["arms"].get(a)


def status(r):
    if r is None:
        return "-"
    if r.get("ok"):
        return "ok"
    e = str(r.get("error", "?"))
    if e.startswith("timeout") or e == "harness-timeout":
        return "timeout"
    if e == "oom" or "heap" in e:
        return "oom"
    return "error"


done_all = [t for t in tasks if all(res(t, a) and res(t, a).get("ok") for a in arms)]
print(f"{len(tasks)} tasks; {len(done_all)} completed by every arm\n")

print(f"{'arm':<11} {'ok':>3} {'t/o':>3} {'oom':>3} {'err':>3} | {'req(all-ok)':>11} {'sec(all-ok)':>11} {'values':>7} | {'req(all tasks)':>14} {'sec':>8}")
for a in arms:
    st = [status(res(t, a)) for t in tasks]
    req_common = sum(res(t, a)["requests"] for t in done_all)
    sec_common = sum(res(t, a)["seconds"] for t in done_all)
    vals_common = sum(res(t, a)["requestsWithValues"] for t in done_all)
    req_total = sum((res(t, a) or {}).get("requests", 0) or 0 for t in tasks)
    sec_total = sum((res(t, a) or {}).get("seconds", 0) or 0 for t in tasks)
    print(f"{a:<11} {st.count('ok'):>3} {st.count('timeout'):>3} {st.count('oom'):>3} {st.count('error'):>3} | {req_common:>11,} {sec_common:>11.1f} {vals_common:>7,} | {req_total:>14,} {sec_total:>8.0f}")

# Pairwise: per-task request ratio vs the brtpf baseline, on tasks both completed.
base = "brtpf" if "brtpf" in arms else arms[0]
print(f"\nPer-task request ratio vs {base} (tasks both completed): median, better(<0.9x), worse(>1.1x), rescued(base failed), lost(arm failed)")
for a in arms:
    if a == base:
        continue
    both = [t for t in tasks if res(t, a) and res(t, base) and res(t, a).get("ok") and res(t, base).get("ok")]
    ratios = [res(t, a)["requests"] / max(res(t, base)["requests"], 1) for t in both]
    better = sum(r < 0.9 for r in ratios)
    worse = sum(r > 1.1 for r in ratios)
    rescued = [t for t in tasks if res(t, a) and res(t, a).get("ok") and res(t, base) and not res(t, base).get("ok")]
    lost = [t for t in tasks if res(t, base) and res(t, base).get("ok") and res(t, a) and not res(t, a).get("ok")]
    med = statistics.median(ratios) if ratios else float("nan")
    print(f"  {a:<11} n={len(both):>2} median={med:5.2f}x better={better:>2} worse={worse:>2} rescued={len(rescued):>2} lost={len(lost):>2}")
    for t in rescued:
        print(f"      rescued: {t} ({res(t, a)['requests']:,} req, {res(t, a)['seconds']:.1f}s)")
    for t in lost:
        print(f"      lost:    {t} ({status(res(t, a))})")

# Answer agreement: row counts and hashes across arms that completed.
print("\nAnswer agreement across completed arms:")
disagree = 0
for t in tasks:
    ok = [(a, res(t, a)) for a in arms if res(t, a) and res(t, a).get("ok")]
    rows = {r["rows"] for _, r in ok}
    hashes = {r["hash"] for _, r in ok}
    if len(rows) > 1 or len(hashes) > 1:
        disagree += 1
        det = ", ".join(f"{a}:{r['rows']}/{r['hash'][:6]}" for a, r in ok)
        flag = "ROWS DIFFER" if len(rows) > 1 else "order/limit-only"
        limit = "LIMIT" in data[t]["sparql"].upper() and "ORDER BY" not in data[t]["sparql"].upper()
        print(f"  {t}: {flag}{' (LIMIT w/o ORDER BY)' if limit else ''}: {det}")
print(f"  {disagree} tasks with any disagreement")

# Per-task table
print("\nPer-task (requests / seconds; t/o=timeout):")
hdr = f"{'task':<52}" + "".join(f"{a:>14}" for a in arms)
print(hdr)
for t in tasks:
    cells = []
    for a in arms:
        r = res(t, a)
        s = status(r)
        cells.append(f"{r['requests']:>7,}/{r['seconds']:>5.1f}" if s == "ok" else f"{s:>13}")
    print(f"{t:<52}" + "".join(f"{c:>14}" for c in cells))
