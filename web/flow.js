// Flow view — DAG on top (per-turn), force-directed source cloud below.
// SVG with foreignObject for wrapped text; canvas + tuned physics for cloud.

(function() {
  const dagSvg = document.getElementById("dag-svg");
  const dagTurnLabel = document.getElementById("dag-turn-label");
  const canvas = document.getElementById("cloud-canvas");
  const detailTitle = document.getElementById("detail-title");
  const detailBody = document.getElementById("detail-body");
  const closeBtn = document.getElementById("detail-close");
  const turnPrevBtn = document.getElementById("turn-prev");
  const turnNextBtn = document.getElementById("turn-next");
  const turnLiveBtn = document.getElementById("turn-live");
  const turnNavBadge = document.getElementById("turn-nav-badge");
  const svgNS = "http://www.w3.org/2000/svg";
  const xhtmlNS = "http://www.w3.org/1999/xhtml";

  // ── DAG rendering ──────────────────────────────────────────────────
  let selectedKey = null;

  // History nav state:
  //   viewMode = "live"  → render Atlas.state.turn (in-flight or last-complete)
  //   viewMode = "hist"  → render historyTurns[historyIndex]
  let historyTurns = [];   // array of {turn, plan, workers, source_ids, cost_dollars, ...} from server
  let historyIndex = 0;
  let viewMode = "live";

  function svgEl(name, attrs) {
    const e = document.createElementNS(svgNS, name);
    if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  // Build the same turn-shaped object we use for live state, but from a history entry.
  function turnFromHistory(u, a) {
    // u = user history row (role:user), a = assistant history row (role:assistant)
    const workers = (a?.workers || []).map((w, i) => {
      const tool_calls = (w.tool_calls || []).map((tc, j) => ({
        call_id: tc.call_id || `w${i}.t${j+1}`,
        tool: tc.tool || "scribe_retrieve",
        sub_queries: tc.sub_queries || [],
        status: "done",
        n_chunks: tc.n_chunks || 0,
        n_facts: tc.n_facts || 0,
        sources: (tc.source_ids || []).map(sid => ({ source_id: sid, source_title: "", source_url: "", kind: "chunk" })),
        elapsed_ms: tc.elapsed_ms || 0,
      }));
      const plan = (a.plan || [])[i] || {};
      return {
        id: i,
        focus: w.focus || plan.focus || `worker ${i}`,
        task: plan.task || "",
        status: w.error ? "error" : "done",
        tool_calls,
        sources: [],   // aggregated dynamically at render
        error: w.error || null,
        findings_preview: "",
        input_tokens: 0,
        output_tokens: 0,
      };
    });
    return {
      no: a?.turn ?? u?.turn ?? null,
      user_q: u?.content || "",
      workers,
      cost: { calls: [], total: a?.cost_dollars || 0 },
      merger_active: true,
      done: true,
      answer_text: a?.content || "",
      sources: (a?.source_ids || []).map(sid => ({ source_id: sid })),
    };
  }

  function activeTurn() {
    if (viewMode === "hist" && historyTurns.length) {
      return historyTurns[historyIndex];
    }
    return Atlas.state.turn;
  }

  function refreshTurnNav() {
    const total = historyTurns.length;
    if (viewMode === "live") {
      turnNavBadge.textContent = total ? `live · ${total} past` : "live · no past";
      turnPrevBtn.disabled = total === 0;
      turnNextBtn.disabled = true;
      turnLiveBtn.disabled = true;
    } else {
      turnNavBadge.textContent = `${historyIndex + 1} / ${total}`;
      turnPrevBtn.disabled = historyIndex <= 0;
      turnNextBtn.disabled = historyIndex >= total - 1;
      turnLiveBtn.disabled = false;
    }
  }

  async function fetchHistory() {
    try {
      const d = await (await fetch("/api/history?n=200")).json();
      const rows = d.turns || [];
      // Pair user + assistant by turn
      const byTurn = {};
      rows.forEach(r => {
        if (!byTurn[r.turn]) byTurn[r.turn] = {};
        byTurn[r.turn][r.role] = r;
      });
      const turnNos = Object.keys(byTurn).map(n => parseInt(n, 10)).sort((a,b)=>a-b);
      historyTurns = turnNos
        .filter(n => byTurn[n].assistant)   // only completed turns
        .map(n => turnFromHistory(byTurn[n].user, byTurn[n].assistant));
    } catch (e) { console.error("fetchHistory", e); }
    refreshTurnNav();
  }

  turnPrevBtn.addEventListener("click", () => {
    if (viewMode === "live") {
      if (!historyTurns.length) return;
      viewMode = "hist";
      historyIndex = historyTurns.length - 1;
    } else if (historyIndex > 0) {
      historyIndex--;
    }
    refreshTurnNav();
    renderDAG();
  });
  turnNextBtn.addEventListener("click", () => {
    if (viewMode !== "hist") return;
    if (historyIndex < historyTurns.length - 1) {
      historyIndex++;
    } else {
      viewMode = "live";
    }
    refreshTurnNav();
    renderDAG();
  });
  turnLiveBtn.addEventListener("click", () => {
    viewMode = "live";
    refreshTurnNav();
    renderDAG();
  });

  function workerSourceCount(w) {
    // Union of source_ids across all this worker's tool_calls.
    const seen = new Set();
    for (const tc of (w.tool_calls || [])) {
      for (const s of (tc.sources || [])) {
        if (s.source_id) seen.add(s.source_id);
      }
    }
    return seen.size;
  }

  function renderDAG() {
    const t = activeTurn();
    dagSvg.innerHTML = "";
    if (!t || !t.no) {
      dagTurnLabel.textContent = "—";
      return;
    }
    dagTurnLabel.textContent = t.no;

    const width = dagSvg.clientWidth || 900;
    const height = dagSvg.clientHeight || 480;
    dagSvg.setAttribute("viewBox", `0 0 ${width} ${height}`);

    const midX = width / 2;
    const userY = 24, orchY = 100, workerY = 200, toolY = 320, mergerY = height - 90;

    const nodes = [];  // {key, x, y, w, h, label, sub, statusClass, data}

    // User Q — wide, wrapped
    nodes.push({
      key: "user",
      x: midX - Math.min(360, width * 0.45),
      y: userY,
      w: Math.min(720, width * 0.9),
      h: 48,
      label: t.user_q || "",
      sub: "user question",
      statusClass: "done",
      data: { type: "user_q", text: t.user_q },
    });

    // Orchestrator
    nodes.push({
      key: "orch", x: midX - 100, y: orchY, w: 200, h: 42,
      label: "orchestrator",
      sub: `plan · ${t.workers.length || "…"} worker${t.workers.length===1?"":"s"}`,
      statusClass: t.workers.length ? "done" : "working",
      data: { type: "orchestrator", plan: t.workers },
    });

    // Workers (row) — sized by count with wrapped label
    const n = Math.max(t.workers.length, 1);
    const maxRowW = width - 40;
    const gap = 16;
    let workerW = Math.min(240, Math.floor((maxRowW - (n - 1) * gap) / n));
    workerW = Math.max(140, workerW);
    const totalW = n * workerW + (n - 1) * gap;
    const startX = (width - totalW) / 2;

    t.workers.forEach((w, i) => {
      const x = startX + i * (workerW + gap);
      let statusClass = w.status;
      if (statusClass === "planned") statusClass = "working";
      const nSources = workerSourceCount(w);
      nodes.push({
        key: `w${i}`, x, y: workerY, w: workerW, h: 52,
        label: w.focus,
        sub: w.status === "done" ? `${w.tool_calls.length} calls · ${nSources} sources` :
             w.status === "error" ? "error" :
             w.status === "retrying" ? (w.retry_msg || "retrying…") :
             w.status === "working" ? "working…" : "planned…",
        statusClass, data: { type: "worker", worker: w, id: i },
      });

      // Tool_use nodes below each worker (retrieve boxes)
      const toolW = Math.min(workerW, 120);
      const toolH = 34;
      const toolGap = 6;
      w.tool_calls.forEach((tc, j) => {
        const tx = x + (workerW - toolW) / 2;
        const ty = toolY + j * (toolH + toolGap);
        nodes.push({
          key: `w${i}.t${tc.call_id}`,
          x: tx, y: ty, w: toolW, h: toolH,
          label: tc.tool === "web_search" ? "web search" : "retrieve",
          sub: tc.status === "done" ? `${tc.n_chunks + tc.n_facts} src · ${tc.elapsed_ms||0}ms` : "…fetching",
          statusClass: tc.status === "done" ? "done" : "working",
          data: { type: "tool_call", tool_call: tc, worker_id: i, worker_focus: w.focus },
        });
      });
    });

    // Merger + answer
    if (t.merger_active || t.done) {
      nodes.push({
        key: "merger", x: midX - 100, y: mergerY, w: 200, h: 42,
        label: "merger",
        sub: t.done ? `${(t.sources || []).length} sources cited` : "streaming…",
        statusClass: t.done ? "done" : "working",
        data: { type: "merger", answer: t.answer_text, sources: t.sources || [] },
      });
    }

    function edge(a, b, kind) {
      // kind ∈ {"main","retrieve-out"}. Main is worker→worker/orch relations.
      const ax = a.x + a.w / 2, ay = a.y + a.h;
      const bx = b.x + b.w / 2, by = b.y;
      const midY = (ay + by) / 2;
      const classes = ["dag-edge"];
      if (kind === "retrieve-out") classes.push("retrieve-out");
      if (kind === "active") classes.push("active");
      if (kind === "done") classes.push("done");
      const path = svgEl("path", {
        d: `M ${ax} ${ay} C ${ax} ${midY}, ${bx} ${midY}, ${bx} ${by}`,
        class: classes.join(" "),
      });
      dagSvg.appendChild(path);
    }
    function nodeByKey(k) { return nodes.find(n => n.key === k); }

    const userN = nodeByKey("user");
    const orchN = nodeByKey("orch");
    if (userN && orchN) edge(userN, orchN, orchN.statusClass === "working" ? "active" : "done");

    const mergerN = nodeByKey("merger");
    t.workers.forEach((w, i) => {
      const wN = nodeByKey(`w${i}`);
      if (orchN && wN) edge(orchN, wN, wN.statusClass === "working" ? "active" : "done");
      // worker → merger
      if (wN && mergerN) {
        edge(wN, mergerN, mergerN.statusClass === "working" ? "active" : "done");
      }
      // worker → tool + tool → merger (dashed dim, showing sources flow into merge)
      w.tool_calls.forEach((tc) => {
        const tN = nodeByKey(`w${i}.t${tc.call_id}`);
        if (wN && tN) edge(wN, tN, tc.status !== "done" ? "active" : "done");
        if (tN && mergerN) edge(tN, mergerN, tc.status === "done" ? "retrieve-out" : "retrieve-out");
      });
    });

    // Draw nodes on top — using foreignObject for real HTML wrap
    nodes.forEach(n => {
      const g = svgEl("g", { class: `dag-node ${n.statusClass}${selectedKey === n.key ? " selected" : ""}` });
      g.appendChild(svgEl("rect", {
        x: n.x, y: n.y, width: n.w, height: n.h, rx: 0,
        class: "dag-shape",
      }));
      const fo = svgEl("foreignObject", {
        x: n.x, y: n.y, width: n.w, height: n.h,
      });
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
        renderDAG();
      });
      dagSvg.appendChild(g);
    });
  }

  function showDetail(node) {
    const d = node.data;
    detailTitle.textContent = d.type.replace("_", " ");
    let html = "";
    if (d.type === "user_q") {
      html = `<h3>User question</h3><pre>${escapeHtml(d.text || "")}</pre>`;
    } else if (d.type === "orchestrator") {
      html = `<h3>Plan (${d.plan.length} workers)</h3>`;
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
      html = `<div class="kv"><span class="k">focus</span>${escapeHtml(w.focus)}</div>`;
      html += `<div class="kv"><span class="k">status</span>${w.status}${w.error ? " ("+escapeHtml(w.error)+")":""}</div>`;
      html += `<div class="kv"><span class="k">tokens</span>${w.input_tokens} in / ${w.output_tokens} out</div>`;
      html += `<div class="kv"><span class="k">sources</span>${workerSourceCount(w)}</div>`;
      html += `<h3>Task assigned</h3><pre>${escapeHtml(w.task || "(no task detail)")}</pre>`;
      html += `<h3>Tool calls (${w.tool_calls.length})</h3>`;
      if (!w.tool_calls.length) html += `<p class="dim">none yet</p>`;
      else {
        w.tool_calls.forEach(tc => {
          html += `<div class="kv"><span class="k">${tc.tool}</span>${tc.n_chunks} chunks + ${tc.n_facts} facts · ${tc.elapsed_ms||0}ms</div>`;
          if (tc.sub_queries && tc.sub_queries.length) {
            html += `<ul class="subquery-list">${tc.sub_queries.map(q => `<li>${escapeHtml(q)}</li>`).join("")}</ul>`;
          }
        });
      }
      html += `<h3>Findings preview</h3><pre>${escapeHtml(w.findings_preview || "(streaming or not returned)")}</pre>`;
    } else if (d.type === "tool_call") {
      const tc = d.tool_call;
      html = `<div class="kv"><span class="k">tool</span>${tc.tool}</div>`;
      html += `<div class="kv"><span class="k">worker</span>#${d.worker_id} · ${escapeHtml(d.worker_focus || "")}</div>`;
      html += `<div class="kv"><span class="k">status</span>${tc.status}${tc.elapsed_ms ? ` · ${tc.elapsed_ms}ms` : ""}</div>`;
      html += `<div class="kv"><span class="k">returned</span>${tc.n_chunks} chunks · ${tc.n_facts} facts</div>`;
      html += `<h3>Sub-queries sent</h3><ul class="subquery-list">${(tc.sub_queries || []).map(q => `<li>${escapeHtml(q)}</li>`).join("")}</ul>`;
      html += `<h3>Sources returned</h3>`;
      if (!tc.sources.length) html += `<p class="dim">none</p>`;
      else {
        html += `<ul class="node-list">`;
        tc.sources.forEach(s => {
          const title = s.source_title || s.source_id;
          if (s.source_url) {
            html += `<li><a href="${escapeHtml(s.source_url)}" target="_blank">${escapeHtml(title)}</a> <span class="dim" style="font-size:10px">[${escapeHtml(s.kind || "chunk")}]</span></li>`;
          } else {
            html += `<li>${escapeHtml(title)} <span class="dim" style="font-size:10px">[${escapeHtml(s.kind || "chunk")}]</span></li>`;
          }
        });
        html += `</ul>`;
      }
    } else if (d.type === "merger") {
      html = `<div class="kv"><span class="k">sources</span>${(d.sources || []).length} cited</div>`;
      html += `<h3>Merged answer</h3><pre>${escapeHtml((d.answer || "").slice(0, 6000))}${(d.answer||"").length > 6000 ? "\n\n… (truncated)" : ""}</pre>`;
      if (d.sources && d.sources.length) {
        html += `<h3>Cited source ids</h3><ul class="node-list">`;
        d.sources.forEach(s => {
          html += `<li>${escapeHtml(s.source_id || "")}</li>`;
        });
        html += `</ul>`;
      }
    }
    detailBody.innerHTML = html;
  }

  closeBtn.addEventListener("click", () => {
    selectedKey = null;
    detailBody.innerHTML = `<p class="dim">Select a node on the left to inspect it.</p>`;
    detailTitle.textContent = "Details";
    renderDAG();
  });

  function escapeHtml(s) {
    return String(s || "").replace(/[&<>"']/g, c =>
      ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"}[c]));
  }

  // ── Cost panel rendering ───────────────────────────────────────────
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

  // ── Source cloud (force-directed, tuned to not explode) ────────────
  const cloudState = {
    nodes: [],     // {id, x, y, vx, vy, score, title, url, r}
    edges: [],     // {source, target, weight}
    dpr: 1,
    lastFetch: 0,
    edgeIndex: new Map(),  // id → array of edges referencing it (for O(1) attraction lookup)
  };
  const MAX_VEL = 3.5;

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    cloudState.dpr = dpr;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.floor(rect.width * dpr);
    canvas.height = Math.floor(rect.height * dpr);
  }

  async function fetchCloud() {
    try {
      const d = await (await fetch("/api/source_cloud")).json();
      cloudState.lastFetch = Date.now();
      const posMap = new Map(cloudState.nodes.map(n => [n.id, { x: n.x, y: n.y, vx: n.vx, vy: n.vy }]));
      const rect = canvas.getBoundingClientRect();
      const cx = rect.width / 2, cy = rect.height / 2;
      cloudState.nodes = (d.nodes || []).map(n => {
        const p = posMap.get(n.id);
        // Seed new nodes near center with small random offset (not far corners) — prevents explode
        const nx = p ? p.x : cx + (Math.random() - 0.5) * 60;
        const ny = p ? p.y : cy + (Math.random() - 0.5) * 60;
        return {
          id: n.id, title: n.title, url: n.url,
          score: n.score, last_turn: n.last_turn, hits_total: n.hits_total,
          x: nx, y: ny, vx: p ? p.vx : 0, vy: p ? p.vy : 0,
          r: Math.max(3, Math.min(10, 3 + Math.sqrt((n.score || 1)) * 1.6)),
        };
      });
      const nodeIds = new Set(cloudState.nodes.map(n => n.id));
      cloudState.edges = (d.edges || []).filter(e => nodeIds.has(e.source) && nodeIds.has(e.target));
      // Build edge index
      const idx = new Map();
      for (const n of cloudState.nodes) idx.set(n.id, []);
      for (const e of cloudState.edges) {
        idx.get(e.source).push(e);
        idx.get(e.target).push(e);
      }
      cloudState.edgeIndex = idx;
    } catch (e) { /* ignore */ }
  }

  function scoreColor(score) {
    const t = Math.min(1, Math.max(0, (score - 0.5) / 12));
    const c1 = [96, 112, 128], c2 = [217, 69, 58];
    const r = Math.round(c1[0] + (c2[0]-c1[0]) * t);
    const g = Math.round(c1[1] + (c2[1]-c1[1]) * t);
    const b = Math.round(c1[2] + (c2[2]-c1[2]) * t);
    return `rgb(${r},${g},${b})`;
  }

  function clampVel(v) {
    if (v > MAX_VEL) return MAX_VEL;
    if (v < -MAX_VEL) return -MAX_VEL;
    return v;
  }

  function stepPhysics(rect) {
    const nodes = cloudState.nodes;
    const edges = cloudState.edges;
    const N = nodes.length;
    if (N === 0) return;
    // Repulsion strength scales inversely with node count so cloud doesn't explode at scale
    const kRep = Math.min(180, 8000 / N);
    // Node-node repulsion (all pairs, O(N^2) — fine up to ~200 nodes)
    for (let i = 0; i < N; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < N; j++) {
        const b = nodes[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const d2 = dx*dx + dy*dy + 4;   // +4 avoids blowup on collision
        const dd = Math.sqrt(d2);
        const f = kRep / d2;
        const fx = (dx / dd) * f, fy = (dy / dd) * f;
        a.vx -= fx; a.vy -= fy;
        b.vx += fx; b.vy += fy;
      }
    }
    // Attraction via edges (linear spring toward target length)
    const targetLen = 60;
    const springK = 0.03;
    for (const e of edges) {
      const a = nodes.find(n => n.id === e.source);
      const b = nodes.find(n => n.id === e.target);
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const dd = Math.sqrt(dx*dx + dy*dy + 0.01);
      const f = ((dd - targetLen) / dd) * springK * Math.min(3, (e.weight || 1));
      a.vx += dx * f; a.vy += dy * f;
      b.vx -= dx * f; b.vy -= dy * f;
    }
    // Centering + damping + velocity clamp
    const cx = rect.width / 2, cy = rect.height / 2;
    const centerK = 0.006;
    const damping = 0.75;
    for (const n of nodes) {
      n.vx = (n.vx + (cx - n.x) * centerK) * damping;
      n.vy = (n.vy + (cy - n.y) * centerK) * damping;
      n.vx = clampVel(n.vx);
      n.vy = clampVel(n.vy);
      n.x += n.vx; n.y += n.vy;
      // Hard clamp inside canvas
      n.x = Math.max(n.r + 2, Math.min(rect.width - n.r - 2, n.x));
      n.y = Math.max(n.r + 2, Math.min(rect.height - n.r - 2, n.y));
    }
  }

  function drawCloud() {
    const ctx = canvas.getContext("2d");
    const rect = canvas.getBoundingClientRect();
    ctx.setTransform(cloudState.dpr, 0, 0, cloudState.dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    // Edges first — thin translucent
    ctx.strokeStyle = "rgba(255,255,255,0.05)";
    ctx.lineWidth = 0.8;
    for (const e of cloudState.edges) {
      const a = cloudState.nodes.find(n => n.id === e.source);
      const b = cloudState.nodes.find(n => n.id === e.target);
      if (!a || !b) continue;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    // Nodes
    for (const n of cloudState.nodes) {
      ctx.fillStyle = scoreColor(n.score);
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function loop() {
    if (Atlas.state.view === "flow") {
      const rect = canvas.getBoundingClientRect();
      if (rect.width && rect.height) {
        stepPhysics(rect);
        drawCloud();
      }
    }
    requestAnimationFrame(loop);
  }

  // Canvas click → nearest node → inspect
  canvas.addEventListener("click", (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    let nearest = null, best = 1e9;
    for (const n of cloudState.nodes) {
      const dx = n.x - mx, dy = n.y - my;
      const d2 = dx*dx + dy*dy;
      if (d2 < 100 && d2 < best) { best = d2; nearest = n; }
    }
    if (nearest) {
      selectedKey = "cloud:" + nearest.id;
      detailTitle.textContent = "source";
      detailBody.innerHTML =
        `<div class="kv"><span class="k">id</span>${escapeHtml(nearest.id)}</div>` +
        `<div class="kv"><span class="k">title</span>${escapeHtml(nearest.title || "(no title)")}</div>` +
        `<div class="kv"><span class="k">score</span>${nearest.score.toFixed(2)}</div>` +
        `<div class="kv"><span class="k">last turn</span>${nearest.last_turn}</div>` +
        `<div class="kv"><span class="k">hits</span>${nearest.hits_total}</div>` +
        (nearest.url ? `<h3>Link</h3><p><a href="${escapeHtml(nearest.url)}" target="_blank" style="color:var(--accent-red)">${escapeHtml(nearest.url)}</a></p>` : "");
    }
  });

  // ── Event handlers ─────────────────────────────────────────────────
  Atlas.on("turn_event", ev => {
    // A new live turn started → snap back to live view
    if (ev.type === "turn_start") viewMode = "live";
    if (viewMode === "live") renderDAG();
    renderCost();
    if (ev.type === "turn_done") {
      // Refresh history so completed turn shows up in the nav
      fetchHistory();
    }
  });
  Atlas.on("turn_reset", () => {
    if (viewMode === "live") renderDAG();
    renderCost();
  });
  Atlas.on("view_change", async v => {
    if (v === "flow") {
      resizeCanvas();
      renderDAG();
      renderCost();
      await fetchCloud();
    }
  });
  window.addEventListener("resize", () => {
    resizeCanvas();
    if (Atlas.state.view === "flow") renderDAG();
  });

  // Initial load
  resizeCanvas();
  fetchHistory();
  fetchCloud();
  refreshTurnNav();
  requestAnimationFrame(loop);
  // Periodic cloud refresh
  setInterval(() => { if (Atlas.state.view === "flow") fetchCloud(); }, 15000);
})();
