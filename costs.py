"""Token counting + dollar math + budget cap.

Prices (2026, in $ per 1M tokens):
  Opus 4.7   input=15.00  output=75.00
  Sonnet 4.6 input= 3.00  output=15.00
  Haiku 4.5  input= 0.80  output= 4.00
  Web search: $0.01 per call (Anthropic-hosted web_search tool)
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path

PRICES = {
    "claude-opus-4-7":     (15.00, 75.00),
    "claude-opus-4-6":     (15.00, 75.00),
    "claude-sonnet-4-6":   (3.00, 15.00),
    "claude-sonnet-4-5":   (3.00, 15.00),
    "claude-haiku-4-5":    (0.80, 4.00),
    "claude-haiku-4-5-20251001": (0.80, 4.00),
}
WEB_SEARCH_PER_CALL = 0.01

SESSION_CAP_USD = float(os.environ.get("ATLAS_SESSION_CAP", "10.0"))
DAILY_CAP_USD   = float(os.environ.get("ATLAS_DAILY_CAP", "25.0"))


def model_cost(model: str, input_tokens: int, output_tokens: int) -> float:
    in_p, out_p = PRICES.get(model, (3.0, 15.0))
    return (input_tokens * in_p + output_tokens * out_p) / 1_000_000.0


@dataclass
class CallCost:
    role: str            # "plan" | "worker" | "merge"
    model: str
    input_tokens: int
    output_tokens: int
    dollars: float
    label: str = ""      # e.g. "worker#2: sales script"

@dataclass
class TurnCost:
    turn: int
    calls: list[CallCost] = field(default_factory=list)
    web_searches: int = 0
    total_dollars: float = 0.0
    started_at: float = field(default_factory=time.time)

    def add_call(self, role: str, model: str, input_tokens: int, output_tokens: int, label: str = ""):
        d = model_cost(model, input_tokens, output_tokens)
        self.calls.append(CallCost(role, model, input_tokens, output_tokens, d, label))
        self.total_dollars += d
        return d

    def add_web_search(self, n: int = 1):
        self.web_searches += n
        cost = n * WEB_SEARCH_PER_CALL
        self.total_dollars += cost
        return cost


class SessionCosts:
    """Persistent per-session cost log. One line = one turn."""
    def __init__(self, path: Path):
        self.path = Path(path)
        self.session_total = 0.0
        self.turns: list[dict] = []
        self._load()

    def _load(self):
        if not self.path.exists():
            return
        for line in self.path.read_text().splitlines():
            if not line.strip():
                continue
            d = json.loads(line)
            self.turns.append(d)
            self.session_total += d.get("total_dollars", 0.0)

    def append(self, turn_cost: TurnCost) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a") as f:
            f.write(json.dumps({
                "turn": turn_cost.turn,
                "started_at": turn_cost.started_at,
                "calls": [asdict(c) for c in turn_cost.calls],
                "web_searches": turn_cost.web_searches,
                "total_dollars": turn_cost.total_dollars,
            }) + "\n")
        self.session_total += turn_cost.total_dollars
        self.turns.append({"total_dollars": turn_cost.total_dollars})

    def today_dollars(self) -> float:
        now = time.time()
        day_start = now - (now % 86400)
        # crude but works for a rough cap
        total = 0.0
        for t in self.turns:
            if t.get("started_at", 0) >= day_start:
                total += t.get("total_dollars", 0.0)
        return total


def check_cap(session_total: float, today_total: float) -> tuple[bool, str]:
    """Return (allowed, reason). Allowed=False means refuse to start new turn."""
    if session_total >= SESSION_CAP_USD:
        return False, f"session cap hit: ${session_total:.2f} ≥ ${SESSION_CAP_USD:.2f}"
    if today_total >= DAILY_CAP_USD:
        return False, f"daily cap hit: ${today_total:.2f} ≥ ${DAILY_CAP_USD:.2f}"
    return True, ""


def usage_from_response(resp) -> tuple[int, int]:
    """Extract (input_tokens, output_tokens) from an anthropic response."""
    u = getattr(resp, "usage", None)
    if u is None:
        return 0, 0
    return int(getattr(u, "input_tokens", 0) or 0), int(getattr(u, "output_tokens", 0) or 0)
