// Atlas shared state + view routing + SSE event bus.

window.Atlas = (function() {
  const state = {
    view: "chat",
    session: {
      dollars: 0, today_dollars: 0, sources_warm: 0, history_turns: 0,
      session_cap: 10, daily_cap: 25,
    },
    // Current-turn state (cleared at each turn_start)
    turn: {
      no: null, user_q: "", workers: [],       // [{id, focus, task, tool_calls, sources, error, findings_preview}]
      cost: { calls: [], total: 0 },           // {calls: [{role, model, dollars, ...}], total}
      merger_active: false, done: false,
      answer_text: "",
      sources: [],
    },
    // Persistent source cloud data (last fetched)
    cloud: { nodes: [], edges: [] },
    // Cross-turn history
    history: [],
    listeners: {},                             // event → [fn]
  };

  function on(event, fn) {
    (state.listeners[event] = state.listeners[event] || []).push(fn);
  }
  function emit(event, payload) {
    (state.listeners[event] || []).forEach(fn => {
      try { fn(payload); } catch (e) { console.error(e); }
    });
  }

  // ── View routing ──────────────────────────────────────────────────
  function setView(v) {
    state.view = v;
    document.body.dataset.view = v;
    document.querySelectorAll(".tab").forEach(t => {
      t.classList.toggle("active", t.dataset.view === v);
    });
    emit("view_change", v);
  }
  document.querySelectorAll(".tab").forEach(t => {
    t.addEventListener("click", () => setView(t.dataset.view));
  });

  // ── Status polling + cost pill ────────────────────────────────────
  async function refreshStatus() {
    try {
      const s = await (await fetch("/api/status")).json();
      state.session.dollars = s.session_dollars;
      state.session.today_dollars = s.today_dollars;
      state.session.sources_warm = s.sources_warm;
      state.session.history_turns = s.history_turns;
      state.session.session_cap = s.session_cap;
      state.session.daily_cap = s.daily_cap;
      updateStatusUI();
      emit("status", s);
    } catch (e) {
      document.getElementById("status-pill").textContent = "server unreachable";
    }
  }
  function updateStatusUI() {
    const pill = document.getElementById("cost-pill");
    pill.textContent = `$${(state.session.dollars || 0).toFixed(2)}`;
    const cap = state.session.session_cap;
    const pct = Math.min(1, (state.session.dollars || 0) / cap);
    if (pct > 0.8) pill.style.borderColor = "#ef5a4d";
    else pill.style.borderColor = "";
    document.getElementById("status-pill").textContent =
      `${state.session.sources_warm} warm · ${state.session.history_turns} turns`;
  }
  document.getElementById("cost-pill").addEventListener("click", () => setView("flow"));

  // ── SSE parsing helper ────────────────────────────────────────────
  async function sseFetch(url, body, onEvent) {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = raw.split("\n").find(l => l.startsWith("data: "));
        if (!line) continue;
        try {
          const ev = JSON.parse(line.slice(6));
          onEvent(ev);
          if (ev.type === "done") return;
        } catch (e) { /* skip malformed */ }
      }
    }
  }

  // ── Entry point for a new turn ─────────────────────────────────────
  function newTurnState(user_q) {
    state.turn = {
      no: null, user_q, workers: [],
      cost: { calls: [], total: 0 },
      merger_active: false, done: false,
      answer_text: "", sources: [],
    };
    emit("turn_reset");
  }

  function markTurnEvent(ev) {
    const t = state.turn;
    switch (ev.type) {
      case "turn_start":
        t.no = ev.turn;
        break;
      case "plan":
        t.workers = ev.workers.map(w => ({
          id: w.id, focus: w.focus, task: w.task,
          status: "planned", tool_calls: [], sources: [],
          error: null, findings_preview: "",
          input_tokens: 0, output_tokens: 0,
        }));
        break;
      case "tool_call_start": {
        const w = t.workers[ev.worker_id];
        if (w) {
          w.status = "working";
          w.tool_calls.push({
            call_id: ev.call_id, tool: ev.tool,
            sub_queries: ev.sub_queries || [], query: ev.query || "",
            status: "running", n_chunks: 0, n_facts: 0, sources: [],
            elapsed_ms: 0,
          });
        }
        break;
      }
      case "tool_call_done": {
        const w = t.workers[ev.worker_id];
        if (w) {
          const tc = w.tool_calls.find(x => x.call_id === ev.call_id);
          if (tc) {
            tc.status = "done";
            tc.n_chunks = ev.n_chunks; tc.n_facts = ev.n_facts;
            tc.sources = ev.sources; tc.elapsed_ms = ev.elapsed_ms;
          }
        }
        break;
      }
      case "worker_done": {
        const w = t.workers[ev.id];
        if (w) {
          w.status = ev.error ? "error" : "done";
          w.error = ev.error; w.findings_preview = ev.findings_preview;
          w.input_tokens = ev.input_tokens; w.output_tokens = ev.output_tokens;
        }
        break;
      }
      case "worker_retry": {
        const w = t.workers[ev.worker_id];
        if (w) { w.status = "retrying"; w.retry_msg = `attempt ${ev.attempt}, waiting ${ev.wait}s`; }
        break;
      }
      case "merge_start":
        t.merger_active = true;
        break;
      case "cost_update":
        t.cost.calls.push(ev);
        t.cost.total = ev.turn_total;
        break;
      case "token":
        t.answer_text += ev.text;
        break;
      case "sources":
        t.sources = ev.sources;
        break;
      case "turn_done":
        t.done = true;
        state.session.dollars = ev.session_dollars;
        state.session.today_dollars = ev.today_dollars;
        state.session.sources_warm = ev.sources_warm_after;
        updateStatusUI();
        break;
    }
    emit("turn_event", ev);
  }

  // ── Kick off polling ───────────────────────────────────────────────
  refreshStatus();
  setInterval(refreshStatus, 8000);

  return { state, on, emit, setView, sseFetch, newTurnState, markTurnEvent, refreshStatus };
})();
