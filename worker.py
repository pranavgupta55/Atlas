"""One Sonnet worker: focused task with scribe_retrieve + web_search.

Streams tool_use events out as they happen (via a callback) so the Flow view
can render each retrieval call as its own node in real time.
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field
from typing import Any, Callable

import anthropic

import costs
import prompts
import retry
import scribe_client

WORKER_MODEL = os.environ.get("ATLAS_WORKER_MODEL", "claude-sonnet-4-6")
MAX_TOOL_LOOPS = 6

SCRIBE_TOOL = {
    "name": "scribe_retrieve",
    "description": ("Retrieve chunks + facts from the local Scribe knowledge base "
                    "(YouTube business transcripts, structured claims). MANDATORY: "
                    "call once before answering. Pass 1-4 sub_queries per call."),
    "input_schema": {
        "type": "object",
        "properties": {
            "sub_queries": {
                "type": "array",
                "items": {"type": "string"},
                "description": "1-4 distinct rewordings/step-backs of your question.",
                "minItems": 1, "maxItems": 4,
            },
            "k_facts":  {"type": "integer", "default": 8, "minimum": 1, "maximum": 20},
            "k_chunks": {"type": "integer", "default": 8, "minimum": 1, "maximum": 20},
        },
        "required": ["sub_queries"],
    },
}

WEB_TOOL = {"type": "web_search_20250305", "name": "web_search", "max_uses": 3}


@dataclass
class WorkerResult:
    findings: str
    sources_used: list[dict] = field(default_factory=list)
    error: str | None = None
    input_tokens: int = 0
    output_tokens: int = 0
    web_searches: int = 0
    tool_calls: list[dict] = field(default_factory=list)  # for Flow view drilldown


def _run_scribe(sub_queries: list[str], k_facts: int, k_chunks: int) -> tuple[dict, list[dict]]:
    """Call Scribe for each sub_query, merge, return (payload_for_model, source_records)."""
    merged_chunks: list[scribe_client.Chunk] = []
    merged_facts: list[scribe_client.Fact] = []
    seen_topics = set()
    topics: list[str] = []
    seen_sids: set[str] = set()

    def _one(q):
        return scribe_client.retrieve(q, k_facts=k_facts, k_chunks=k_chunks, max_topics=6)

    for q in sub_queries:
        try:
            r = retry.with_retry(lambda: _one(q), max_attempts=3, base_delay=1.0)
        except Exception as e:
            return {"error": f"scribe_retrieve failed: {e}"}, []
        for t in r.topics:
            if t not in seen_topics:
                topics.append(t); seen_topics.add(t)
        for c in r.chunks:
            if c.source_id not in seen_sids:
                merged_chunks.append(c); seen_sids.add(c.source_id)
        for f in r.facts:
            if f.source_id not in seen_sids:
                merged_facts.append(f); seen_sids.add(f.source_id)

    payload = {
        "topics": topics,
        "sub_queries": sub_queries,
        "chunks": [{"source_id": c.source_id, "source_title": c.source_title,
                    "text": c.text} for c in merged_chunks],
        "facts": [{"source_id": f.source_id, "source_title": f.source_title,
                   "text": f.text} for f in merged_facts],
    }
    source_records = []
    for c in merged_chunks:
        source_records.append({
            "source_id": c.source_id, "source_name": c.source_name,
            "source_title": c.source_title, "source_url": c.source_url,
            "section_title": c.section_title, "kind": "chunk",
            "full_text": c.text,
        })
    for f in merged_facts:
        source_records.append({
            "source_id": f.source_id, "source_name": f.source_name,
            "source_title": f.source_title, "source_url": f.source_url,
            "section_title": "", "kind": "fact", "full_text": f.text,
        })
    return payload, source_records


def run_worker(
    task_prompt: str, focus: str, hot_block: str,
    worker_id: int,
    emit: Callable[[dict], None],
) -> WorkerResult:
    """Execute one worker turn. Blocks until final text. Emits SSE-shaped events."""
    client = anthropic.Anthropic()
    user_content = prompts.render_worker_task(task_prompt, focus, hot_block)
    messages: list[dict[str, Any]] = [{"role": "user", "content": user_content}]

    result = WorkerResult(findings="")
    called_scribe = False
    tool_call_seq = 0

    for _ in range(MAX_TOOL_LOOPS):
        def _create():
            return client.messages.create(
                model=WORKER_MODEL,
                max_tokens=2500,
                system=prompts.WORKER_SYSTEM,
                tools=[SCRIBE_TOOL, WEB_TOOL],
                messages=messages,
            )
        try:
            resp = retry.with_retry(_create, max_attempts=3, base_delay=1.5,
                                    on_retry=lambda a, w, e: emit({
                                        "type": "worker_retry", "worker_id": worker_id,
                                        "attempt": a, "wait": round(w, 1), "error": str(e)[:200]}))
        except Exception as e:
            result.error = f"api_error: {e}"
            result.findings = "NO_SOURCE_COVERAGE — worker API call failed."
            return result

        in_t, out_t = costs.usage_from_response(resp)
        result.input_tokens += in_t
        result.output_tokens += out_t

        messages.append({"role": "assistant", "content": resp.content})

        tool_uses = [b for b in resp.content if b.type == "tool_use"]
        text_blocks = [b.text for b in resp.content if getattr(b, "type", None) == "text"]

        if resp.stop_reason == "end_turn" or not tool_uses:
            result.findings = "\n\n".join(text_blocks).strip()
            if not called_scribe:
                result.error = "worker skipped scribe_retrieve"
            return result

        tool_results = []
        for tu in tool_uses:
            tool_call_seq += 1
            call_id = f"w{worker_id}.t{tool_call_seq}"
            if tu.name == "scribe_retrieve":
                called_scribe = True
                sub_qs = tu.input.get("sub_queries", [])
                k_f = int(tu.input.get("k_facts", 8))
                k_c = int(tu.input.get("k_chunks", 8))
                emit({"type": "tool_call_start", "worker_id": worker_id, "call_id": call_id,
                      "tool": "scribe_retrieve", "sub_queries": sub_qs,
                      "k_facts": k_f, "k_chunks": k_c})
                t0 = time.time()
                payload, source_records = _run_scribe(sub_qs, k_f, k_c)
                dt = round((time.time() - t0) * 1000)
                # Record tool call metadata for Flow drilldown
                result.tool_calls.append({
                    "call_id": call_id, "tool": "scribe_retrieve",
                    "sub_queries": sub_qs, "n_chunks": len(payload.get("chunks", [])),
                    "n_facts": len(payload.get("facts", [])),
                    "source_ids": [s["source_id"] for s in source_records],
                    "elapsed_ms": dt,
                })
                for s in source_records:
                    if s["source_id"] not in {x["source_id"] for x in result.sources_used}:
                        result.sources_used.append(s)
                emit({"type": "tool_call_done", "worker_id": worker_id, "call_id": call_id,
                      "n_chunks": len(payload.get("chunks", [])),
                      "n_facts": len(payload.get("facts", [])),
                      "sources": [{"source_id": s["source_id"],
                                   "source_title": s.get("source_title", ""),
                                   "source_url": s.get("source_url", ""),
                                   "kind": s.get("kind", "chunk")}
                                   for s in source_records],
                      "elapsed_ms": dt})
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": tu.id,
                    "content": json.dumps(payload)[:15000],
                })
            elif tu.name == "web_search":
                # Server-side; Anthropic executes and includes results in the next assistant msg
                result.web_searches += 1
                emit({"type": "tool_call_start", "worker_id": worker_id, "call_id": call_id,
                      "tool": "web_search", "query": str(tu.input)[:200]})
                # No tool_result needed — server-side.
        if tool_results:
            messages.append({"role": "user", "content": tool_results})

    result.findings = "\n\n".join([b.text for b in resp.content if getattr(b, "type", None) == "text"]).strip() \
                      or "NO_SOURCE_COVERAGE — worker exceeded tool-loop budget."
    result.error = "tool_loop_exhausted"
    return result
