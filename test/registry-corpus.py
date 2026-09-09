"""Run okn-registry's documented SPARQL queries against the local KGF server.

This is the brTPF runner behind docs/okn-registry-query-evaluation.md. The native-source
run through the kgf-sparql command line is test/registry-corpus-cli.py.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.request

from registry_corpus_common import HERE, QUERY_ROOT, REPO, header_tags, label, service_iris, skip_record, targets_for


ROOT = os.environ.get("KGF_ROOT", "http://127.0.0.1:8080")
TIMEOUT = int(os.environ.get("REGISTRY_QUERY_TIMEOUT", "30"))
STATS = HERE / "void-stats.json"
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "registry-query-results.json"


def run_query(text: str, endpoints: list[str]) -> dict:
    command = [
        "node",
        "--max-old-space-size=2048",
        "test/run-registry-query.mjs",
        str(TIMEOUT * 1000),
        str(STATS),
        *endpoints,
    ]
    try:
        completed = subprocess.run(
            command,
            input=text,
            cwd=REPO,
            capture_output=True,
            text=True,
            timeout=TIMEOUT + 20,
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "harness-timeout"}

    output = completed.stdout.strip()
    if output.startswith("{"):
        try:
            return json.loads(output)
        except json.JSONDecodeError:
            pass
    stderr = completed.stderr
    if "heap out of memory" in stderr.lower() or "javascript heap" in stderr.lower():
        error = "oom"
    elif completed.returncode < 0:
        error = f"signal:{-completed.returncode}"
    else:
        error = (stderr or output or f"exit:{completed.returncode}")[-500:]
    return {"ok": False, "error": error}


def main() -> None:
    descriptor = json.load(urllib.request.urlopen(f"{ROOT}/"))
    releases = {item["id"]: item["current"] for item in descriptor["datasets"]}
    available = sorted(releases)
    files = sorted(QUERY_ROOT.rglob("*.rq"))
    results: dict[str, dict] = {}
    print(f"{len(files)} registry queries; {TIMEOUT}s timeout; results -> {OUT}", flush=True)

    for index, path in enumerate(files, 1):
        query_id = str(path.relative_to(QUERY_ROOT).with_suffix(""))
        text = path.read_text(encoding="utf-8")
        tags = header_tags(text)
        targets, target_note = targets_for(path, tags, available)
        unavailable = [target for target in targets if target not in releases]

        record = {
            "path": str(path),
            "tags": tags,
            "targets": targets,
            "targetNote": target_note,
            "serviceIris": service_iris(text),
        }
        skipped = skip_record(targets, target_note, unavailable)
        if skipped:
            record["result"] = skipped
        else:
            endpoints = [f"{ROOT}/{target}/v/{releases[target]}/fragment" for target in targets]
            record["endpoints"] = endpoints
            record["result"] = run_query(text, endpoints)

        results[query_id] = record
        OUT.write_text(json.dumps({
            "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "kgfRoot": ROOT,
            "timeoutSeconds": TIMEOUT,
            "results": results,
        }, indent=2) + "\n", encoding="utf-8")
        print(f"[{index:>2}/{len(files)}] {label(record['result']):>35}  {query_id}", flush=True)


if __name__ == "__main__":
    main()
