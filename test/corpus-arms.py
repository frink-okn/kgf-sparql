"""Multi-arm benchmark of Comunica configurations against a KGF deployment.

Each arm is a distinct client configuration (source type, statistics, engine
config, page-size injection). Arms run back to back per task so server state is
comparable; N tasks run concurrently (TASK_WORKERS) to bound wall clock.

usage: python3 test/corpus-arms.py <out.json> [arm ...]
env:   KGF_ROOT (default https://apps.okn.us/kgf), TASK_TIMEOUT (s, default 60),
       TASK_WORKERS (default 2), STATS (default test/void-stats-public.json),
       ONLY (comma-separated task id substrings)
"""
import json
import os
import subprocess
import sys
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
DATASET = "/Users/jim/Documents/Source/mcp-okn/benchmark/dataset.jsonl"
ROOT = os.environ.get("KGF_ROOT", "https://apps.okn.us/kgf").rstrip("/")
STATS = os.environ.get("STATS", os.path.join(HERE, "void-stats-public.json"))
TIMEOUT = int(os.environ.get("TASK_TIMEOUT", "60"))
WORKERS = int(os.environ.get("TASK_WORKERS", "2"))
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "corpus-arms-results.json")
ONLY = [s for s in os.environ.get("ONLY", "").split(",") if s]

sys.path.insert(0, HERE)
from corpus_arms_common import ARMS_FOR  # noqa: E402
ARMS = ARMS_FOR(STATS, HERE)
arms = sys.argv[2:] or ["qpf", "brtpf", "void", "page10k", "ramp", "void+ramp", "all"]
for a in arms:
    if a not in ARMS:
        sys.exit(f"unknown arm {a}; known: {', '.join(ARMS)}")

srv = json.load(urllib.request.urlopen(ROOT + "/"))
links = {d["id"]: d["links"]["fragment"] for d in srv["datasets"]}
origin = ROOT.split("/kgf")[0] if "/kgf" in ROOT else ROOT

recs = [json.loads(l) for l in open(DATASET)]
tasks = [r for r in recs if r["adaptation"] == "auto"
         and len(r.get("mapped_kgs") or []) == 1
         and r["mapped_kgs"][0] in links]
if ONLY:
    tasks = [t for t in tasks if any(s in t["id"] for s in ONLY)]


def run(arm, ep, sparql):
    """One arm. Returns a result dict; never raises."""
    cmd = ["node", "--max-old-space-size=2048", "test/run-arm.mjs",
           "--timeout", str(TIMEOUT * 1000), *ARMS[arm], ep]
    try:
        p = subprocess.run(cmd, input=sparql, capture_output=True, text=True,
                           cwd=REPO, timeout=TIMEOUT + 30)
        out = (p.stdout or "").strip()
        if out.startswith("{"):
            return json.loads(out)
        err = p.stderr or ""
        kind = "oom" if "heap out of memory" in err or "JavaScript heap" in err else "crash:" + err[-200:]
        return {"ok": False, "error": kind}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "harness-timeout"}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)[:200]}


res = {}
if os.path.exists(OUT):
    res = json.load(open(OUT))
lock = threading.Lock()


def tag(a):
    if not a.get("ok"):
        return f"{a.get('error','?')[:12]:>12s}"
    return f"{a['requests']:>6,d}r {a['seconds']:>5.1f}s"


def do_task(i, r):
    kg = r["mapped_kgs"][0]
    ep = origin + links[kg]
    prior = res.get(r["id"], {}).get("arms", {})
    results = dict(prior)
    for arm in arms:
        if arm in results:
            continue
        results[arm] = run(arm, ep, r["sparql"])
        with lock:
            res[r["id"]] = {"kg": kg, "endpoint": ep, "arms": results, "sparql": r["sparql"]}
            json.dump(res, open(OUT, "w"), indent=1)
    hashes = {results[a].get("hash") for a in arms if results[a].get("ok")}
    same = "" if len(hashes) <= 1 else "DIFF"
    line = " | ".join(f"{a} {tag(results[a])}" for a in arms)
    print(f"[{i:3d}/{len(tasks)}] {line} {same:>4s}  {r['id']}", flush=True)


print(f"{len(tasks)} tasks, arms {arms}, timeout {TIMEOUT}s, workers {WORKERS}, root {ROOT}", flush=True)
t0 = time.time()
with ThreadPoolExecutor(max_workers=WORKERS) as ex:
    list(ex.map(lambda ir: do_task(*ir), enumerate(tasks, 1)))
print(f"done in {time.time()-t0:.0f}s -> {OUT}", flush=True)
