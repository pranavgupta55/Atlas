"""Thin HTTP client for Scribe's /api/retrieve endpoint.

Scribe runs locally on :8765. We call /api/retrieve with our own k parameters
and get back {topics, sources: [{name, title, url, passages, facts}], sub_queries}.
Flattens sources into per-passage/per-fact Chunk/Fact objects for easy
per-source-id citation by workers.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field

import httpx

SCRIBE_URL = os.environ.get("SCRIBE_URL", "http://localhost:8765")


@dataclass
class Chunk:
    source_id: str
    source_name: str
    section_title: str
    text: str
    source_title: str = ""
    source_url: str = ""


@dataclass
class Fact:
    source_id: str
    source_name: str
    text: str
    source_title: str = ""
    source_url: str = ""


@dataclass
class Retrieval:
    query: str
    sub_queries: list[str]
    topics: list[str]
    chunks: list[Chunk] = field(default_factory=list)
    facts: list[Fact] = field(default_factory=list)

    def all_source_ids(self) -> list[str]:
        return [c.source_id for c in self.chunks] + [f.source_id for f in self.facts]


def retrieve(query: str, k_facts: int = 8, k_chunks: int = 8,
             max_topics: int = 6, timeout: float = 30.0) -> Retrieval:
    body = {"query": query, "k_facts": k_facts, "k_chunks": k_chunks,
            "max_topics": max_topics}
    with httpx.Client(timeout=timeout) as c:
        r = c.post(f"{SCRIBE_URL}/api/retrieve", json=body)
        r.raise_for_status()
        data = r.json()
    if "error" in data:
        raise RuntimeError(data["error"])

    ret = Retrieval(
        query=data.get("query", query),
        sub_queries=data.get("sub_queries", [query]),
        topics=data.get("topics", []),
    )
    for src in data.get("sources", []):
        name = src.get("name", "?")
        title = src.get("title", "")
        url = src.get("url", "")
        for p in src.get("passages", []):
            sec = p.get("section_title", "")
            sid = f"{name}::{sec}" if sec else name
            ret.chunks.append(Chunk(sid, name, sec, p.get("text", ""), title, url))
        for i, fact_text in enumerate(src.get("facts", [])):
            ret.facts.append(Fact(f"{name}::fact:{i}", name, fact_text, title, url))
    return ret


if __name__ == "__main__":
    import sys
    q = sys.argv[1] if len(sys.argv) > 1 else "how to get google reviews"
    r = retrieve(q, k_facts=5, k_chunks=5, max_topics=4)
    print(f"query: {r.query}")
    print(f"sub_queries: {r.sub_queries}")
    print(f"topics: {r.topics}")
    print(f"chunks: {len(r.chunks)}, facts: {len(r.facts)}")
    for c in r.chunks[:3]:
        print(f"  chunk [{c.source_id}] {c.text[:100]}")
    for f in r.facts[:3]:
        print(f"  fact  [{f.source_id}] {f.text[:100]}")
