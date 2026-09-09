"""Merge the per-task arm results of several corpus-arms files into one.

usage: python3 test/merge-arms.py out.json in1.json in2.json ...
Later files add arms; an arm already present is kept from the earlier file.
"""
import json
import sys

out, *ins = sys.argv[1:]
merged = {}
for path in ins:
    for task, rec in json.load(open(path)).items():
        cur = merged.setdefault(task, {k: v for k, v in rec.items() if k != "arms"} | {"arms": {}})
        for arm, res in rec["arms"].items():
            cur["arms"].setdefault(arm, res)
json.dump(merged, open(out, "w"), indent=1)
print(f"{len(merged)} tasks, arms: {sorted({a for r in merged.values() for a in r['arms']})}")
