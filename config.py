"""Runtime-tunable config: cheap_mode toggle for all-Haiku testing.

Persists to data/config.json. Read on every model call so a UI toggle takes
effect on the NEXT turn without a server restart.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

DATA_DIR = Path(__file__).parent / "data"
PATH = DATA_DIR / "config.json"

DEFAULTS = {
    "cheap_mode": False,
    "orch_model":   os.environ.get("ATLAS_ORCH_MODEL",   "claude-opus-4-7"),
    "worker_model": os.environ.get("ATLAS_WORKER_MODEL", "claude-sonnet-4-6"),
    "merge_model":  os.environ.get("ATLAS_MERGE_MODEL",  "claude-sonnet-4-6"),
    "cheap_model":  os.environ.get("ATLAS_CHEAP_MODEL",  "claude-haiku-4-5"),
}


def get() -> dict:
    if not PATH.exists():
        return dict(DEFAULTS)
    try:
        d = json.loads(PATH.read_text())
    except Exception:
        return dict(DEFAULTS)
    merged = dict(DEFAULTS); merged.update(d)
    return merged


def set(patch: dict) -> dict:
    cur = get()
    cur.update(patch)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(cur, indent=2))
    tmp.replace(PATH)
    return cur


def models() -> tuple[str, str, str]:
    """Return (orch_model, worker_model, merge_model) honoring cheap_mode."""
    c = get()
    if c.get("cheap_mode"):
        m = c.get("cheap_model", "claude-haiku-4-5")
        return m, m, m
    return c["orch_model"], c["worker_model"], c["merge_model"]
