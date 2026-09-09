"""Emit the markdown tables for docs/public-deployment-comunica-evaluation.md.

usage: python3 test/report-tables.py
Reads test/corpus-arms-public.json, test/corpus-arms-public-turtle.json,
test/corpus-arms-public-rerun.json (optional), test/federation-arms-public.json.
"""
import json
import os
import statistics

HERE = os.path.dirname(os.path.abspath(__file__))
main = json.load(open(os.path.join(HERE, "corpus-arms-public.json")))
turtle = json.load(open(os.path.join(HERE, "corpus-arms-public-turtle.json")))
fed = json.load(open(os.path.join(HERE, "federation-arms-public.json")))
rerun_path = os.path.join(HERE, "corpus-arms-public-rerun.json")
rerun = json.load(open(rerun_path)) if os.path.exists(rerun_path) else {}

for t, rec in turtle.items():
    main[t]["arms"].update({a: r for a, r in rec["arms"].items() if a not in main[t]["arms"]})

ARMS = ["qpf", "brtpf", "void", "block256", "page10k", "ramp", "void+ramp", "void+block256", "all", "turtle", "all+turtle"]
LABEL = {
    "qpf": "built-in TPF (`qpf`)", "brtpf": "built-in brTPF (`brtpf`)", "void": "+ VoID selectivity",
    "block256": "+ bind block 256", "page10k": "+ 10k pages everywhere", "ramp": "+ ramped pages",
    "void+ramp": "+ VoID + ramped pages", "void+block256": "+ VoID + block 256",
    "all": "+ VoID + ramp + block 256", "turtle": "brTPF + Accept Turtle", "all+turtle": "all + Accept Turtle",
}


def st(r):
    if r is None:
        return "-"
    if r.get("ok"):
        return "ok"
    e = str(r.get("error", "?"))
    return "timeout" if e.startswith("timeout") or e == "harness-timeout" else "oom" if e == "oom" else "error"


tasks = list(main)
res = lambda t, a: main[t]["arms"].get(a)
common = [t for t in tasks if all(res(t, a) and res(t, a).get("ok") for a in ARMS)]
print(f"<!-- {len(tasks)} tasks; {len(common)} completed by all {len(ARMS)} arms -->\n")

print("| Arm | Completed | Timeout | OOM | Crash | Requests (common set) | Wall clock (common set) | Bindings requests | Median request ratio vs brTPF | Better / worse (>10%) | Rescued / lost vs brTPF |")
print("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|")
for a in ARMS:
    s = [st(res(t, a)) for t in tasks]
    req = sum(res(t, a)["requests"] for t in common)
    sec = sum(res(t, a)["seconds"] for t in common)
    vals = sum(res(t, a)["requestsWithValues"] for t in common)
    both = [t for t in tasks if res(t, a) and res(t, "brtpf") and res(t, a).get("ok") and res(t, "brtpf").get("ok")]
    ratios = [res(t, a)["requests"] / max(res(t, "brtpf")["requests"], 1) for t in both]
    med = statistics.median(ratios) if ratios else float("nan")
    better = sum(r < 0.9 for r in ratios); worse = sum(r > 1.1 for r in ratios)
    rescued = sum(1 for t in tasks if res(t, a) and res(t, a).get("ok") and res(t, "brtpf") and not res(t, "brtpf").get("ok"))
    lost = sum(1 for t in tasks if res(t, "brtpf") and res(t, "brtpf").get("ok") and res(t, a) and not res(t, a).get("ok"))
    print(f"| {LABEL[a]} | **{s.count('ok')}** | {s.count('timeout')} | {s.count('oom')} | {s.count('error')} | {req:,} | {sec:,.0f} s | {vals:,} | {med:.2f}× | {better} / {worse} | {rescued} / {lost} |")

print("\n<!-- rescued/lost detail -->")
for a in ARMS:
    if a == "brtpf":
        continue
    resc = [t for t in tasks if res(t, a) and res(t, a).get("ok") and res(t, "brtpf") and not res(t, "brtpf").get("ok")]
    lost = [t for t in tasks if res(t, "brtpf") and res(t, "brtpf").get("ok") and res(t, a) and not res(t, a).get("ok")]
    if resc or lost:
        print(f"- `{a}`: rescued {', '.join(f'`{t}` ({res(t, a)['requests']:,} req, {res(t, a)['seconds']:.1f} s)' for t in resc) or 'none'}; lost {', '.join(f'`{t}` ({st(res(t, a))})' for t in lost) or 'none'}")

print("\n<!-- selected per-task table -->")
SEL = ["biobricks-ice/names-of-chemical-entities", "nasa-gesdisc-kg/frequent-sciencekeywords", "ncipidkg/list-all-labeled-interactions",
       "nde/nde-resources-by-count", "nde/dataset-count-by-agent", "ubergraph/abdominal-cell-types", "nasa-gesdisc-kg/pubs-by-year-title",
       "nasa-gesdisc-kg/count-publications-use-each-dataset", "ruralkg/list-providers", "prokn/protein_kinases", "hydrologykg/sawgraph-hydrology-02",
       "oard-kg/diseases-associated-with-phenotype", "biobricks-ice/assays-from-invitrodb"]
cols = ["qpf", "brtpf", "void", "ramp", "all", "all+turtle"]
print("| Task | " + " | ".join(f"`{c}`" for c in cols) + " |")
print("|---|" + "---:|" * len(cols))
for t in SEL:
    cells = []
    for c in cols:
        r = res(t, c)
        cells.append(f"{r['requests']:,} / {r['seconds']:.1f} s" if r and r.get("ok") else st(r))
    print(f"| `{t}` | " + " | ".join(cells) + " |")

print("\n<!-- turtle wall clock -->")
for base, tur in [("brtpf", "turtle"), ("all", "all+turtle")]:
    both = [t for t in tasks if res(t, base) and res(t, tur) and res(t, base).get("ok") and res(t, tur).get("ok")]
    sb = sum(res(t, base)["seconds"] for t in both); stt = sum(res(t, tur)["seconds"] for t in both)
    rq = statistics.median(res(t, tur)["requests"] / max(res(t, base)["requests"], 1) for t in both)
    ts = statistics.median(res(t, tur)["seconds"] / max(res(t, base)["seconds"], 0.05) for t in both)
    print(f"- `{tur}` vs `{base}`: {len(both)} tasks both completed; requests median ratio {rq:.2f}×; wall clock {sb:.0f} s → {stt:.0f} s (median per-task ratio {ts:.2f}×)")

if rerun:
    print("\n<!-- variance -->")
    for a in ["brtpf", "all"]:
        pairs = [(main[t]["arms"][a], rerun[t]["arms"][a]) for t in main if a in rerun.get(t, {}).get("arms", {}) and main[t]["arms"].get(a, {}).get("ok") and rerun[t]["arms"][a].get("ok")]
        rr = [y["requests"] / max(x["requests"], 1) for x, y in pairs]
        ss = [y["seconds"] / max(x["seconds"], 0.05) for x, y in pairs]
        print(f"- `{a}`: {len(pairs)} tasks completed in both runs; requests identical in {sum(abs(r-1) < 1e-9 for r in rr)}, within 10% in {sum(abs(r-1) <= 0.1 for r in rr)}, p10–p90 of run2/run1 = {statistics.quantiles(rr, n=10)[0]:.2f}–{statistics.quantiles(rr, n=10)[-1]:.2f}; wall-clock median ratio {statistics.median(ss):.2f}")
        for t in main:
            x, y = main[t]["arms"].get(a), rerun.get(t, {}).get("arms", {}).get(a)
            if x and y and x.get("ok") and y.get("ok") and abs(y["requests"] / max(x["requests"], 1) - 1) > 0.25:
                print(f"  - `{t}`: {x['requests']:,} → {y['requests']:,} requests")

print("\n<!-- federation -->")
fcols = ["qpf", "brtpf", "void", "ramp", "all"]
print("| Query | Sources | " + " | ".join(f"`{c}`" for c in fcols) + " |")
print("|---|---|" + "---:|" * len(fcols))
for q, rec in fed.items():
    cells = []
    for c in fcols:
        r = rec["arms"].get(c)
        cells.append(f"{r['requests']:,} / {r['seconds']:.1f} s" if r and r.get("ok") else ("crash" if r and str(r.get("error", "")).startswith("crash") else st(r)))
    print(f"| `{q}` | {', '.join(rec['targets'])} | " + " | ".join(cells) + " |")
