"""Compare two runs of the command-line corpus: outcomes, request counts, regressions.

usage: python3 test/compare-runs.py before.json after.json
Both files are outputs of test/registry-corpus-cli.py.
"""

from __future__ import annotations

from collections import Counter
import json
from pathlib import Path
import statistics
import sys


def load(path: str) -> dict[str, dict]:
    return {k: v["result"] for k, v in json.loads(Path(path).read_text(encoding="utf-8"))["results"].items()
            if not v["result"].get("skipped")}


def outcome(result: dict) -> str:
    contract = result.get("contract")
    if contract == "aborted":
        return f"aborted:{result.get('budget')}"
    return contract or "error"


def main() -> None:
    before, after = load(sys.argv[1]), load(sys.argv[2])
    shared = sorted(set(before) & set(after))
    print(f"{len(shared)} queries in both runs")
    transitions = Counter((outcome(before[k]), outcome(after[k])) for k in shared)
    print("outcome transitions (before -> after):")
    for (b, a), n in sorted(transitions.items(), key=lambda item: -item[1]):
        print(f"  {n:>3}  {b} -> {a}")
    ok_both = [k for k in shared if before[k].get("ok") and after[k].get("ok")]
    ratios = sorted((after[k]["requests"] / max(before[k]["requests"], 1), k) for k in ok_both)
    if ratios:
        print(f"\nrequests after/before over {len(ratios)} queries complete in both: "
              f"median {statistics.median(r for r, _ in ratios):.2f}, "
              f"total {sum(after[k]['requests'] for k in ok_both):,} vs {sum(before[k]['requests'] for k in ok_both):,}")
        print("  largest reductions:")
        for r, k in ratios[:8]:
            print(f"    {r:6.2f}x  {k}: {before[k]['requests']:>6} -> {after[k]['requests']:>6} req, "
                  f"{before[k]['seconds']:.1f}s -> {after[k]['seconds']:.1f}s")
        worse = [(r, k) for r, k in ratios if r > 1.05]
        print(f"  queries needing more requests than before ({len(worse)}):")
        for r, k in sorted(worse, reverse=True):
            print(f"    {r:6.2f}x  {k}: {before[k]['requests']:>6} -> {after[k]['requests']:>6} req")
    rows_changed = [k for k in ok_both if before[k].get("rows") != after[k].get("rows")]
    hashes_changed = [k for k in ok_both if before[k].get("multisetHash") and after[k].get("multisetHash")
                      and before[k]["multisetHash"] != after[k]["multisetHash"]]
    print(f"\nrow counts differ on {len(rows_changed)} queries: {rows_changed}")
    print(f"result bags differ on {len(hashes_changed)} queries (plan-dependent LIMIT subsets expected): {hashes_changed}")
    lost = [k for k in shared if before[k].get("ok") and not after[k].get("ok")]
    gained = [k for k in shared if not before[k].get("ok") and after[k].get("ok")]
    print(f"\ncomplete before, not after ({len(lost)}): {lost}")
    print(f"complete after, not before ({len(gained)}): {gained}")
    for k in gained:
        print(f"    {k}: {outcome(before[k])} -> {after[k]['rows']} rows, {after[k]['requests']} req, {after[k]['seconds']}s")


if __name__ == "__main__":
    main()
