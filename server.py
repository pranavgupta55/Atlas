#!/usr/bin/env python3
"""Atlas server.

  GET  /                     → web/index.html
  GET  /web/{file}           → static assets
  POST /api/chat             → SSE: streams a turn from orchestrator.run_turn()
  GET  /api/business         → current business.md
  GET  /api/history?n=50     → last N history.jsonl entries
  GET  /api/status           → sanity
"""

from __future__ import annotations

import json
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import orchestrator

ROOT = Path(__file__).parent
WEB_DIR = ROOT / "web"
DATA_DIR = ROOT / "data"

app = FastAPI(title="Atlas", version="0.1.0")


@app.get("/api/status")
def status():
    return {
        "ok": True,
        "sources_warm": _size_context(),
        "history_turns": _count_history(),
        "business_present": (DATA_DIR / "business.md").exists(),
    }


@app.get("/api/business")
def business():
    p = DATA_DIR / "business.md"
    if not p.exists():
        return JSONResponse({"content": ""})
    return JSONResponse({"content": p.read_text()})


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


class ChatBody(BaseModel):
    query: str


@app.post("/api/chat")
def chat(body: ChatBody):
    query = body.query.strip()
    if not query:
        return JSONResponse({"error": "Empty query."}, status_code=400)

    def event_stream():
        try:
            for event in orchestrator.run_turn(query):
                yield f"data: {json.dumps(event)}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'type':'error','message':str(e)})}\n\n"
            yield f"data: {json.dumps({'type':'done'})}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "Connection": "close"})


@app.get("/")
def index():
    return FileResponse(WEB_DIR / "index.html")


app.mount("/web", StaticFiles(directory=WEB_DIR), name="web")


def _size_context() -> int:
    p = DATA_DIR / "context.jsonl"
    if not p.exists():
        return 0
    return sum(1 for line in p.read_text().splitlines() if line.strip())


def _count_history() -> int:
    p = DATA_DIR / "history.jsonl"
    if not p.exists():
        return 0
    return sum(1 for line in p.read_text().splitlines() if line.strip())


if __name__ == "__main__":
    import uvicorn
    DATA_DIR.mkdir(exist_ok=True)
    uvicorn.run(app, host="127.0.0.1", port=8766, log_level="info")
