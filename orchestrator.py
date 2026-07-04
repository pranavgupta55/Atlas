"""Atlas orchestrator: user Q → planner → parallel workers → merged answer.

Yields SSE events as it runs, richly enough for the Flow view to render
per-tool_use nodes + per-call cost + retries.
"""

from __future__ import annotations

import json
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Iterator

import anthropic

import config
import context_store
import costs
import prompts
import retry
import worker

ROOT = Path(__file__).parent
DATA_DIR = ROOT / "data"
CTX_PATH      = DATA_DIR / "context.jsonl"
HISTORY_PATH  = DATA_DIR / "history.jsonl"
COSTS_PATH    = DATA_DIR / "costs.jsonl"
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
                  history: list[dict], business: str, hot_block: str,
                  turn_cost: costs.TurnCost) -> list[dict]:
    """Opus planning call. Returns [{task, focus}, ...] with 1-5 entries."""
    history_str = "\n".join(
        f"[turn {h.get('turn','?')}] {h.get('role','?')}: {str(h.get('content',''))[:200]}"
        for h in history
    ) or "(no prior turns)"

    planning_prompt = f"""\
<user_question>{user_q}</user_question>

<recent_history>
{history_str}
</recent_history>

<business_plan>
{business[:3000]}
</business_plan>

{hot_block}

Decompose per orchestrator rules. {prompts.PLAN_JSON_SCHEMA}
"""

    orch_model, _, _ = config.models()

    def _create():
        return client.messages.create(
            model=orch_model,
            max_tokens=1200,
            system=prompts.ORCHESTRATOR_SYSTEM,
            messages=[{"role": "user", "content": planning_prompt}],
        )
    resp = retry.with_retry(_create, max_attempts=3, base_delay=1.5)
    in_t, out_t = costs.usage_from_response(resp)
    turn_cost.add_call("plan", orch_model, in_t, out_t, label="orchestrator plan")

    text = "".join(b.text for b in resp.content if getattr(b, "type", None) == "text").strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.MULTILINE).strip()
    try:
        plan = json.loads(text)
    except json.JSONDecodeError:
        return [{"task": user_q, "focus": "general"}]
    if not isinstance(plan, list) or not plan:
        return [{"task": user_q, "focus": "general"}]
    return plan[:5]


def _stream_merge(client: anthropic.Anthropic, user_q: str,
                  worker_findings: list[dict],
                  turn_cost: costs.TurnCost) -> Iterator[str]:
    findings_block = "\n\n".join(
        f'<worker id="{i}" focus="{w["focus"]}">\n{w["findings"]}\n</worker>'
        for i, w in enumerate(worker_findings)
    )

    merge_prompt = f"""\
<user_question>{user_q}</user_question>

<worker_findings>
{findings_block}
</worker_findings>

Synthesize per the synthesis_rules. Preserve every [source_id] citation.
Start with the answer — no preamble, no restatement, no wrap-up.
"""

    _, _, merge_model = config.models()

    def _open():
        return client.messages.stream(
            model=merge_model,
            max_tokens=2500,
            system=prompts.ORCHESTRATOR_SYSTEM,
            messages=[{"role": "user", "content": merge_prompt}],
        )
    stream = retry.with_retry(_open, max_attempts=3, base_delay=1.5)
    with stream as s:
        for text in s.text_stream:
            yield text
        final = s.get_final_message()
        in_t, out_t = costs.usage_from_response(final)
        turn_cost.add_call("merge", merge_model, in_t, out_t, label="merger")


def run_turn(user_q: str) -> Iterator[dict]:
    """One end-to-end turn. Yields dict events for SSE."""
    client = anthropic.Anthropic()

    cs = context_store.ContextStore(CTX_PATH)
    session_costs = costs.SessionCosts(COSTS_PATH)

    # Budget cap
    ok, why = costs.check_cap(session_costs.session_total, session_costs.today_dollars())
    if not ok:
        yield {"type": "error",
               "message": f"budget cap reached — {why}. "
                          f"Bump ATLAS_SESSION_CAP or ATLAS_DAILY_CAP in .env to continue."}
        yield {"type": "done"}
        return

    cs.begin_turn()
    turn_no = cs.turn
    turn_cost = costs.TurnCost(turn=turn_no)
    history = _load_history(n_last=6)
    business = _load_business()
    hot_block = cs.render_hot_block()

    yield {"type": "turn_start", "turn": turn_no, "sources_warm": cs.size(),
           "session_dollars": round(session_costs.session_total, 4)}

    # 1. Plan
    try:
        plan = _plan_workers(client, user_q, history, business, hot_block, turn_cost)
    except Exception as e:
        yield {"type": "error", "message": f"planning failed: {e}"}
        return
    yield {"type": "plan", "workers": [
        {"id": i, "focus": p["focus"], "task": p["task"][:220]} for i, p in enumerate(plan)]}
    yield {"type": "cost_update", "role": "plan", "dollars": round(turn_cost.calls[-1].dollars, 4),
           "input_tokens": turn_cost.calls[-1].input_tokens,
           "output_tokens": turn_cost.calls[-1].output_tokens,
           "turn_total": round(turn_cost.total_dollars, 4)}

    # 2. Dispatch workers in parallel
    events_queue: list[dict] = []
    events_lock_ok = True  # single-writer thread pool; python GIL makes appends safe

    def _emit_from_worker(ev: dict):
        events_queue.append(ev)

    def _run(i: int, p: dict):
        return i, worker.run_worker(p["task"], p["focus"], hot_block, i, _emit_from_worker)

    worker_findings: list[dict | None] = [None] * len(plan)
    with ThreadPoolExecutor(max_workers=min(5, len(plan))) as ex:
        futures = [ex.submit(_run, i, p) for i, p in enumerate(plan)]
        completed = 0
        for fut in as_completed(futures):
            # Drain any events queued by workers so far, in order
            while events_queue:
                yield events_queue.pop(0)
            i, res = fut.result()
            worker_findings[i] = {
                "focus": plan[i]["focus"],
                "findings": res.findings,
                "sources": res.sources_used,
                "tool_calls": res.tool_calls,
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
            turn_cost.add_call("worker", res.model or config.models()[1],
                               res.input_tokens, res.output_tokens,
                               label=f"worker#{i}: {plan[i]['focus']}")
            if res.web_searches:
                turn_cost.add_web_search(res.web_searches)
            completed += 1
            yield {"type": "worker_done", "id": i, "focus": plan[i]["focus"],
                   "n_sources": len(res.sources_used), "n_tool_calls": len(res.tool_calls),
                   "web_searches": res.web_searches,
                   "input_tokens": res.input_tokens, "output_tokens": res.output_tokens,
                   "error": res.error, "findings_preview": (res.findings or "")[:300]}
            yield {"type": "cost_update", "role": "worker",
                   "dollars": round(turn_cost.calls[-1].dollars, 4),
                   "input_tokens": res.input_tokens, "output_tokens": res.output_tokens,
                   "worker_id": i,
                   "turn_total": round(turn_cost.total_dollars, 4)}
            # Also flush any events that came in while we were processing
            while events_queue:
                yield events_queue.pop(0)

    findings = [wf for wf in worker_findings if wf is not None]

    # 3. Stream the merged synthesis
    full_answer_parts: list[str] = []
    yield {"type": "merge_start"}
    try:
        for chunk in _stream_merge(client, user_q, findings, turn_cost):
            full_answer_parts.append(chunk)
            yield {"type": "token", "text": chunk}
    except Exception as e:
        yield {"type": "error", "message": f"merge streaming failed: {e}"}
        return
    yield {"type": "cost_update", "role": "merge",
           "dollars": round(turn_cost.calls[-1].dollars, 4),
           "input_tokens": turn_cost.calls[-1].input_tokens,
           "output_tokens": turn_cost.calls[-1].output_tokens,
           "turn_total": round(turn_cost.total_dollars, 4)}

    # 4. Unique source list — enrich with score/hits from context store (post-hit-update, pre-decay)
    seen = set()
    all_sources = []
    for wf in findings:
        for s in wf["sources"]:
            sid = s["source_id"]
            if sid in seen:
                continue
            seen.add(sid)
            entry = cs._entries.get(sid)
            all_sources.append({
                "source_id": sid,
                "source_name": s.get("source_name",""),
                "source_title": s.get("source_title",""),
                "source_url": s.get("source_url",""),
                "snippet": (s.get("full_text","") or "")[:400],
                "score": round(entry.score, 2) if entry else 0.0,
                "hits_total": entry.hits_total if entry else 1,
            })
    all_sources.sort(key=lambda r: (-r["score"], -r["hits_total"]))
    yield {"type": "sources", "sources": all_sources}

    # 5. Persist
    _append_history({"turn": turn_no, "role": "user", "content": user_q})
    full_answer = "".join(full_answer_parts)
    _append_history({
        "turn": turn_no, "role": "assistant", "content": full_answer,
        "plan": [{"focus": p["focus"], "task": p["task"]} for p in plan],
        "workers": [{"focus": wf["focus"], "n_sources": len(wf["sources"]),
                     "tool_calls": wf["tool_calls"],
                     "error": wf["error"]} for wf in findings],
        "source_ids": list(seen),
        "sources_meta": [{"source_id": s["source_id"],
                          "source_title": s.get("source_title",""),
                          "source_url": s.get("source_url",""),
                          "score_after": s.get("score", 0),
                          "hits_total": s.get("hits_total", 1)} for s in all_sources],
        "cost_dollars": round(turn_cost.total_dollars, 4),
    })
    session_costs.append(turn_cost)
    cs.end_turn()

    yield {"type": "turn_done",
           "turn": turn_no,
           "turn_dollars": round(turn_cost.total_dollars, 4),
           "session_dollars": round(session_costs.session_total, 4),
           "today_dollars": round(session_costs.today_dollars(), 4),
           "n_sources": len(all_sources),
           "sources_warm_after": cs.size()}
    yield {"type": "done"}


# ── Slash commands ─────────────────────────────────────────────────────────

def cmd_sources() -> str:
    cs = context_store.ContextStore(CTX_PATH)
    top = cs.warm()[:20]
    if not top:
        return "_(warm tier is empty)_"
    lines = ["| score | last | source_id | title |", "|---|---|---|---|"]
    for e in top:
        lines.append(f"| {e.score:.2f} | t{e.last_turn} | `{e.source_id}` | {e.source_title or e.source_name} |")
    return "\n".join(lines)


def cmd_cost() -> str:
    sc = costs.SessionCosts(COSTS_PATH)
    if not sc.turns:
        return "_(no turns yet this session)_"
    lines = ["| turn | dollars |", "|---|---|"]
    for t in sc.turns:
        lines.append(f"| {t.get('turn','?')} | ${t.get('total_dollars', 0):.4f} |")
    lines.append(f"| **session total** | **${sc.session_total:.4f}** |")
    lines.append(f"| today | ${sc.today_dollars():.4f} |")
    return "\n".join(lines)


def cmd_reset() -> str:
    """Clear conversation + context, keep business.md + costs history."""
    if HISTORY_PATH.exists():
        HISTORY_PATH.unlink()
    if CTX_PATH.exists():
        CTX_PATH.unlink()
    return "Reset done — history + context cleared. business.md and cost log preserved."


def cmd_distill() -> Iterator[dict]:
    """Scan history + current business.md, ask Claude to propose a new business.md.

    Yields SSE events. Does NOT auto-write — server exposes /api/business POST for approval.
    """
    client = anthropic.Anthropic()
    history = _load_history(n_last=100)
    business = _load_business()

    history_dump = "\n\n".join(
        f"[turn {h.get('turn','?')} · {h.get('role','?')}]\n{h.get('content','')[:2500]}"
        for h in history
    ) or "(no history yet)"

    user_prompt = f"""\
<current_business_md>
{business}
</current_business_md>

<conversation_history>
{history_dump}
</conversation_history>

Propose the new business.md per the archivist rules. Output the full markdown only.
"""

    yield {"type": "distill_start"}

    _, _, merge_model = config.models()

    def _open():
        return client.messages.stream(
            model=merge_model,
            max_tokens=4000,
            system=prompts.DISTILL_SYSTEM,
            messages=[{"role": "user", "content": user_prompt}],
        )
    try:
        stream = retry.with_retry(_open, max_attempts=3, base_delay=1.5)
    except Exception as e:
        yield {"type": "error", "message": f"distill failed: {e}"}
        yield {"type": "done"}
        return

    proposed = []
    with stream as s:
        for text in s.text_stream:
            proposed.append(text)
            yield {"type": "distill_token", "text": text}
    proposed_md = "".join(proposed)
    yield {"type": "distill_done", "proposed": proposed_md, "current": business}
    yield {"type": "done"}
