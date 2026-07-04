// Flow view — single outer box; per-turn cards with translucent dividers.
// Each card: HOT-source spine (left) + portrait DAG (right).
// Cross-turn info flow annotated in divider captions.

(function() {
  const stackEl = document.getElementById("flow-stack");
  const slideover = document.getElementById("detail-slideover");
  const detailTitle = document.getElementById("detail-title");
  const detailBody = document.getElementById("detail-body");
  const closeBtn = document.getElementById("detail-close");
  const svgNS = "http://www.w3.org/2000/svg";
  const xhtmlNS = "http://www.w3.org/1999/xhtml";

  let historyTurns = [];    // completed turns from /api/history
  let sourceMeta = new Map(); // sid → { title, url }
  let selectedKey = null;

  // Layout constants (portrait, wide gaps)
  const USER_H = 72, ORCH_H = 60, WORKER_W = 132, WORKER_H = 96;
  const TOOL_W = 116, TOOL_H = 66, MERGE_H = 60;
  const GAP_Y = 34;
  const ITER_GAP = 18;
  const SPINE_W = 128, SPINE_ROW_H = 46, SPINE_ROW_GAP = 8, SPINE_TOP = 22;
  const SPINE_GUTTER = 24;   // gap between spine and main DAG
  const MAX_SPINE_ROWS = 8;
  const CARD_PAD_X = 12;
  const CARD_PAD_TOP = 4;

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
    const smeta = (a?.sources_meta || []);
    smeta.forEach(s => sourceMeta.set(s.source_id, { title: s.source_title || s.source_id, url: s.source_url || "" }));
    return {
      no: a?.turn ?? u?.turn ?? null,
      user_q: u?.content || "",
      workers,
      cost: { calls: [], total: a?.cost_dollars || 0 },
      merger_active: true, done: true,
      answer_text: a?.content || "",
      sources: (a?.source_ids || []).map(sid => ({ source_id: sid })),
      sources_meta: smeta,
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

  // ── Score replay (client-side reconstruction of context_store's HOT tier) ──
  function computeSnapshots(turns) {
    const state = new Map();   // sid → { score, hits_total, first_seen_turn }
    const snapshots = [];
    for (const t of turns) {
      const hitIds = new Set();
      const hitByTool = new Map(); // sid → [tool call_id, ...] used by (for arcs)
      for (const w of t.workers) {
        for (const tc of w.tool_calls) {
          for (const s of tc.sources) {
            hitIds.add(s.source_id);
            if (!hitByTool.has(s.source_id)) hitByTool.set(s.source_id, []);
            hitByTool.get(s.source_id).push({ worker_id: w.id, call_id: tc.call_id });
          }
        }
      }
      const newlyAdded = new Set();
      for (const sid of hitIds) {
        if (!state.has(sid)) {
          newlyAdded.add(sid);
          state.set(sid, { score: 4, hits_total: 1, first_seen_turn: t.no });
        } else {
          const s = state.get(sid);
          s.score += 4;
          s.hits_total += 1;
        }
      }
      const evicted = new Set();
      for (const [sid, s] of state) {
        if (!hitIds.has(sid)) {
          s.score /= 2;
          if (s.score < 0.5) evicted.add(sid);
        }
      }
      const rows = [];
      for (const [sid, s] of state) {
        const meta = sourceMeta.get(sid) || { title: sid, url: "" };
        rows.push({
          source_id: sid,
          title: meta.title,
          url: meta.url,
          score: s.score,
          hits_total: s.hits_total,
          was_hit: hitIds.has(sid),
          was_new: newlyAdded.has(sid),
          was_evicted: evicted.has(sid),
          used_by: hitByTool.get(sid) || [],
        });
      }
      rows.sort((a, b) => (b.was_hit - a.was_hit) || (b.score - a.score));
      snapshots.push({ turn: t.no, sources: rows });
      for (const sid of evicted) state.delete(sid);
    }
    return snapshots;
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
  function renderTurnSVG(t, snapshot, cardEl) {
    const cardW = Math.max(420, cardEl.clientWidth - 24);
    const nWorkers = Math.max(t.workers.length, 1);
    const maxIters = t.workers.reduce((m, w) => Math.max(m, (w.tool_calls || []).length), 0);

    // Main DAG occupies right side of card; spine on left
    const mainX = SPINE_W + SPINE_GUTTER;
    const mainW = cardW - mainX;

    // Vertical layout of main DAG
    const userY = CARD_PAD_TOP + 4;
    const orchY = userY + USER_H + GAP_Y;
    const workerY = orchY + ORCH_H + GAP_Y;
    const iterYStart = workerY + WORKER_H + GAP_Y;
    const iterBlockH = maxIters > 0 ? maxIters * (TOOL_H + ITER_GAP) - ITER_GAP : 0;
    const mergerY = iterYStart + iterBlockH + (maxIters > 0 ? GAP_Y : 0);
    const mainH = mergerY + MERGE_H + 12;

    // Spine layout
    const spineRows = (snapshot?.sources || []).slice(0, MAX_SPINE_ROWS);
    const spineBlockH = spineRows.length ? SPINE_TOP + spineRows.length * (SPINE_ROW_H + SPINE_ROW_GAP) - SPINE_ROW_GAP : 0;

    const height = Math.max(mainH, spineBlockH + 12);
    const svg = svgEl("svg", { viewBox: `0 0 ${cardW} ${height}`, xmlns: svgNS });
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", height);
    svg.classList.add("turn-card-svg");

    // ── Spine ──
    const spineY0 = SPINE_TOP;
    const spineRects = new Map();  // sid → { x, y, w, h }
    if (spineRows.length) {
      const label = svgEl("text", { x: 6, y: 14, class: "spine-header" });
      label.textContent = "HOT sources";
      svg.appendChild(label);
      spineRows.forEach((s, i) => {
        const x = 4, y = spineY0 + i * (SPINE_ROW_H + SPINE_ROW_GAP);
        const w = SPINE_W - 8, h = SPINE_ROW_H;
        spineRects.set(s.source_id, { x, y, w, h });
        const cls = ["spine-node"];
        if (s.was_hit) cls.push("hit");
        if (s.was_new) cls.push("new");
        if (s.was_evicted) cls.push("evicted");
        if (!s.was_hit && !s.was_evicted) cls.push("dim");
        const g = svgEl("g", { class: cls.join(" ") });
        g.appendChild(svgEl("rect", { x, y, width: w, height: h, class: "spine-shape" }));
        const fo = svgEl("foreignObject", { x, y, width: w, height: h });
        const div = document.createElementNS(xhtmlNS, "div");
        div.setAttribute("class", "spine-fo");
        const t1 = document.createElementNS(xhtmlNS, "div");
        t1.setAttribute("class", "spine-title");
        t1.textContent = (s.title || s.source_id).slice(0, 80);
        const meta = document.createElementNS(xhtmlNS, "div");
        meta.setAttribute("class", "spine-meta");
        const scoreEl = document.createElementNS(xhtmlNS, "span");
        scoreEl.textContent = s.score.toFixed(1);
        const hitsEl = document.createElementNS(xhtmlNS, "span");
        hitsEl.textContent = s.was_new ? "NEW" : s.was_evicted ? "×EVICT" : s.was_hit ? `+${s.hits_total}` : `×${s.hits_total}`;
        meta.appendChild(scoreEl); meta.appendChild(hitsEl);
        div.appendChild(t1); div.appendChild(meta);
        fo.appendChild(div);
        g.appendChild(fo);
        g.addEventListener("click", () => {
          selectedKey = `spine:${t.no}:${s.source_id}`;
          showSourceDetail(s, t.no);
        });
        svg.appendChild(g);
      });
    }

    // ── Main DAG nodes ──
    const midX = mainX + mainW / 2;
    const workerAvailW = mainW - 24;
    const workerW = Math.max(120, Math.min(WORKER_W, Math.floor((workerAvailW - (nWorkers - 1) * 18) / nWorkers)));
    const totalRowW = nWorkers * workerW + (nWorkers - 1) * 18;
    const rowStartX = mainX + (mainW - totalRowW) / 2;

    const nodes = [];

    nodes.push({
      key: `t${t.no}.user`,
      x: mainX + 12, y: userY, w: mainW - 24, h: USER_H,
      label: t.user_q || "",
      sub: "user question",
      statusClass: "done", kind: "user",
      data: { type: "user_q", text: t.user_q, turn: t.no },
    });
    nodes.push({
      key: `t${t.no}.orch`,
      x: midX - 80, y: orchY, w: 160, h: ORCH_H,
      label: "orchestrator",
      sub: `plan · ${t.workers.length} worker${t.workers.length===1?"":"s"}`,
      statusClass: t.workers.length ? "done" : "working", kind: "orch",
      data: { type: "orchestrator", plan: t.workers, turn: t.no },
    });

    // Worker+iter nodes; also track which tool node fetched which sid (for spine arcs)
    const arcs = [];  // { from: {x,y}, to: {x,y}, hit: bool }
    t.workers.forEach((w, i) => {
      const x = rowStartX + i * (workerW + 18);
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

      const iterW = Math.min(workerW - 8, TOOL_W);
      const iterX = x + (workerW - iterW) / 2;
      w.tool_calls.forEach((tc, j) => {
        const isWeb = tc.tool === "web_search";
        const y = iterYStart + j * (TOOL_H + ITER_GAP);
        const label = isWeb ? "web search" : "retrieve";
        const sub = isWeb ?
          (tc.status === "done" ? `${tc.n_chunks + tc.n_facts || "?"} src` : "…searching") :
          (tc.status === "done" ? `${tc.n_chunks + tc.n_facts} src · ${tc.elapsed_ms||0}ms` : "…fetching");
        nodes.push({
          key: `t${t.no}.w${i}.t${tc.call_id}`,
          x: iterX, y, w: iterW, h: TOOL_H,
          label, sub,
          statusClass: tc.status === "done" ? "done" : "working",
          kind: isWeb ? "web" : "tool",
          data: { type: "tool_call", tool_call: tc, worker_id: i, worker_focus: w.focus, iter: j+1, turn: t.no },
        });
        // Spine arcs: for each source this tool fetched that appears in the spine,
        // draw an arc from spine row → tool node.
        for (const s of (tc.sources || [])) {
          const rect = spineRects.get(s.source_id);
          if (!rect) continue;
          arcs.push({
            fromX: rect.x + rect.w,
            fromY: rect.y + rect.h / 2,
            toX: iterX,
            toY: y + TOOL_H / 2,
            hit: true,
          });
        }
      });
    });

    // Merger
    if (t.merger_active || t.done) {
      nodes.push({
        key: `t${t.no}.merger`,
        x: midX - 80, y: mergerY, w: 160, h: MERGE_H,
        label: "merger",
        sub: t.done ? `${(t.sources || []).length} sources cited` : "streaming…",
        statusClass: t.done ? "done" : "working", kind: "merger",
        data: { type: "merger", answer: t.answer_text, sources: t.sources || [], turn: t.no },
      });
    }

    // Draw spine arcs FIRST (under the main DAG)
    arcs.forEach(a => {
      const midMx = (a.fromX + a.toX) / 2;
      const path = svgEl("path", {
        d: `M ${a.fromX} ${a.fromY} C ${midMx} ${a.fromY}, ${midMx} ${a.toY}, ${a.toX} ${a.toY}`,
        class: "spine-arc" + (a.hit ? " hit" : ""),
      });
      svg.appendChild(path);
    });

    // Main DAG edges
    function edge(a, b, cls) {
      const ax = a.x + a.w / 2, ay = a.y + a.h;
      const bx = b.x + b.w / 2, by = b.y;
      const midY = (ay + by) / 2;
      svg.appendChild(svgEl("path", {
        d: `M ${ax} ${ay} C ${ax} ${midY}, ${bx} ${midY}, ${bx} ${by}`,
        class: `dag-edge ${cls || ""}`,
      }));
    }
    function loopEdge(tool, worker) {
      const tx = tool.x + tool.w, ty = tool.y + tool.h / 2;
      const wx = worker.x + worker.w, wy = worker.y + worker.h / 2;
      const bx = Math.max(tx, wx) + 22;
      svg.appendChild(svgEl("path", {
        d: `M ${tx} ${ty} C ${bx} ${ty}, ${bx} ${wy}, ${wx} ${wy}`,
        class: "dag-edge iter-loop",
      }));
    }
    function nodeByKey(k) { return nodes.find(n => n.key === k); }

    const userN = nodeByKey(`t${t.no}.user`);
    const orchN = nodeByKey(`t${t.no}.orch`);
    if (userN && orchN) edge(userN, orchN, orchN.statusClass === "working" ? "active" : "done");

    const mergerN = nodeByKey(`t${t.no}.merger`);
    t.workers.forEach((w, i) => {
      const wN = nodeByKey(`t${t.no}.w${i}`);
      if (orchN && wN) edge(orchN, wN, wN.statusClass === "working" ? "active" : "done");
      w.tool_calls.forEach((tc, j) => {
        const tN = nodeByKey(`t${t.no}.w${i}.t${tc.call_id}`);
        if (!tN) return;
        if (j === 0) {
          edge(wN, tN, tc.status !== "done" ? "active" : "done");
        } else {
          const prev = nodeByKey(`t${t.no}.w${i}.t${w.tool_calls[j-1].call_id}`);
          if (prev) edge(prev, tN, tc.status !== "done" ? "active" : "done");
        }
        if (wN && tN) loopEdge(tN, wN);
      });
      if (mergerN) {
        const lastTool = w.tool_calls.length ? nodeByKey(`t${t.no}.w${i}.t${w.tool_calls[w.tool_calls.length-1].call_id}`) : null;
        const from = lastTool || wN;
        if (from) edge(from, mergerN, mergerN.statusClass === "working" ? "active" : lastTool ? "tool-out" : "done");
      }
    });

    // Draw main DAG nodes on top
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

  // ── Render the vertical stack of turn cards with dividers ──────────
  function renderStack() {
    stackEl.innerHTML = "";
    const cards = historyTurns.slice();
    const live = Atlas.state.turn;
    const liveInHistory = live.no && cards.some(c => c.no === live.no);
    if (live.no && !liveInHistory) {
      cards.push({ ...live, is_live: true });
    } else if (live.no && liveInHistory && !live.done) {
      const idx = cards.findIndex(c => c.no === live.no);
      if (idx >= 0) cards[idx] = { ...live, is_live: true };
    }
    if (!cards.length) {
      const empty = document.createElement("div");
      empty.className = "dim";
      empty.style.padding = "20px";
      empty.textContent = "No turns yet. Ask something to see the flow.";
      stackEl.appendChild(empty);
      return;
    }

    // Compute snapshots up-front (score replay)
    const snapshots = computeSnapshots(cards);

    cards.forEach((t, idx) => {
      if (idx > 0) stackEl.appendChild(buildDivider(cards[idx-1], t, snapshots[idx-1]));
      stackEl.appendChild(buildCard(t, snapshots[idx]));
    });
    requestAnimationFrame(() => { stackEl.scrollTop = stackEl.scrollHeight; });
  }

  function buildDivider(prevTurn, nextTurn, prevSnap) {
    const el = document.createElement("div");
    el.className = "turn-divider";
    const nHot = prevSnap ? Math.min(prevSnap.sources.filter(s => !s.was_evicted).length, MAX_SPINE_ROWS) : 0;
    const nCarry = Math.min(prevTurn.no, 6);   // history window
    el.innerHTML =
      `<span class="div-caption">carries forward:</span> ` +
      `<span><strong>${nCarry}</strong> recent turns</span>` +
      `<span>·</span>` +
      `<span><strong>${nHot}</strong> hot src</span>` +
      `<span>·</span>` +
      `<span>business.md</span>`;
    return el;
  }

  function buildCard(t, snapshot) {
    const card = document.createElement("div");
    card.className = "turn-card";
    if (t.is_live) card.classList.add("live");
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
    requestAnimationFrame(() => {
      const svg = renderTurnSVG(t, snapshot, card);
      card.appendChild(svg);
    });
    return card;
  }

  // ── Detail slide-over ────────────────────────────────────────────────
  function showSourceDetail(s, turn) {
    detailTitle.textContent = "source";
    let html = `<div class="kv"><span class="k">turn</span>${turn}</div>`;
    html += `<div class="kv"><span class="k">id</span>${escapeHtml(s.source_id)}</div>`;
    html += `<div class="kv"><span class="k">title</span>${escapeHtml(s.title || "(untitled)")}</div>`;
    html += `<div class="kv"><span class="k">score</span>${s.score.toFixed(2)}</div>`;
    html += `<div class="kv"><span class="k">hits total</span>${s.hits_total}</div>`;
    html += `<div class="kv"><span class="k">this turn</span>${s.was_hit ? "HIT +4" : "not hit, score halved"}${s.was_new ? " · NEW" : ""}${s.was_evicted ? " · EVICTED" : ""}</div>`;
    if (s.url) html += `<h3>Link</h3><p><a href="${escapeHtml(s.url)}" target="_blank" style="color:var(--accent-red)">${escapeHtml(s.url)}</a></p>`;
    detailBody.innerHTML = html;
    slideover.dataset.open = "true";
  }
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
          const meta = sourceMeta.get(s.source_id) || {};
          const title = meta.title || s.source_id;
          if (meta.url) {
            html += `<li><a href="${escapeHtml(meta.url)}" target="_blank">${escapeHtml(title)}</a></li>`;
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
    if (ev.type === "turn_done") fetchHistory();
  });
  Atlas.on("turn_reset", () => { renderStack(); renderCost(); });
  Atlas.on("view_change", v => {
    if (v === "main") { renderStack(); renderCost(); }
  });
  window.addEventListener("resize", () => { renderStack(); });

  fetchHistory();
  renderCost();
})();
