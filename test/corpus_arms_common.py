"""Arm definitions shared by corpus-arms.py and federation-arms.py."""
import os


def ARMS_FOR(stats, here):
    cfg256 = os.path.join(str(here), "cfg-block256.json")
    return {
        # built-in setups
        "qpf":          ["--source", "qpf",   "--stats", "none"],
        "brtpf":        ["--source", "brtpf", "--stats", "none"],
        # KGF-informed customizations, individually and combined
        "void":         ["--source", "brtpf", "--stats", stats],
        "page10k":      ["--source", "brtpf", "--stats", "none", "--page-limit", "10000"],
        "ramp":         ["--source", "brtpf", "--stats", "none", "--page-limit", "10000",
                         "--page-limit-mode", "ramp"],
        "void+ramp":    ["--source", "brtpf", "--stats", stats,  "--page-limit", "10000",
                         "--page-limit-mode", "ramp"],
        "all":          ["--source", "brtpf", "--stats", stats,  "--page-limit", "10000",
                         "--page-limit-mode", "ramp", "--config", cfg256],
        "qpf+void":     ["--source", "qpf",   "--stats", stats],
        "qpf+ramp":     ["--source", "qpf",   "--stats", "none", "--page-limit", "10000",
                         "--page-limit-mode", "ramp"],
        "block256":     ["--source", "brtpf", "--stats", "none", "--config", cfg256],
        "void+block256": ["--source", "brtpf", "--stats", stats, "--config", cfg256],
        "turtle":       ["--source", "brtpf", "--stats", "none", "--accept", "text/turtle"],
        "all+turtle":   ["--source", "brtpf", "--stats", stats,  "--page-limit", "10000",
                         "--page-limit-mode", "ramp", "--config", cfg256, "--accept", "text/turtle"],
    }
