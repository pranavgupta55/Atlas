"""Three-tier context store.

  HOT   in-prompt full-text (top ~50 sources by score, injected into workers)
  WARM  breadcrumb (title + summary + entities) for every source ever seen
  COLD  Scribe ChromaDB — canonical archive

Score math:  new = 4; hit again this turn +=4; not hit this turn /=2; evict <0.5.
A source hit 2 consecutive turns rises fast and survives many idle turns;
a one-hit-wonder falls out after ~3 idle turns.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field, asdict
from pathlib import Path


@dataclass
class WarmEntry:
    source_id: str
    source_name: str
    source_title: str = ""
    source_url: str = ""
    section_title: str = ""
    kind: str = "chunk"
    breadcrumb: str = ""
    full_text: str = ""
    score: float = 4.0
    hits_total: int = 1
    last_turn: int = 0


class ContextStore:
    HOT_CAP = 50
    EVICT_THRESHOLD = 0.5
    HIT_BOOST = 4.0

    def __init__(self, path: Path):
        self.path = Path(path)
        self.turn = 0
        self._entries: dict[str, WarmEntry] = {}
        self._hits_this_turn: set[str] = set()
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        for line in self.path.read_text().splitlines():
            if not line.strip():
                continue
            e = WarmEntry(**json.loads(line))
            self._entries[e.source_id] = e
        self.turn = max((e.last_turn for e in self._entries.values()), default=0)

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("w") as f:
            for e in self._entries.values():
                f.write(json.dumps(asdict(e)) + "\n")

    def begin_turn(self) -> None:
        self.turn += 1
        self._hits_this_turn.clear()

    def record_hit(self, source_id: str, *, source_name: str = "",
                   source_title: str = "", source_url: str = "",
                   section_title: str = "", kind: str = "chunk",
                   full_text: str = "", breadcrumb: str = "") -> None:
        if source_id in self._hits_this_turn:
            if source_id in self._entries and full_text:
                self._entries[source_id].full_text = full_text
            return
        self._hits_this_turn.add(source_id)

        e = self._entries.get(source_id)
        if e is None:
            self._entries[source_id] = WarmEntry(
                source_id=source_id, source_name=source_name,
                source_title=source_title, source_url=source_url,
                section_title=section_title, kind=kind,
                breadcrumb=breadcrumb, full_text=full_text,
                score=self.HIT_BOOST, hits_total=1, last_turn=self.turn,
            )
        else:
            e.score += self.HIT_BOOST
            e.hits_total += 1
            e.last_turn = self.turn
            if full_text:
                e.full_text = full_text
            if breadcrumb and not e.breadcrumb:
                e.breadcrumb = breadcrumb

    def end_turn(self) -> None:
        dead = []
        for sid, e in self._entries.items():
            if sid in self._hits_this_turn:
                continue
            e.score /= 2.0
            if e.score < self.EVICT_THRESHOLD:
                dead.append(sid)
        for sid in dead:
            del self._entries[sid]
        hot_ids = {e.source_id for e in self.hot()}
        for sid, e in self._entries.items():
            if sid not in hot_ids and e.full_text:
                e.full_text = ""
        self.save()

    def hot(self) -> list[WarmEntry]:
        ranked = sorted(self._entries.values(),
                        key=lambda e: (-e.score, -e.last_turn))
        return ranked[: self.HOT_CAP]

    def warm(self) -> list[WarmEntry]:
        return sorted(self._entries.values(),
                      key=lambda e: (-e.score, -e.last_turn))

    def size(self) -> int:
        return len(self._entries)

    def render_hot_block(self, char_budget: int = 12000) -> str:
        """XML-tagged HOT sources for injection into worker prompt.
        Budgeted at ~12K chars (~3K tokens) — falls back to breadcrumbs once full."""
        lines = ["<hot_sources>"]
        used = len(lines[0])
        for e in self.hot():
            title = e.source_title or e.source_name
            text = e.full_text or e.breadcrumb
            block = (f'  <source id="{e.source_id}" title="{title}" score="{e.score:.1f}">\n'
                     f"    {text}\n  </source>")
            if used + len(block) > char_budget:
                # Fall back to breadcrumb only
                block = f'  <source id="{e.source_id}" title="{title}" score="{e.score:.1f}"/>'
                if used + len(block) > char_budget:
                    lines.append("  <!-- more sources elided (budget) -->")
                    break
            lines.append(block)
            used += len(block) + 1
        lines.append("</hot_sources>")
        return "\n".join(lines)


if __name__ == "__main__":
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        cs = ContextStore(Path(td) / "context.jsonl")
        for t in range(5):
            cs.begin_turn()
            cs.record_hit("A", source_name="a.txt", full_text="A text", breadcrumb="A")
            if t < 2:
                cs.record_hit("B", source_name="b.txt", full_text="B text", breadcrumb="B")
            cs.end_turn()
            print(f"turn {t}: {[(e.source_id, round(e.score,2)) for e in cs.warm()]}")
