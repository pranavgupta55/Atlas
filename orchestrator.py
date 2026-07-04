"""Atlas orchestrator: user Q → planner → parallel workers → merged answer.

Yields SSE events as it goes:
  {"type": "plan", "workers": [...]}          — after Opus planning
  {"type": "worker_start", "id": 0, "focus": ...}
  {"type": "worker_done", "id": 0, "findings": ..., "sources": [...]}
  {"type": "token", "text": ...}              — streaming synthesis
  {"type": "sources", "sources": [...]}       — final source list
  {"type": "done"}
  {"type": "error", "message": ...}
"""

from __future__ import annotations

import json
import os
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Iterator

import anthropic

import context_store
import prompts
import worker

ORCH_MODEL = os.environ.get("ATLAS_ORCH_MODEL", "claude-opus-4-7")
MERGE_MODEL = os.environ.get("ATLAS_MERGE_MODEL", "claude-sonnet-4-6")

DATA_DIR = Path(__file__).parent / "data"
CTX_PATH = DATA_DIR / "context.jsonl"
HISTORY_PATH = DATA_DIR / "history.jsonl"
BUSINESS_PATH = DATA_DIR / "business.md"


def _load_history(n_last: int = 6) -> list[dict]:
    if not HISTORY_PATH.exists():
        return []
    lines = HISTORY_PATH.read_text().splitlines()[-n_last:]
    out = []
    for line in lines:
        try:
            out.append(json.loads(line))
        except Exception:
            pass
    return out


def _append_history(entry: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with HISTORY_PATH.open("a") as f:
        f.write(json.dumps(entry) + "\n")


def _load_business() -> str:
    if not BUSINESS_PATH.exists():
        return "(business.md is empty — user hasn't distilled yet)"
    return BUSINESS_PATH.read_text()


def _plan_workers(client: anthropic.Anthropic, user_q: str,
                  history: list[dict], business: str, hot_block: str) -> list[dict]:
    """Opus planning call. Returns [{task, focus}, ...] with 1-5 entries."""
    history_str = "\n".join(f"[turn {h.get('turn','?')}] {h.get('role','?')}: {str(h.get('content',''))[:200]}"
                             for h in history) or "(no prior turns)"

    planning_prompt = f"""\
<user_question>{user_q}</user_question>

<recent_history>
{history_str}
</recent_history>

<business_plan>
{business[:3000]}
</business_plan>

{hot_block}

Decompose this user question into 1-5 disjoint worker tasks per the dispatch rules.
Narrow questions → 1-2 workers. Broad questions → 3-5 workers.

Respond with ONLY a JSON array, no preamble:
[{{"task": "worker prompt ≤120 words", "focus": "one-phrase focus label"}}, ...]
"""

    resp = client.messages.create(
        model=ORCH_MODEL,
        max_tokens=1200,
        system=prompts.ORCHESTRATOR_SYSTEM,
        messages=[{"role": "user", "content": planning_prompt}],
    )
    text = "".join(b.text for b in resp.content if b.type == "text").strip()
    # Strip code fences if present
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.MULTILINE).strip()
    try:
        plan = json.loads(text)
    except json.JSONDecodeError:
        # Fallback: single worker with the raw question
        return [{"task": user_q, "focus": "general"}]
    if not isinstance(plan, list) or not plan:
        return [{"task": user_q, "focus": "general"}]
    return plan[:5]


def _stream_merge(client: anthropic.Anthropic, user_q: str,
                  worker_findings: list[dict]) -> Iterator[str]:
    """Stream the merged final answer, token by token."""
    findings_block = "\n\n".join(
        f"<worker id=\"{i}\" focus=\"{w['focus']}\">\n{w['findings']}\n</worker>"
        for i, w in enumerate(worker_findings)
    )

    merge_prompt = f"""\
<user_question>{user_q}</user_question>

<worker_findings>
{findings_block}
</worker_findings>

Synthesize the findings into ONE reply for the user.
Follow the synthesis_rules exactly. Preserve every [source_id] citation.
Start with the answer — no preamble, no restatement, no wrap-up.
"""

    with client.messages.stream(
        model=MERGE_MODEL,
        max_tokens=2500,
        system=prompts.ORCHESTRATOR_SYSTEM,
        messages=[{"role": "user", "content": merge_prompt}],
    ) as stream:
        for text in stream.text_stream:
            yield text


def run_turn(user_q: str) -> Iterator[dict]:
    """Execute one orchestrator turn end-to-end. Yields SSE-shaped events."""
    client = anthropic.Anthropic()

    # Load persistent state
    cs = context_store.ContextStore(CTX_PATH)
    cs.begin_turn()
    turn_no = cs.turn
    history = _load_history(n_last=6)
    business = _load_business()
    hot_block = cs.render_hot_block()

    yield {"type": "status", "message": f"turn {turn_no} · {cs.size()} sources warm"}

    # 1. Plan
    try:
        plan = _plan_workers(client, user_q, history, business, hot_block)
    except Exception as e:
        yield {"type": "error", "message": f"planning failed: {e}"}
        return

    yield {"type": "plan", "workers": [{"focus": p["focus"], "task": p["task"][:180]} for p in plan]}

    # 2. Dispatch workers in parallel
    def _run(i: int, p: dict) -> tuple[int, worker.WorkerResult]:
        return i, worker.run_worker(p["task"], p["focus"], hot_block)

    worker_findings: list[dict | None] = [None] * len(plan)
    with ThreadPoolExecutor(max_workers=min(5, len(plan))) as ex:
        futures = [ex.submit(_run, i, p) for i, p in enumerate(plan)]
        for fut in as_completed(futures):
            i, res = fut.result()
            worker_findings[i] = {
                "focus": plan[i]["focus"],
                "findings": res.findings,
                "sources": res.sources_used,
                "error": res.error,
            }
            for s in res.sources_used:
                cs.record_hit(
                    s["source_id"],
                    source_name=s.get("source_name",""),
                    source_title=s.get("source_title",""),
                    source_url=s.get("source_url",""),
                    section_title=s.get("section_title",""),
                    kind=s.get("kind","chunk"),
                    full_text=s.get("full_text",""),
                    breadcrumb=(s.get("full_text","") or "")[:200],
                )
            yield {"type": "worker_done", "id": i, "focus": plan[i]["focus"],
                   "findings_preview": (res.findings or "")[:400],
                   "n_sources": len(res.sources_used),
                   "error": res.error}

    findings = [wf for wf in worker_findings if wf is not None]

    # 3. Stream the merged synthesis
    full_answer = []
    try:
        for chunk in _stream_merge(client, user_q, findings):
            full_answer.append(chunk)
            yield {"type": "token", "text": chunk}
    except Exception as e:
        yield {"type": "error", "message": f"merge streaming failed: {e}"}
        return

    # 4. Emit unique source list for the UI
    seen = set()
    all_sources = []
    for wf in findings:
        for s in wf["sources"]:
            sid = s["source_id"]
            if sid in seen:
                continue
            seen.add(sid)
            all_sources.append({
                "source_id": sid,
                "source_name": s.get("source_name",""),
                "source_title": s.get("source_title",""),
                "source_url": s.get("source_url",""),
                "snippet": (s.get("full_text","") or "")[:400],
            })
    yield {"type": "sources", "sources": all_sources}

    # 5. Persist
    _append_history({
        "turn": turn_no, "role": "user", "content": user_q,
    })
    _append_history({
        "turn": turn_no, "role": "assistant",
        "content": "".join(full_answer),
        "plan": [{"focus": p["focus"], "task": p["task"]} for p in plan],
        "workers": [{"focus": wf["focus"], "n_sources": len(wf["sources"]),
                     "error": wf["error"]} for wf in findings],
        "source_ids": list(seen),
    })
    cs.end_turn()

    yield {"type": "done"}
