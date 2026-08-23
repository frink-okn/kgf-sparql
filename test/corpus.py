"""Two-arm benchmark: stock Comunica selectivity vs VoID-driven selectivity.

Both arms run through the same engine binary; the only difference is whether the
VoID statistics context key is supplied. Arms run back to back per task so server
state and page cache are comparable.
"""
import json
import os
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
DATASET = "/Users/jim/Documents/Source/mcp-okn/benchmark/dataset.jsonl"
STATS = os.path.join(HERE, "void-stats.json")
ROOT = "http://127.0.0.1:8080"
TIMEOUT = int(os.environ.get("TASK_TIMEOUT", "90"))
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "corpus-results.json")

srv = json.load(urllib.request.urlopen(ROOT + "/"))
ver = {d["id"]: d["current"] for d in srv["datasets"]}

recs = [json.loads(l) for l in open(DATASET)]
tasks = [r for r in recs if r["adaptation"] == "auto"
         and len(r.get("mapped_kgs") or []) == 1
         and r["mapped_kgs"][0] in ver]


def run(ep, sparql, stats):
    """One arm. Returns a result dict; never raises."""
    try:
        p = subprocess.run(
            ["node", "test/run-one.mjs", ep, str(TIMEOUT * 1000), stats],
            input=sparql, capture_output=True, text=True,
            cwd=REPO, timeout=TIMEOUT + 60,
        )
        out = (p.stdout or "").strip()
        if out.startswith("{"):
            return json.loads(out)
        err = (p.stderr or "")
        kind = "oom" if "heap out of memory" in err or "JavaScript heap" in err else "crash"
        return {"ok": False, "err": kind, "requests": None, "secs": None}
    except subprocess.TimeoutExpired:
        return {"ok": False, "err": "harness-timeout", "requests": None, "secs": None}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "err": str(e)[:120], "requests": None, "secs": None}


res = {}
print(f"{len(tasks)} tasks, timeout {TIMEOUT}s per arm", flush=True)
for i, r in enumerate(tasks, 1):
    kg = r["mapped_kgs"][0]
    ep = f"{ROOT}/{kg}/v/{ver[kg]}/fragment"
    base = run(ep, r["sparql"], "none")
    void = run(ep, r["sparql"], STATS)
    res[r["id"]] = {"kg": kg, "base": base, "void": void, "sparql": r["sparql"]}
    json.dump(res, open(OUT, "w"), indent=1)

    def tag(a):
        if not a.get("ok"):
            return f"{a.get('err','?')[:14]:>14s}"
        return f"{a['requests']:>7,d}req {a['secs']:>6.1f}s"
    same = ""
    if base.get("ok") and void.get("ok"):
        same = "=" if base.get("hash") == void.get("hash") else "DIFF"
    print(f"[{i:3d}/{len(tasks)}] base {tag(base)} | void {tag(void)} {same:>4s}  {r['id']}", flush=True)

print("done -> " + OUT, flush=True)
