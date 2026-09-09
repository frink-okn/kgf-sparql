"""Run the okn-registry SPARQL corpus through the kgf-sparql command line.

Each query runs as one ``kgf-sparql`` process with native ``kgf@`` sources, a request,
byte, and wall-clock budget, and a receipt. The summary has the shape of the earlier
brTPF run's (test/registry-query-results-20260827.json) so the two compare directly:
rows, an order-independent result hash computed the same way, and the receipt's totals,
contract, and budget. When an earlier results file is given, a comparison is printed.

usage: python3 test/registry-corpus-cli.py [results.json]
env:   KGF_ROOT (default https://apps.okn.us/kgf)
       REGISTRY_QUERY_TIMEOUT (seconds, default 30)
       REGISTRY_MAX_REQUESTS (default 5000), REGISTRY_MAX_BYTES (default 256M)
       REGISTRY_RUN_DIR (results and receipts, default scratch/registry-cli)
       REGISTRY_ONLY (substring filter on query ids)
       REGISTRY_COMPARE (earlier results file; default test/registry-query-results-20260827.json)
"""

from __future__ import annotations

from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request

from registry_corpus_common import HERE, QUERY_ROOT, REPO, header_tags, label, service_iris, skip_record, targets_for


ROOT = os.environ.get("KGF_ROOT", "https://apps.okn.us/kgf").rstrip("/")
TIMEOUT = float(os.environ.get("REGISTRY_QUERY_TIMEOUT", "30"))
MAX_REQUESTS = os.environ.get("REGISTRY_MAX_REQUESTS", "5000")
MAX_BYTES = os.environ.get("REGISTRY_MAX_BYTES", "256M")
RUN_DIR = Path(os.environ.get("REGISTRY_RUN_DIR", REPO / "scratch" / "registry-cli"))
ONLY = os.environ.get("REGISTRY_ONLY")
COMPARE = Path(os.environ.get("REGISTRY_COMPARE", HERE / "registry-query-results-20260827.json"))
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "registry-query-results-cli.json"
BIN = REPO / "packages" / "kgf-sparql" / "bin" / "kgf-sparql.js"
XSD_STRING = "http://www.w3.org/2001/XMLSchema#string"
MASK_64 = (1 << 64) - 1


def term_string(term: dict) -> str:
    """The earlier runner's term rendering, so hashes of the same rows agree."""
    if term["type"] == "uri":
        return f"<{term['value']}>"
    if term["type"] == "bnode":
        return f"_:{term['value']}"
    if term["type"] == "triple":
        return json.dumps(term["value"], sort_keys=True, ensure_ascii=False)
    value = json.dumps(term["value"], ensure_ascii=False)
    if "xml:lang" in term:
        return f"{value}@{term['xml:lang']}"
    return f"{value}^^<{term.get('datatype', XSD_STRING)}>"


def multiset_hash(bindings: list[dict]) -> tuple[str, list[str]]:
    total = 0
    xor = 0
    samples: list[str] = []
    for row in bindings:
        text = "\x01".join(sorted(f"{var}={term_string(term)}" for var, term in row.items()))
        if len(samples) < 3:
            samples.append(text[:500])
        n = int.from_bytes(hashlib.sha256(text.encode("utf-8")).digest()[:8], "big")
        total = (total + n) & MASK_64
        xor ^= n
    return f"{total:016x}:{xor:016x}", samples


def summarize(receipt_path: Path, out_path: Path, exit_code: int | None, stderr: str) -> dict:
    if not receipt_path.exists():
        return {"ok": False, "error": (stderr.strip() or f"exit:{exit_code}")[-500:], "exitCode": exit_code}
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    outcome = receipt["outcome"]
    totals = receipt["totals"]
    result = {
        "ok": outcome["contract"] == "complete",
        "contract": outcome["contract"],
        "resultType": outcome.get("result_type"),
        "rows": outcome["rows"],
        "requests": totals["requests"],
        "bindingsRequests": totals["bindings_requests"],
        "schemaRequests": receipt["statistics"]["schema_requests"],
        "responseBytes": totals["bytes"],
        "statuses": dict(Counter(str(r["status"]) for r in receipt["requests"] if r["status"] is not None)),
        "seconds": round(totals["elapsed_ms"] / 1000, 3),
        "exitCode": exit_code,
    }
    if outcome["contract"] == "aborted":
        result["error"] = f"aborted:{outcome['budget']}"
        result["budget"] = outcome["budget"]
    elif outcome["contract"] == "error":
        result["error"] = str(outcome.get("error", "error"))[:500]
    if result["ok"] and outcome.get("result_type") == "bindings":
        bindings = json.loads(out_path.read_text(encoding="utf-8"))["results"]["bindings"]
        result["multisetHash"], result["samples"] = multiset_hash(bindings)
    return result


def run_query(path: Path, sources: list[str], stem: Path) -> dict:
    stem.parent.mkdir(parents=True, exist_ok=True)
    out_path = stem.with_suffix(".srj")
    receipt_path = stem.with_suffix(".receipt.json")
    for stale in (out_path, receipt_path):
        stale.unlink(missing_ok=True)
    command = ["node", "--max-old-space-size=2048", str(BIN), "-f", str(path), "--out", str(out_path),
               "--receipt", str(receipt_path), "--max-requests", MAX_REQUESTS, "--max-bytes", MAX_BYTES,
               "--timeout", str(TIMEOUT), "--http-retries", "8"]
    for source in sources:
        command += ["--source", source]
    try:
        completed = subprocess.run(command, cwd=REPO, capture_output=True, text=True, timeout=TIMEOUT + 60)
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "harness-timeout"}
    stderr = completed.stderr
    if "heap out of memory" in stderr.lower() or "javascript heap" in stderr.lower():
        return {"ok": False, "error": "oom", "exitCode": completed.returncode}
    return summarize(receipt_path, out_path, completed.returncode, stderr)


def determinate(text: str) -> bool:
    """Whether the query denotes one bag: a LIMIT without ORDER BY leaves the subset to the plan."""
    return not re.search(r"(?i)\bLIMIT\b", text) or bool(re.search(r"(?i)\bORDER\s+BY\b", text))


def compare(results: dict[str, dict], earlier_path: Path) -> None:
    earlier = json.loads(earlier_path.read_text(encoding="utf-8"))["results"]
    ran = {k: v["result"] for k, v in results.items() if not v["result"].get("skipped")}
    old_nonempty = {k for k, v in earlier.items() if v["result"].get("ok") and v["result"].get("rows", 0) > 0}
    new_nonempty = {k for k, v in ran.items() if v.get("ok") and v.get("rows", 0) > 0}
    comparable = {k for k in old_nonempty & new_nonempty if results[k].get("determinate")}
    same_hash = {k for k in comparable if earlier[k]["result"].get("multisetHash") == ran[k].get("multisetHash")}
    same_rows = {k for k in old_nonempty & new_nonempty if earlier[k]["result"].get("rows") == ran[k].get("rows")}
    print(f"\nCompared with {earlier_path.name}:")
    print(f"  non-empty results: earlier {len(old_nonempty)}, now {len(new_nonempty)}, "
          f"both {len(old_nonempty & new_nonempty)}, same row count {len(same_rows)}")
    print(f"  identical bags {len(same_hash)} of {len(comparable)} whose query denotes one bag "
          f"(the rest have LIMIT without ORDER BY, so the subset is the plan's)")
    for k in sorted(comparable - same_hash):
        print(f"    differing bag: {k}: earlier {label(earlier[k]['result'])} | now {label(ran[k])}")
    for name, keys in (("non-empty earlier, not now", old_nonempty - new_nonempty),
                       ("non-empty now, not earlier", new_nonempty - old_nonempty)):
        if keys:
            print(f"  {name} ({len(keys)}):")
            for k in sorted(keys):
                print(f"    {k}: earlier {label(earlier[k]['result'])} | now {label(ran.get(k, {'error': 'not run'}))}")
    failed = {k for k, v in earlier.items() if v["result"].get("error") in ("timeout", "oom")}
    print(f"  earlier timeouts and heap deaths ({len(failed)}), now:")
    for k in sorted(failed):
        print(f"    {k}: {label(ran.get(k, {'error': 'not run'}))}")


def main() -> None:
    if len(sys.argv) > 2 and sys.argv[1] == "--compare-only":
        compare(json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))["results"], COMPARE)
        return
    descriptor = json.load(urllib.request.urlopen(f"{ROOT}/"))
    origin = "{0.scheme}://{0.netloc}".format(urllib.parse.urlparse(ROOT))
    datasets = {item["id"]: item for item in descriptor["datasets"]}
    available = sorted(datasets)
    files = sorted(QUERY_ROOT.rglob("*.rq"))
    if ONLY:
        files = [path for path in files if ONLY in str(path.relative_to(QUERY_ROOT))]
    results: dict[str, dict] = {}
    budget = {"maxRequests": int(MAX_REQUESTS), "maxBytes": MAX_BYTES, "timeoutSeconds": TIMEOUT}
    print(f"{len(files)} registry queries via {BIN.name}; budget {budget}; results -> {OUT}", flush=True)

    for index, path in enumerate(files, 1):
        query_id = str(path.relative_to(QUERY_ROOT).with_suffix(""))
        text = path.read_text(encoding="utf-8")
        tags = header_tags(text)
        targets, target_note = targets_for(path, tags, available)
        unavailable = [target for target in targets if target not in datasets]
        record = {"path": str(path), "tags": tags, "targets": targets, "targetNote": target_note,
                  "serviceIris": service_iris(text), "determinate": determinate(text)}
        skipped = skip_record(targets, target_note, unavailable)
        if skipped:
            record["result"] = skipped
        else:
            sources = [f"kgf@{urllib.parse.urljoin(origin, datasets[target]['links']['fragment'])}" for target in targets]
            record["sources"] = sources
            stem = RUN_DIR / query_id
            record["receipt"] = str(stem.with_suffix(".receipt.json"))
            record["result"] = run_query(path, sources, stem)
        results[query_id] = record
        OUT.write_text(json.dumps({
            "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "kgfRoot": ROOT,
            "budget": budget,
            "results": results,
        }, indent=2) + "\n", encoding="utf-8")
        print(f"[{index:>2}/{len(files)}] {label(record['result']):>35}  {query_id}", flush=True)

    ran = [v["result"] for v in results.values() if not v["result"].get("skipped")]
    contracts = Counter(r.get("contract", r.get("error", "error")) for r in ran)
    print(f"\n{len(ran)} ran: {dict(contracts)}; non-empty {sum(1 for r in ran if r.get('ok') and r.get('rows', 0) > 0)}")
    if COMPARE.exists():
        compare(results, COMPARE)


if __name__ == "__main__":
    main()
