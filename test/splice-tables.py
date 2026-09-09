"""Splice report-tables.py output into the evaluation doc at <!-- TABLE:name --> markers."""
import re
import subprocess
import sys

doc = sys.argv[1] if len(sys.argv) > 1 else "docs/public-deployment-comunica-evaluation.md"
out = subprocess.run([sys.executable, "test/report-tables.py"], capture_output=True, text=True, check=True).stdout
sections = {}
name = None
for line in out.splitlines():
    m = re.match(r"<!-- (.+?) -->", line)
    if m and " tasks;" not in m.group(1):
        name = {"rescued/lost detail": "rescued", "selected per-task table": "selected", "turtle wall clock": "turtle",
                "variance": "variance", "federation": "federation"}.get(m.group(1), m.group(1))
        sections[name] = []
        continue
    if name is None and line.startswith("|"):
        sections.setdefault("arms", []).append(line)
    elif name:
        sections[name].append(line)
text = open(doc).read()
for key, lines in sections.items():
    body = "\n".join(lines).strip("\n")
    marker = f"<!-- TABLE:{key} -->"
    pattern = re.compile(re.escape(marker) + r"\n(?:(?!\n## |\n### |\n\*\*|\n\"|\n[A-Za-z`]).*\n?)*", re.S)
    if marker in text:
        text = text.replace(marker, marker + "\n" + body, 1) if not re.search(re.escape(marker) + r"\n\|", text) else pattern.sub(marker + "\n" + body + "\n", text, count=1)
        print(f"spliced {key}: {len(lines)} lines")
    else:
        print(f"no marker for {key}")
open(doc, "w").write(text)
