// Flow view — stacked per-turn DAG cards in the right column. No source cloud.
// Each card shows: user Q → orchestrator → N workers → per-worker recursive tool loops → merger.

(function() {
  const stackEl = document.getElementById("flow-stack");
  const slideover = document.getElementById("detail-slideover");
  const detailTitle = document.getElementById("detail-title");
  const detailBody = document.getElementById("detail-body");
  const closeBtn = document.getElementById("detail-close");
  const svgNS = "http://www.w3.org/2000/svg";
  const xhtmlNS = "http://www.w3.org/1999/xhtml";

  // Loaded once + refreshed when the live turn completes; live turn appended as a special entry.
  let historyTurns = [];   // completed turns (oldest → newest)
  let selectedKey = null;

  function svgEl(name, attrs) {
    const e = document.createElementNS(svgNS, name);
    if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  function escapeHtml(s) {
    return String(s || "").replace(/[&<>"']/g, c =>
      ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"}[c]));
  }

  // ── Build a turn-shaped object from a persisted history entry pair ────
  function turnFromHistory(u, a) {
    const workers = (a?.workers || []).map((w, i) => {
      const tool_calls = (w.tool_calls || []).map((tc, j) => ({
        call_id: tc.call_id || `w${i}.t${j+1}`,
        tool: tc.tool || "scribe_retrieve",
        sub_queries: tc.sub_queries || [],
        query: tc.query || "",
        status: "done",
        n_chunks: tc.n_chunks || 0,
        n_facts: tc.n_facts || 0,
        sources: (tc.source_ids || []).map(sid => ({ source_id: sid })),
        elapsed_ms: tc.elapsed_ms || 0,
      }));
      const plan = (a.plan || [])[i] || {};
      return {
        id: i, focus: w.focus || plan.focus || `worker ${i}`,
        task: plan.task || "",
        status: w.error ? "error" : "done",
        tool_calls, error: w.error || null,
        findings_preview: "", input_tokens: 0, output_tokens: 0,
      };
    });
    return {
      no: a?.turn ?? u?.turn ?? null,
      user_q: u?.content || "",
      workers,
      cost: { calls: [], total: a?.cost_dollars || 0 },
      merger_active: true, done: true,
      answer_text: a?.content || "",
      sources: (a?.source_ids || []).map(sid => ({ source_id: sid })),
      is_live: false,
    };
  }

  async function fetchHistory() {
    try {
      const d = await (await fetch("/api/history?n=200")).json();
      const rows = d.turns || [];
      const byTurn = {};
      rows.forEach(r => {
        if (!byTurn[r.turn]) byTurn[r.turn] = {};
        byTurn[r.turn][r.role] = r;
      });
      const turnNos = Object.keys(byTurn).map(n => parseInt(n, 10)).sort((a,b)=>a-b);
      historyTurns = turnNos
        .filter(n => byTurn[n].assistant)
        .map(n => turnFromHistory(byTurn[n].user, byTurn[n].assistant));
    } catch (e) { console.error("fetchHistory", e); }
    renderStack();
  }

  function workerSourceCount(w) {
    const seen = new Set();
    for (const tc of (w.tool_calls || [])) {
      for (const s of (tc.sources || [])) {
        if (s.source_id) seen.add(s.source_id);
      }
    }
    return seen.size;
  }

  // ── Render one turn's DAG into an SVG element (returns the <svg>) ─────
  function renderTurnSVG(t, cardEl) {
    // Dimensions — width fills the card; height computed from tool-loop depth
    const width = Math.max(360, cardEl.clientWidth - 20);
    const nWorkers = Math.max(t.workers.length, 1);
    const maxIters = t.workers.reduce((m, w) => Math.max(m, (w.tool_calls || []).length), 0);

    const USER_H = 44, ORCH_H = 36, WORKER_H = 44, ITER_H = 30, MERGE_H = 40;
    const GAP_Y = 12;
    const userY = 6;
    const orchY = userY + USER_H + GAP_Y;
    const workerY = orchY + ORCH_H + GAP_Y;
    const iterYStart = workerY + WORKER_H + GAP_Y;
    const iterBlockH = maxIters > 0 ? maxIters * (ITER_H + 6) - 6 : 0;
    const mergerY = iterYStart + iterBlockH + (maxIters > 0 ? GAP_Y : 0);
    const height = mergerY + MERGE_H + 8;

    const midX = width / 2;
    const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, xmlns: svgNS });
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", height);
    svg.classList.add("turn-card-svg");

    // Layout worker columns
    const workerW = Math.max(120, Math.min(220, Math.floor((width - 40 - (nWorkers - 1) * 12) / nWorkers)));
    const totalRowW = nWorkers * workerW + (nWorkers - 1) * 12;
    const rowStartX = (width - totalRowW) / 2;

    const nodes = [];  // {key, x, y, w, h, label, sub, statusClass, kind, data}

    // User Q node
    nodes.push({
      key: `t${t.no}.user`,
      x: 12, y: userY, w: width - 24, h: USER_H,
      label: t.user_q || "",
      sub: "user question",
      statusClass: "done", kind: "user",
      data: { type: "user_q", text: t.user_q, turn: t.no },
    });
    // Orchestrator
    nodes.push({
      key: `t${t.no}.orch`,
      x: midX - 90, y: orchY, w: 180, h: ORCH_H,
      label: "orchestrator",
      sub: `plan · ${t.workers.length} worker${t.workers.length===1?"":"s"}`,
      statusClass: t.workers.length ? "done" : "working", kind: "orch",
      data: { type: "orchestrator", plan: t.workers, turn: t.no },
    });

    // Workers
    t.workers.forEach((w, i) => {
      const x = rowStartX + i * (workerW + 12);
      let statusClass = w.status;
      if (statusClass === "planned") statusClass = "working";
      const nSources = workerSourceCount(w);
      nodes.push({
        key: `t${t.no}.w${i}`,
        x, y: workerY, w: workerW, h: WORKER_H,
        label: w.focus,
        sub: w.status === "done" ? `${w.tool_calls.length} calls · ${nSources} src` :
             w.status === "error" ? "error" :
             w.status === "retrying" ? (w.retry_msg || "retrying…") :
             w.status === "working" ? "working…" : "planned",
        statusClass, kind: "worker",
        data: { type: "worker", worker: w, id: i, turn: t.no },
      });

      // Tool_call iteration nodes stacked in this worker's column
      const iterW = Math.min(workerW - 8, 150);
      const iterX = x + (workerW - iterW) / 2;
      w.tool_calls.forEach((tc, j) => {
        const isWeb = tc.tool === "web_search";
        const y = iterYStart + j * (ITER_H + 6);
        const label = isWeb ? "web search" : "retrieve";
        const sub = isWeb ?
          (tc.status === "done" ? `${tc.n_chunks + tc.n_facts || "?"} src` : "…searching") :
          (tc.status === "done" ? `${tc.n_chunks + tc.n_facts} src · ${tc.elapsed_ms||0}ms` : "…fetching");
        nodes.push({
          key: `t${t.no}.w${i}.t${tc.call_id}`,
          x: iterX, y, w: iterW, h: ITER_H,
          label, sub,
          statusClass: tc.status === "done" ? "done" : "working",
          kind: isWeb ? "web" : "tool",
          data: { type: "tool_call", tool_call: tc, worker_id: i, worker_focus: w.focus, iter: j+1, turn: t.no },
        });
      });
    });

    // Merger
    if (t.merger_active || t.done) {
      nodes.push({
        key: `t${t.no}.merger`,
        x: midX - 90, y: mergerY, w: 180, h: MERGE_H,
        label: "merger",
        sub: t.done ? `${(t.sources || []).length} sources cited` : "streaming…",
        statusClass: t.done ? "done" : "working", kind: "merger",
        data: { type: "merger", answer: t.answer_text, sources: t.sources || [], turn: t.no },
      });
    }

    // ── Edges ─────
    function edge(a, b, cls) {
      const ax = a.x + a.w / 2, ay = a.y + a.h;
      const bx = b.x + b.w / 2, by = b.y;
      const midY = (ay + by) / 2;
      const path = svgEl("path", {
        d: `M ${ax} ${ay} C ${ax} ${midY}, ${bx} ${midY}, ${bx} ${by}`,
        class: `dag-edge ${cls || ""}`,
      });
      svg.appendChild(path);
    }
    // Backward loop edge (tool → worker, curved on side)
    function loopEdge(tool, worker) {
      const tx = tool.x + tool.w, ty = tool.y + tool.h / 2;
      const wx = worker.x + worker.w, wy = worker.y + worker.h / 2;
      const bx = Math.max(tx, wx) + 18;
      const path = svgEl("path", {
        d: `M ${tx} ${ty} C ${bx} ${ty}, ${bx} ${wy}, ${wx} ${wy}`,
        class: "dag-edge iter-loop",
      });
      svg.appendChild(path);
    }
    function nodeByKey(k) { return nodes.find(n => n.key === k); }

    const userN = nodeByKey(`t${t.no}.user`);
    const orchN = nodeByKey(`t${t.no}.orch`);
    if (userN && orchN) edge(userN, orchN, orchN.statusClass === "working" ? "active" : "done");

    const mergerN = nodeByKey(`t${t.no}.merger`);
    t.workers.forEach((w, i) => {
      const wN = nodeByKey(`t${t.no}.w${i}`);
      if (orchN && wN) edge(orchN, wN, wN.statusClass === "working" ? "active" : "done");
      // worker → its tool_call iterations (down-arrow) + loop edge back
      w.tool_calls.forEach((tc, j) => {
        const tN = nodeByKey(`t${t.no}.w${i}.t${tc.call_id}`);
        if (!tN) return;
        if (j === 0) {
          edge(wN, tN, tc.status !== "done" ? "active" : "done");
        } else {
          const prev = nodeByKey(`t${t.no}.w${i}.t${w.tool_calls[j-1].call_id}`);
          if (prev) edge(prev, tN, tc.status !== "done" ? "active" : "done");
        }
        // Loop-back edge from THIS tool call to the worker
        if (wN && tN) loopEdge(tN, wN);
      });
      // Each worker's LAST tool → merger (or worker directly → merger if no tools)
      if (mergerN) {
        const lastTool = w.tool_calls.length ? nodeByKey(`t${t.no}.w${i}.t${w.tool_calls[w.tool_calls.length-1].call_id}`) : null;
        const from = lastTool || wN;
        if (from) edge(from, mergerN, mergerN.statusClass === "working" ? "active" : lastTool ? "tool-out" : "done");
      }
    });

    // ── Nodes (with foreignObject for real text wrap) ─────
    nodes.forEach(n => {
      const g = svgEl("g", {
        class: `dag-node ${n.kind} ${n.statusClass}${selectedKey === n.key ? " selected" : ""}`,
      });
      g.appendChild(svgEl("rect", { x: n.x, y: n.y, width: n.w, height: n.h, rx: 0, class: "dag-shape" }));
      const fo = svgEl("foreignObject", { x: n.x, y: n.y, width: n.w, height: n.h });
      const div = document.createElementNS(xhtmlNS, "div");
      div.setAttribute("class", "node-fo");
      const labelDiv = document.createElementNS(xhtmlNS, "div");
      labelDiv.setAttribute("class", "node-label");
      labelDiv.textContent = n.label;
      div.appendChild(labelDiv);
      if (n.sub) {
        const subDiv = document.createElementNS(xhtmlNS, "div");
        subDiv.setAttribute("class", "node-sub");
        subDiv.textContent = n.sub;
        div.appendChild(subDiv);
      }
      fo.appendChild(div);
      g.appendChild(fo);
      g.addEventListener("click", () => {
        selectedKey = n.key;
        showDetail(n);
        renderStack();
      });
      svg.appendChild(g);
    });

    return svg;
  }

  // ── Render the vertical stack of turn cards ──────────────────────────
  function renderStack() {
    stackEl.innerHTML = "";
    // Merge history + live turn (if in-flight and not already in history)
    const cards = historyTurns.slice();
    const live = Atlas.state.turn;
    const liveInHistory = live.no && cards.some(c => c.no === live.no);
    if (live.no && !liveInHistory) {
      cards.push({ ...live, is_live: true });
    } else if (live.no && liveInHistory && !live.done) {
      // In-flight update: replace the existing card with live snapshot
      const idx = cards.findIndex(c => c.no === live.no);
      if (idx >= 0) cards[idx] = { ...live, is_live: true };
    }
    // Newest at bottom (matches chat scroll)
    cards.forEach(t => stackEl.appendChild(buildCard(t)));
    // Scroll to bottom (latest turn)
    requestAnimationFrame(() => { stackEl.scrollTop = stackEl.scrollHeight; });
  }

  function buildCard(t) {
    const card = document.createElement("div");
    card.className = "turn-card";
    if (t.is_live) card.classList.add("live");
    // Head
    const head = document.createElement("div");
    head.className = "turn-card-head";
    const title = document.createElement("div");
    title.className = "turn-title";
    title.innerHTML = `Turn <span class="turn-num">${t.no}</span>`;
    head.appendChild(title);
    const meta = document.createElement("div");
    meta.className = "turn-meta";
    if (t.is_live) {
      const live = document.createElement("span");
      live.className = "live-badge";
      live.textContent = "LIVE";
      meta.appendChild(live);
    }
    if (t.cost && (t.cost.total || 0) > 0) {
      const cost = document.createElement("span");
      cost.className = "turn-cost";
      cost.textContent = `$${(t.cost.total || 0).toFixed(4)}`;
      meta.appendChild(cost);
    }
    head.appendChild(meta);
    card.appendChild(head);
    // SVG — deferred so clientWidth is available
    requestAnimationFrame(() => {
      const svg = renderTurnSVG(t, card);
      card.appendChild(svg);
    });
    return card;
  }

  // ── Detail slide-over ────────────────────────────────────────────────
  function showDetail(node) {
    const d = node.data;
    detailTitle.textContent = d.type.replace("_", " ");
    let html = "";
    if (d.type === "user_q") {
      html = `<div class="kv"><span class="k">turn</span>${d.turn}</div>`;
      html += `<h3>User question</h3><pre>${escapeHtml(d.text || "")}</pre>`;
    } else if (d.type === "orchestrator") {
      html = `<div class="kv"><span class="k">turn</span>${d.turn}</div>`;
      html += `<h3>Plan (${d.plan.length} workers)</h3>`;
      if (!d.plan.length) html += `<p class="dim">no plan yet</p>`;
      else {
        html += `<ol style="padding-left:20px; font-size:12px">`;
        d.plan.forEach(w => {
          html += `<li style="margin-bottom:8px"><strong>${escapeHtml(w.focus)}</strong><br><em class="dim">${escapeHtml(w.task || "")}</em></li>`;
        });
        html += `</ol>`;
      }
    } else if (d.type === "worker") {
      const w = d.worker;
      html = `<div class="kv"><span class="k">turn</span>${d.turn}</div>`;
      html += `<div class="kv"><span class="k">focus</span>${escapeHtml(w.focus)}</div>`;
      html += `<div class="kv"><span class="k">status</span>${w.status}${w.error ? " ("+escapeHtml(w.error)+")":""}</div>`;
      html += `<div class="kv"><span class="k">tokens</span>${w.input_tokens} in / ${w.output_tokens} out</div>`;
      html += `<div class="kv"><span class="k">sources</span>${workerSourceCount(w)}</div>`;
      html += `<h3>Task assigned</h3><pre>${escapeHtml(w.task || "(no task detail)")}</pre>`;
      html += `<h3>Tool calls (${w.tool_calls.length})</h3>`;
      if (!w.tool_calls.length) html += `<p class="dim">none yet</p>`;
      else {
        w.tool_calls.forEach((tc, i) => {
          html += `<div class="kv"><span class="k">${i+1}. ${tc.tool}</span>${tc.n_chunks} chunks + ${tc.n_facts} facts · ${tc.elapsed_ms||0}ms</div>`;
          if (tc.sub_queries && tc.sub_queries.length) {
            html += `<ul class="subquery-list">${tc.sub_queries.map(q => `<li>${escapeHtml(q)}</li>`).join("")}</ul>`;
          }
        });
      }
      html += `<h3>Findings preview</h3><pre>${escapeHtml(w.findings_preview || "(streaming or not returned)")}</pre>`;
    } else if (d.type === "tool_call") {
      const tc = d.tool_call;
      html = `<div class="kv"><span class="k">turn</span>${d.turn}</div>`;
      html += `<div class="kv"><span class="k">iteration</span>#${d.iter}</div>`;
      html += `<div class="kv"><span class="k">tool</span>${tc.tool}</div>`;
      html += `<div class="kv"><span class="k">worker</span>#${d.worker_id} · ${escapeHtml(d.worker_focus || "")}</div>`;
      html += `<div class="kv"><span class="k">status</span>${tc.status}${tc.elapsed_ms ? ` · ${tc.elapsed_ms}ms` : ""}</div>`;
      html += `<div class="kv"><span class="k">returned</span>${tc.n_chunks} chunks · ${tc.n_facts} facts</div>`;
      if (tc.tool === "web_search" && tc.query) {
        html += `<h3>Query</h3><pre>${escapeHtml(tc.query)}</pre>`;
      } else if (tc.sub_queries && tc.sub_queries.length) {
        html += `<h3>Sub-queries sent</h3><ul class="subquery-list">${tc.sub_queries.map(q => `<li>${escapeHtml(q)}</li>`).join("")}</ul>`;
      }
      html += `<h3>Sources returned</h3>`;
      if (!tc.sources.length) html += `<p class="dim">none</p>`;
      else {
        html += `<ul class="node-list">`;
        tc.sources.forEach(s => {
          const title = s.source_title || s.source_id;
          if (s.source_url) {
            html += `<li><a href="${escapeHtml(s.source_url)}" target="_blank">${escapeHtml(title)}</a></li>`;
          } else {
            html += `<li>${escapeHtml(title)}</li>`;
          }
        });
        html += `</ul>`;
      }
    } else if (d.type === "merger") {
      html = `<div class="kv"><span class="k">turn</span>${d.turn}</div>`;
      html += `<div class="kv"><span class="k">sources</span>${(d.sources || []).length} cited</div>`;
      html += `<h3>Merged answer</h3><pre>${escapeHtml((d.answer || "").slice(0, 6000))}${(d.answer||"").length > 6000 ? "\n\n… (truncated)" : ""}</pre>`;
      if (d.sources && d.sources.length) {
        html += `<h3>Cited source ids</h3><ul class="node-list">`;
        d.sources.forEach(s => { html += `<li>${escapeHtml(s.source_id || "")}</li>`; });
        html += `</ul>`;
      }
    }
    detailBody.innerHTML = html;
    slideover.dataset.open = "true";
  }
  closeBtn.addEventListener("click", () => {
    slideover.dataset.open = "false";
    selectedKey = null;
    renderStack();
  });

  // ── Cost panel rendering ─────────────────────────────────────────────
  function renderCost() {
    const t = Atlas.state.turn;
    document.getElementById("cost-turn").textContent = `$${(t.cost.total || 0).toFixed(4)}`;
    document.getElementById("cost-session").textContent = `$${(Atlas.state.session.dollars || 0).toFixed(4)}`;
    document.getElementById("cost-today").textContent = `$${(Atlas.state.session.today_dollars || 0).toFixed(4)}`;
    const cb = document.getElementById("cost-breakdown");
    if (!t.cost.calls.length) {
      cb.innerHTML = `<span class="dim">no calls yet this turn</span>`;
      return;
    }
    cb.innerHTML = t.cost.calls.map(c => {
      const label = c.role === "plan" ? "plan" :
                    c.role === "merge" ? "merge" :
                    c.worker_id !== undefined ? `w${c.worker_id}` : "call";
      return `<div class="call-row ${c.role}">
        <span class="role">${escapeHtml(label)}</span>
        <span>${c.input_tokens || 0} in / ${c.output_tokens || 0} out</span>
        <span>$${(c.dollars || 0).toFixed(4)}</span>
      </div>`;
    }).join("");
  }

  // ── Event handlers ───────────────────────────────────────────────────
  Atlas.on("turn_event", ev => {
    renderStack();
    renderCost();
    if (ev.type === "turn_done") {
      fetchHistory();  // pull the just-completed turn into history
    }
  });
  Atlas.on("turn_reset", () => { renderStack(); renderCost(); });
  Atlas.on("view_change", v => {
    if (v === "main") { renderStack(); renderCost(); }
  });
  window.addEventListener("resize", () => { renderStack(); });

  // Initial
  fetchHistory();
  renderCost();
})();
