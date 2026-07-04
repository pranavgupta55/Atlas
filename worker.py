"""One Sonnet worker: runs a focused research task with scribe_retrieve + web_search.

Returns: {findings: str (dense bullets with [source_id] citations),
          sources: [{source_id, source_name, source_title, source_url, kind}]}

The tool loop is: worker calls scribe_retrieve (mandatory) → optionally web_search →
emits <findings> block. Tool loop capped at 6 iterations to bound cost.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Any

import anthropic

import prompts
import scribe_client

WORKER_MODEL = os.environ.get("ATLAS_WORKER_MODEL", "claude-sonnet-4-6")
MAX_TOOL_LOOPS = 6

SCRIBE_TOOL = {
    "name": "scribe_retrieve",
    "description": ("Retrieve chunks + facts from the local Scribe knowledge base "
                    "(YouTube business transcripts, structured claims). MANDATORY: "
                    "call once before answering. Pass 3 sub_queries per call."),
    "input_schema": {
        "type": "object",
        "properties": {
            "sub_queries": {
                "type": "array",
                "items": {"type": "string"},
                "description": "1-4 distinct rewordings/step-backs of your question.",
                "minItems": 1, "maxItems": 4,
            },
            "k_facts":   {"type": "integer", "default": 8, "minimum": 1, "maximum": 20},
            "k_chunks":  {"type": "integer", "default": 8, "minimum": 1, "maximum": 20},
        },
        "required": ["sub_queries"],
    },
}

WEB_TOOL = {"type": "web_search_20250305", "name": "web_search", "max_uses": 3}


@dataclass
class WorkerResult:
    findings: str
    sources_used: list[dict] = field(default_factory=list)  # [{source_id, source_name, ...}]
    scribe_hits: list[scribe_client.Retrieval] = field(default_factory=list)
    web_hits: list[dict] = field(default_factory=list)
    error: str | None = None


def _run_scribe(sub_queries: list[str], k_facts: int, k_chunks: int) -> tuple[dict, scribe_client.Retrieval]:
    """Call Scribe for each sub_query, merge, return {result_for_model, Retrieval}."""
    merged = scribe_client.Retrieval(query=sub_queries[0], sub_queries=sub_queries, topics=[])
    seen_topics = set()
    seen_sids = set()
    for q in sub_queries:
        try:
            r = scribe_client.retrieve(q, k_facts=k_facts, k_chunks=k_chunks, max_topics=6)
        except Exception as e:
            return {"error": f"scribe_retrieve failed: {e}"}, merged
        for t in r.topics:
            if t not in seen_topics:
                merged.topics.append(t); seen_topics.add(t)
        for c in r.chunks:
            if c.source_id not in seen_sids:
                merged.chunks.append(c); seen_sids.add(c.source_id)
        for f in r.facts:
            if f.source_id not in seen_sids:
                merged.facts.append(f); seen_sids.add(f.source_id)

    # Return a compact form to the model: source_id + short snippet
    payload = {
        "topics": merged.topics,
        "sub_queries": sub_queries,
        "chunks": [{"source_id": c.source_id, "source_title": c.source_title,
                    "text": c.text} for c in merged.chunks],
        "facts": [{"source_id": f.source_id, "source_title": f.source_title,
                   "text": f.text} for f in merged.facts],
    }
    return payload, merged


def run_worker(task_prompt: str, focus: str, hot_block: str) -> WorkerResult:
    """Execute one worker turn. Blocks until worker emits final text (no more tool calls)."""
    client = anthropic.Anthropic()
    user_content = prompts.render_worker_task(task_prompt, focus, hot_block)
    messages: list[dict[str, Any]] = [{"role": "user", "content": user_content}]

    result = WorkerResult(findings="")
    called_scribe = False

    for _ in range(MAX_TOOL_LOOPS):
        resp = client.messages.create(
            model=WORKER_MODEL,
            max_tokens=2500,
            system=prompts.WORKER_SYSTEM,
            tools=[SCRIBE_TOOL, WEB_TOOL],
            messages=messages,
        )

        # Append assistant response
        messages.append({"role": "assistant", "content": resp.content})

        # Extract tool_use blocks; also capture any final text
        tool_uses = [b for b in resp.content if b.type == "tool_use"]
        text_blocks = [b.text for b in resp.content if b.type == "text"]

        if resp.stop_reason == "end_turn" or not tool_uses:
            result.findings = "\n\n".join(text_blocks).strip()
            if not called_scribe:
                result.error = "worker skipped scribe_retrieve"
            return result

        # Process tool_use
        tool_results = []
        for tu in tool_uses:
            if tu.name == "scribe_retrieve":
                called_scribe = True
                sub_qs = tu.input.get("sub_queries", [])
                payload, merged = _run_scribe(
                    sub_qs,
                    tu.input.get("k_facts", 8),
                    tu.input.get("k_chunks", 8),
                )
                result.scribe_hits.append(merged)
                # Track sources for context_store
                for c in merged.chunks:
                    result.sources_used.append({
                        "source_id": c.source_id, "source_name": c.source_name,
                        "source_title": c.source_title, "source_url": c.source_url,
                        "section_title": c.section_title, "kind": "chunk",
                        "full_text": c.text,
                    })
                for f in merged.facts:
                    result.sources_used.append({
                        "source_id": f.source_id, "source_name": f.source_name,
                        "source_title": f.source_title, "source_url": f.source_url,
                        "section_title": "", "kind": "fact", "full_text": f.text,
                    })
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": tu.id,
                    "content": json.dumps(payload)[:15000],
                })
            elif tu.name == "web_search":
                # web_search is server-side; Anthropic executes and returns results
                # as tool_result blocks. We just record that it was used.
                # Nothing to do here — the server-side tool is handled by the API.
                pass

        if tool_results:
            messages.append({"role": "user", "content": tool_results})

    result.findings = "\n\n".join([b.text for b in resp.content if b.type == "text"]).strip() \
                      or "NO_SOURCE_COVERAGE — worker exceeded tool-loop budget."
    result.error = "tool_loop_exhausted"
    return result


if __name__ == "__main__":
    import sys
    task = sys.argv[1] if len(sys.argv) > 1 else "How do I get my first 10 customers as a mobile car detailer?"
    r = run_worker(task, focus="lead generation for local mobile services", hot_block="<hot_sources/>")
    print("=== findings ===")
    print(r.findings)
    print(f"\n=== sources used: {len(r.sources_used)} ===")
    for s in r.sources_used[:5]:
        print(f"  {s['source_id']} — {s.get('source_title','')[:50]}")
    if r.error:
        print(f"\nerror: {r.error}")
