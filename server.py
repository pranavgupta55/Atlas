#!/usr/bin/env python3
"""Atlas server.

  GET  /                     → web/index.html
  GET  /web/{file}           → static assets
  POST /api/chat             → SSE stream (a turn from orchestrator.run_turn)
  POST /api/command          → SSE stream for /distill /sources /reset /cost
  GET  /api/business         → current business.md
  POST /api/business         → accept a proposed business.md (from /distill)
  GET  /api/history?n=50     → last N history.jsonl entries
  GET  /api/status           → session cost totals + counts
  GET  /api/source_cloud     → node/edge data for the persistent source cloud
"""

from __future__ import annotations

import json
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import config as atlas_config
import context_store
import costs
import orchestrator

ROOT = Path(__file__).parent
WEB_DIR = ROOT / "web"
DATA_DIR = ROOT / "data"

app = FastAPI(title="Atlas", version="0.2.0")


# ── status ────────────────────────────────────────────────────────────

@app.get("/api/status")
def status():
    sc = costs.SessionCosts(DATA_DIR / "costs.jsonl")
    cfg = atlas_config.get()
    return {
        "ok": True,
        "sources_warm": _size_context(),
        "history_turns": _count_history(),
        "business_present": (DATA_DIR / "business.md").exists(),
        "session_dollars": round(sc.session_total, 4),
        "today_dollars": round(sc.today_dollars(), 4),
        "session_cap": costs.SESSION_CAP_USD,
        "daily_cap": costs.DAILY_CAP_USD,
        "cheap_mode": cfg.get("cheap_mode", False),
        "models": {
            "orch":   atlas_config.models()[0],
            "worker": atlas_config.models()[1],
            "merge":  atlas_config.models()[2],
        },
    }


class ConfigPatch(BaseModel):
    cheap_mode: bool | None = None


@app.get("/api/config")
def config_get():
    return atlas_config.get()


@app.post("/api/config")
def config_set(patch: ConfigPatch):
    p = {k: v for k, v in patch.model_dump().items() if v is not None}
    return atlas_config.set(p)


# ── business.md GET/POST ──────────────────────────────────────────────

@app.get("/api/business")
def business_get():
    p = DATA_DIR / "business.md"
    return JSONResponse({"content": p.read_text() if p.exists() else ""})


class BusinessBody(BaseModel):
    content: str


@app.post("/api/business")
def business_post(body: BusinessBody):
    p = DATA_DIR / "business.md"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(body.content)
    return {"ok": True, "bytes": len(body.content)}


# ── history ───────────────────────────────────────────────────────────

@app.get("/api/history")
def history(n: int = 50):
    p = DATA_DIR / "history.jsonl"
    if not p.exists():
        return JSONResponse({"turns": []})
    lines = p.read_text().splitlines()[-n:]
    turns = []
    for line in lines:
        try:
            turns.append(json.loads(line))
        except Exception:
            pass
    return JSONResponse({"turns": turns})


# ── source cloud (persistent graph for Flow view) ─────────────────────

@app.get("/api/source_cloud")
def source_cloud():
    """Return nodes + edges for the force-directed persistent source graph.

    node = source_id (with score, title, url)
    edge = pair of source_ids co-cited in some assistant turn
    """
    ctx_p = DATA_DIR / "context.jsonl"
    hist_p = DATA_DIR / "history.jsonl"
    cs = context_store.ContextStore(ctx_p)
    nodes = []
    for e in cs.warm():
        nodes.append({
            "id": e.source_id,
            "title": e.source_title or e.source_name,
            "url": e.source_url,
            "score": e.score,
            "last_turn": e.last_turn,
            "hits_total": e.hits_total,
        })

    # Edges from co-citation in assistant turns
    edge_counts: dict[tuple[str, str], int] = {}
    if hist_p.exists():
        for line in hist_p.read_text().splitlines():
            try:
                d = json.loads(line)
            except Exception:
                continue
            if d.get("role") != "assistant":
                continue
            sids = list({sid for sid in d.get("source_ids", []) if sid})
            for i in range(len(sids)):
                for j in range(i+1, len(sids)):
                    a, b = sorted((sids[i], sids[j]))
                    edge_counts[(a, b)] = edge_counts.get((a, b), 0) + 1
    node_ids = {n["id"] for n in nodes}
    edges = [{"source": a, "target": b, "weight": w}
             for (a, b), w in edge_counts.items() if a in node_ids and b in node_ids]

    return JSONResponse({"nodes": nodes, "edges": edges})


# ── chat (main turn) ──────────────────────────────────────────────────

class ChatBody(BaseModel):
    query: str


def _sse_wrap(gen):
    def _stream():
        try:
            for ev in gen:
                yield f"data: {json.dumps(ev)}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'type':'error','message':str(e)})}\n\n"
            yield f"data: {json.dumps({'type':'done'})}\n\n"
    return StreamingResponse(_stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "Connection": "close"})


@app.post("/api/chat")
def chat(body: ChatBody):
    query = body.query.strip()
    if not query:
        return JSONResponse({"error": "Empty query."}, status_code=400)
    return _sse_wrap(orchestrator.run_turn(query))


# ── slash commands ────────────────────────────────────────────────────

class CommandBody(BaseModel):
    name: str


@app.post("/api/command")
def command(body: CommandBody):
    name = body.name.strip().lstrip("/").lower()

    def stream_static(md: str):
        def _one():
            yield {"type": "command_result", "name": name, "markdown": md}
            yield {"type": "done"}
        return _one()

    if name == "sources":
        return _sse_wrap(stream_static(orchestrator.cmd_sources()))
    if name == "cost":
        return _sse_wrap(stream_static(orchestrator.cmd_cost()))
    if name == "reset":
        msg = orchestrator.cmd_reset()
        return _sse_wrap(stream_static(msg))
    if name == "distill":
        return _sse_wrap(orchestrator.cmd_distill())
    return JSONResponse({"error": f"unknown command /{name}"}, status_code=400)


# ── static / index ────────────────────────────────────────────────────

@app.get("/")
def index():
    return FileResponse(WEB_DIR / "index.html")


app.mount("/web", StaticFiles(directory=WEB_DIR), name="web")


# ── helpers ───────────────────────────────────────────────────────────

def _size_context() -> int:
    p = DATA_DIR / "context.jsonl"
    if not p.exists():
        return 0
    return sum(1 for line in p.read_text().splitlines() if line.strip())


def _count_history() -> int:
    p = DATA_DIR / "history.jsonl"
    if not p.exists():
        return 0
    # Only count "user" role entries (= actual turns)
    n = 0
    for line in p.read_text().splitlines():
        if not line.strip():
            continue
        try:
            d = json.loads(line)
            if d.get("role") == "user":
                n += 1
        except Exception:
            pass
    return n


if __name__ == "__main__":
    from dotenv import load_dotenv
    load_dotenv(ROOT / ".env")
    import uvicorn
    DATA_DIR.mkdir(exist_ok=True)
    uvicorn.run(app, host="127.0.0.1", port=8766, log_level="info")
