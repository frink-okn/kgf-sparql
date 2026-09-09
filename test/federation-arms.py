"""Multi-arm benchmark of the okn-registry queries that span two or more KGs.

Same arms and runner as corpus-arms.py; sources come from each query's `#+ tags`
header (legacy `federation`-only headers are mapped explicitly). Queries with a
hard-coded SERVICE clause or a Wikidata dependency are skipped.

usage: python3 test/federation-arms.py <out.json> [arm ...]
env:   KGF_ROOT, TASK_TIMEOUT (default 90), STATS, TASK_WORKERS (default 1)
"""
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
QUERY_ROOT = REPO.parent / "okn-registry" / "docs" / "registry" / "queries"
ROOT = os.environ.get("KGF_ROOT", "https://apps.okn.us/kgf").rstrip("/")
STATS = os.environ.get("STATS", str(HERE / "void-stats-public.json"))
TIMEOUT = int(os.environ.get("TASK_TIMEOUT", "90"))
WORKERS = int(os.environ.get("TASK_WORKERS", "1"))
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "federation-arms-results.json"

sys.path.insert(0, str(HERE))
from corpus_arms_common import ARMS_FOR  # noqa: E402

FEDERATION_TARGETS = {
    "fio-spatial-facilities-in-state": ["fiokg", "spatialkg"],
    "nde-diseases-mondo-parents": ["nde", "ubergraph"],
    "sawgraph-hydrology-spatial-04": ["hydrologykg", "spatialkg"],
    "sawgraph-hydrology-spatial_03": ["hydrologykg", "spatialkg"],
    "sawgraph-spatial-hydrology-01": ["hydrologykg", "spatialkg"],
}
ALIASES = {"fio-kg": "fiokg"}


def header_tags(text):
    tags, inside = [], False
    for line in text.splitlines():
        if line.startswith("#+ tags:"):
            inside = True
            continue
        if inside:
            m = re.match(r"^#\+\s+-\s+(.+?)\s*$", line)
            if m:
                tags.append(m.group(1).strip())
                continue
            break
    return tags


srv = json.load(urllib.request.urlopen(ROOT + "/"))
links = {d["id"]: d["links"]["fragment"] for d in srv["datasets"]}
origin = ROOT.split("/kgf")[0] if "/kgf" in ROOT else ROOT
ARMS = ARMS_FOR(STATS, HERE)
arms = sys.argv[2:] or ["qpf", "brtpf", "void", "ramp", "void+ramp", "all"]

queries = []
for path in sorted(QUERY_ROOT.rglob("*.rq")):
    text = path.read_text(encoding="utf-8")
    if "wikidata" in text.lower() or re.search(r"(?i)\bSERVICE\s*<", text):
        continue
    targets = [ALIASES.get(t, t) for t in header_tags(text) if t != "federation"]
    if not targets and path.stem in FEDERATION_TARGETS:
        targets = FEDERATION_TARGETS[path.stem]
    if len(targets) < 2 or any(t not in links for t in targets):
        continue
    queries.append((str(path.relative_to(QUERY_ROOT).with_suffix("")), targets, text))


def run(arm, endpoints, sparql):
    cmd = ["node", "--max-old-space-size=2048", "test/run-arm.mjs",
           "--timeout", str(TIMEOUT * 1000), *ARMS[arm], *endpoints]
    try:
        p = subprocess.run(cmd, input=sparql, capture_output=True, text=True, cwd=REPO, timeout=TIMEOUT + 30)
        out = (p.stdout or "").strip()
        if out.startswith("{"):
            return json.loads(out)
        err = p.stderr or ""
        return {"ok": False, "error": "oom" if "heap out of memory" in err or "JavaScript heap" in err else "crash:" + err[-200:]}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "harness-timeout"}


res = json.load(open(OUT)) if OUT.exists() else {}
lock = threading.Lock()


def tag(a):
    if not a.get("ok"):
        return f"{a.get('error','?')[:12]:>12s}"
    return f"{a['requests']:>6,d}r {a['seconds']:>5.1f}s"


def do(i, item):
    qid, targets, text = item
    endpoints = [origin + links[t] for t in targets]
    results = dict(res.get(qid, {}).get("arms", {}))
    for arm in arms:
        if arm in results:
            continue
        results[arm] = run(arm, endpoints, text)
        with lock:
            res[qid] = {"targets": targets, "endpoints": endpoints, "arms": results, "sparql": text}
            OUT.write_text(json.dumps(res, indent=1))
    print(f"[{i:2d}/{len(queries)}] " + " | ".join(f"{a} {tag(results[a])}" for a in arms) + f"  {qid}", flush=True)


print(f"{len(queries)} federation queries, arms {arms}, timeout {TIMEOUT}s", flush=True)
t0 = time.time()
with ThreadPoolExecutor(max_workers=WORKERS) as ex:
    list(ex.map(lambda x: do(*x), enumerate(queries, 1)))
print(f"done in {time.time()-t0:.0f}s -> {OUT}", flush=True)
