"""Shared pieces of the okn-registry corpus runners.

The query header's ``#+ tags`` identify target datasets. Legacy queries tagged only
``federation`` are mapped explicitly below because that tag is not a KGF dataset id.
Queries that mention Wikidata are intentionally skipped.
"""

from __future__ import annotations

from pathlib import Path
import re


HERE = Path(__file__).resolve().parent
REPO = HERE.parent
QUERY_ROOT = REPO.parent / "okn-registry" / "docs" / "registry" / "queries"

# These older query headers say only "federation". The mappings are inferred from
# their domain namespaces and are kept explicit so benchmark scope is reviewable.
FEDERATION_TARGETS = {
    "fio-spatial-facilities-in-state": ["fiokg", "spatialkg"],
    "nde-diseases-mondo-parents": ["nde", "ubergraph"],
    "sawgraph-hydrology-spatial-04": ["hydrologykg", "spatialkg"],
    "sawgraph-hydrology-spatial_03": ["hydrologykg", "spatialkg"],
    "sawgraph-spatial-hydrology-01": ["hydrologykg", "spatialkg"],
}

ALIASES = {
    "fio-kg": "fiokg",
}


def header_tags(text: str) -> list[str]:
    tags: list[str] = []
    in_tags = False
    for line in text.splitlines():
        if line.startswith("#+ tags:"):
            in_tags = True
            continue
        if in_tags:
            match = re.match(r"^#\+\s+-\s+(.+?)\s*$", line)
            if match:
                tags.append(match.group(1).strip())
                continue
            break
    return tags


def service_iris(text: str) -> list[str]:
    """Return hard-coded SPARQL SERVICE targets, which are not KGF sources."""
    return sorted(set(re.findall(r"(?i)\bSERVICE\s*<([^>]+)>", text)))


def targets_for(path: Path, tags: list[str], available: list[str]) -> tuple[list[str], str | None]:
    lower_text = path.read_text(encoding="utf-8").lower()
    if "wikidata" in tags or "wikidata.org" in lower_text or "wikidata" in path.name.lower():
        return [], "wikidata"

    targets = [ALIASES.get(tag, tag) for tag in tags if tag != "federation"]
    if targets:
        return targets, None

    stem = path.stem
    if stem in FEDERATION_TARGETS:
        return FEDERATION_TARGETS[stem], "inferred-federation-targets"
    if stem in {"list-things-and-their-labels", "one-hundred-triples"}:
        return available, "all-local-datasets"
    return [], "unresolved-federation-targets"


def skip_record(targets: list[str], target_note: str | None, unavailable: list[str]) -> dict | None:
    """The result record for a query the run does not execute, or None when it runs."""
    if target_note == "wikidata":
        return {"ok": False, "skipped": True, "error": "wikidata"}
    if unavailable:
        return {"ok": False, "skipped": True, "error": "unavailable-dataset", "datasets": unavailable}
    if not targets:
        return {"ok": False, "skipped": True, "error": target_note or "no-targets"}
    return None


def label(result: dict) -> str:
    if not result.get("ok"):
        return str(result.get("error", "error"))[:24]
    return f"{result.get('rows', 0):>7} rows {result.get('requests', 0):>6} req {result.get('seconds', 0):>5.1f}s"
