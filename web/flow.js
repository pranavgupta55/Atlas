// Flow view — DAG on top (per-turn), force-directed source cloud below.
// Vanilla SVG for DAG, vanilla canvas + custom physics for cloud.

(function() {
  const dagSvg = document.getElementById("dag-svg");
  const dagTurnLabel = document.getElementById("dag-turn-label");
  const canvas = document.getElementById("cloud-canvas");
  const detailTitle = document.getElementById("detail-title");
  const detailBody = document.getElementById("detail-body");
  const closeBtn = document.getElementById("detail-close");
  const svgNS = "http://www.w3.org/2000/svg";

  // ── DAG rendering ──────────────────────────────────────────────────
  let selectedKey = null;

  function svgEl(name, attrs) {
    const e = document.createElementNS(svgNS, name);
    if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  function renderDAG() {
    const t = Atlas.state.turn;
    dagSvg.innerHTML = "";
    if (!t.no) {
      dagTurnLabel.textContent = "—";
      return;
    }
    dagTurnLabel.textContent = t.no;

    const width = dagSvg.clientWidth;
    const height = dagSvg.clientHeight;
    dagSvg.setAttribute("viewBox", `0 0 ${width} ${height}`);

    // Layers:  y=40 user Q · y=110 orchestrator · y=190 workers · y=280+ tool nodes · y=(bot-60) merger · y=(bot-10) answer
    const midX = width / 2;
    const userY = 40, orchY = 110, workerY = 200, toolYStart = 300, mergerY = height - 90, answerY = height - 30;

    // Nodes list — we'll draw text + click-to-select
    const nodes = [];  // {key, x, y, w, h, label, sub, statusClass, data}

    // User Q
    nodes.push({
      key: "user", x: midX - 200, y: userY, w: 400, h: 34,
      label: (t.user_q || "").slice(0, 80),
      sub: "user question", statusClass: "done", data: { type: "user_q", text: t.user_q },
    });

    // Orchestrator
    nodes.push({
      key: "orch", x: midX - 90, y: orchY, w: 180, h: 34,
      label: "orchestrator",
      sub: `plan: ${t.workers.length || "…"} worker${t.workers.length===1?"":"s"}`,
      statusClass: t.workers.length ? "done" : "working",
      data: { type: "orchestrator", plan: t.workers },
    });

    // Workers (row)
    const n = Math.max(t.workers.length, 1);
    const workerW = 200;
    const gap = 20;
    const totalW = n * workerW + (n - 1) * gap;
    const startX = (width - totalW) / 2;
    t.workers.forEach((w, i) => {
      const x = startX + i * (workerW + gap);
      let statusClass = w.status;
      if (statusClass === "planned") statusClass = "working";
      nodes.push({
        key: `w${i}`, x, y: workerY, w: workerW, h: 42,
        label: w.focus,
        sub: w.status === "done" ? `${w.tool_calls.length} calls · ${w.sources.length} sources` :
             w.status === "error" ? "error" :
             w.status === "retrying" ? (w.retry_msg || "retrying…") : "working…",
        statusClass, data: { type: "worker", worker: w, id: i },
      });

      // Tool_use nodes below each worker
      const toolW = 60, toolH = 26, toolGap = 6;
      w.tool_calls.forEach((tc, j) => {
        const tx = x + (workerW - toolW) / 2;
        const ty = toolYStart + j * (toolH + toolGap);
        nodes.push({
          key: `w${i}.t${tc.call_id}`, x: tx, y: ty, w: toolW, h: toolH,
          label: tc.tool === "web_search" ? "web" : "retrieve",
          sub: tc.status === "done" ? `${tc.n_chunks + tc.n_facts} src` : "…",
          statusClass: tc.status === "done" ? "done" : "working",
          data: { type: "tool_call", tool_call: tc, worker_id: i },
        });
      });
    });

    // Merger + answer
    if (t.merger_active || t.done) {
      nodes.push({
        key: "merger", x: midX - 90, y: mergerY, w: 180, h: 34,
        label: "merger",
        sub: t.done ? "done" : "streaming…",
        statusClass: t.done ? "done" : "working",
        data: { type: "merger", answer: t.answer_text },
      });
    }

    // Edges
    // user → orch, orch → each worker, each worker → merger (if merger active)
    function edge(a, b, active) {
      const ax = a.x + a.w / 2, ay = a.y + a.h;
      const bx = b.x + b.w / 2, by = b.y;
      const midY = (ay + by) / 2;
      const path = svgEl("path", {
        d: `M ${ax} ${ay} C ${ax} ${midY}, ${bx} ${midY}, ${bx} ${by}`,
        class: "dag-edge" + (active ? " active" : (a.statusClass === "done" && b.statusClass === "done" ? " done" : "")),
      });
      dagSvg.appendChild(path);
    }
    function nodeByKey(k) { return nodes.find(n => n.key === k); }

    const userN = nodeByKey("user");
    const orchN = nodeByKey("orch");
    if (userN && orchN) edge(userN, orchN, orchN.statusClass === "working");

    t.workers.forEach((w, i) => {
      const wN = nodeByKey(`w${i}`);
      if (orchN && wN) edge(orchN, wN, wN.statusClass === "working");
      w.tool_calls.forEach((tc) => {
        const tN = nodeByKey(`w${i}.t${tc.call_id}`);
        if (wN && tN) edge(wN, tN, tc.status !== "done");
      });
    });
    const mergerN = nodeByKey("merger");
    if (mergerN) {
      t.workers.forEach((_, i) => {
        const wN = nodeByKey(`w${i}`);
        if (wN) edge(wN, mergerN, mergerN.statusClass === "working");
      });
    }

    // Draw nodes on top
    nodes.forEach(n => {
      const g = svgEl("g", { class: `dag-node ${n.statusClass}${selectedKey === n.key ? " selected" : ""}` });
      g.appendChild(svgEl("rect", {
        x: n.x, y: n.y, width: n.w, height: n.h, rx: 5,
        class: "dag-shape",
      }));
      const label = svgEl("text", { x: n.x + 8, y: n.y + 15 });
      label.textContent = n.label && n.label.length > 40 ? n.label.slice(0, 40) + "…" : n.label;
      const sub = svgEl("text", { x: n.x + 8, y: n.y + 30, class: "sub" });
      sub.textContent = n.sub;
      g.appendChild(label);
      g.appendChild(sub);
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
    detailTitle.textContent = d.type;
    let html = "";
    if (d.type === "user_q") {
      html = `<h3>User question</h3><pre>${escapeHtml(d.text || "")}</pre>`;
    } else if (d.type === "orchestrator") {
      html = `<h3>Plan</h3>`;
      if (!d.plan.length) html += `<p class="dim">no plan yet</p>`;
      else {
        html += `<ol>`;
        d.plan.forEach(w => {
          html += `<li><strong>${escapeHtml(w.focus)}</strong><br><em class="dim">${escapeHtml(w.task || "")}</em></li>`;
        });
        html += `</ol>`;
      }
    } else if (d.type === "worker") {
      const w = d.worker;
      html = `<div class="kv"><span class="k">focus:</span> ${escapeHtml(w.focus)}</div>`;
      html += `<div class="kv"><span class="k">status:</span> ${w.status}${w.error ? " ("+escapeHtml(w.error)+")":""}</div>`;
      html += `<div class="kv"><span class="k">tokens:</span> ${w.input_tokens} in / ${w.output_tokens} out</div>`;
      html += `<h3>Task</h3><pre>${escapeHtml(w.task || "")}</pre>`;
      html += `<h3>Tool calls (${w.tool_calls.length})</h3>`;
      if (!w.tool_calls.length) html += `<p class="dim">none yet</p>`;
      else {
        w.tool_calls.forEach(tc => {
          html += `<div class="kv"><span class="k">${tc.tool}:</span> ${tc.n_chunks} chunks + ${tc.n_facts} facts (${tc.elapsed_ms}ms)</div>`;
          if (tc.sub_queries && tc.sub_queries.length) {
            html += `<ul class="subquery-list">${tc.sub_queries.map(q => `<li>${escapeHtml(q)}</li>`).join("")}</ul>`;
          }
        });
      }
      html += `<h3>Findings preview</h3><pre>${escapeHtml(w.findings_preview || "")}</pre>`;
    } else if (d.type === "tool_call") {
      const tc = d.tool_call;
      html = `<div class="kv"><span class="k">tool:</span> ${tc.tool}</div>`;
      html += `<div class="kv"><span class="k">status:</span> ${tc.status}${tc.elapsed_ms ? ` · ${tc.elapsed_ms}ms` : ""}</div>`;
      html += `<div class="kv"><span class="k">returned:</span> ${tc.n_chunks} chunks · ${tc.n_facts} facts</div>`;
      html += `<h3>Sub-queries</h3><ul class="subquery-list">${(tc.sub_queries || []).map(q => `<li>${escapeHtml(q)}</li>`).join("")}</ul>`;
      html += `<h3>Sources</h3>`;
      if (!tc.sources.length) html += `<p class="dim">none</p>`;
      else {
        tc.sources.forEach(s => {
          html += `<div class="kv"><span class="k">[${escapeHtml(s.kind)}]</span> <a href="${escapeHtml(s.source_url || '#')}" target="_blank">${escapeHtml(s.source_title || s.source_id)}</a></div>`;
        });
      }
    } else if (d.type === "merger") {
      html = `<h3>Merged answer</h3><pre>${escapeHtml((d.answer || "").slice(0, 4000))}</pre>`;
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

  // ── Source cloud (force-directed) ──────────────────────────────────
  const cloudState = {
    nodes: [],     // {id, x, y, vx, vy, score, title, url, r}
    edges: [],     // {a, b, weight}
    running: false,
    dpr: 1,
    lastFetch: 0,
  };

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
      // Preserve positions for existing nodes
      const posMap = new Map(cloudState.nodes.map(n => [n.id, { x: n.x, y: n.y, vx: n.vx, vy: n.vy }]));
      const rect = canvas.getBoundingClientRect();
      cloudState.nodes = d.nodes.map(n => {
        const p = posMap.get(n.id);
        return {
          id: n.id, title: n.title, url: n.url,
          score: n.score, last_turn: n.last_turn, hits_total: n.hits_total,
          x: p ? p.x : Math.random() * rect.width,
          y: p ? p.y : Math.random() * rect.height,
          vx: p ? p.vx : 0, vy: p ? p.vy : 0,
          r: Math.max(3, Math.min(14, 3 + Math.sqrt((n.score || 1)) * 2)),
        };
      });
      const nodeIds = new Set(cloudState.nodes.map(n => n.id));
      cloudState.edges = (d.edges || []).filter(e => nodeIds.has(e.source) && nodeIds.has(e.target));
    } catch (e) { /* ignore */ }
  }

  function scoreColor(score) {
    // cold (blue-gray) → hot (saturated red)
    const t = Math.min(1, Math.max(0, (score - 0.5) / 12));
    // interpolate #607080 → #d9453a
    const c1 = [96, 112, 128], c2 = [217, 69, 58];
    const r = Math.round(c1[0] + (c2[0]-c1[0]) * t);
    const g = Math.round(c1[1] + (c2[1]-c1[1]) * t);
    const b = Math.round(c1[2] + (c2[2]-c1[2]) * t);
    return `rgb(${r},${g},${b})`;
  }

  function stepPhysics(rect) {
    const nodes = cloudState.nodes;
    const edges = cloudState.edges;
    // Repulsion
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const d2 = dx*dx + dy*dy + 0.1;
        const f = 400 / d2;
        const dd = Math.sqrt(d2);
        const fx = (dx / dd) * f, fy = (dy / dd) * f;
        a.vx -= fx; a.vy -= fy;
        b.vx += fx; b.vy += fy;
      }
    }
    // Attraction via edges
    for (const e of edges) {
      const a = nodes.find(n => n.id === e.source);
      const b = nodes.find(n => n.id === e.target);
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const dd = Math.sqrt(dx*dx + dy*dy + 0.01);
      const target = 80;
      const f = ((dd - target) / dd) * 0.05 * (e.weight || 1);
      a.vx += dx * f; a.vy += dy * f;
      b.vx -= dx * f; b.vy -= dy * f;
    }
    // Centering + damping
    const cx = rect.width / 2, cy = rect.height / 2;
    for (const n of nodes) {
      n.vx = (n.vx + (cx - n.x) * 0.002) * 0.85;
      n.vy = (n.vy + (cy - n.y) * 0.002) * 0.85;
      n.x += n.vx; n.y += n.vy;
      // Clamp inside
      n.x = Math.max(n.r + 2, Math.min(rect.width - n.r - 2, n.x));
      n.y = Math.max(n.r + 2, Math.min(rect.height - n.r - 2, n.y));
    }
  }

  function drawCloud() {
    const ctx = canvas.getContext("2d");
    const rect = canvas.getBoundingClientRect();
    ctx.setTransform(cloudState.dpr, 0, 0, cloudState.dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);

    // Edges first
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
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

  // Canvas click → nearest node → open in new tab
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
        `<div class="kv"><span class="k">id:</span> ${escapeHtml(nearest.id)}</div>` +
        `<div class="kv"><span class="k">title:</span> ${escapeHtml(nearest.title || "")}</div>` +
        `<div class="kv"><span class="k">score:</span> ${nearest.score.toFixed(2)}</div>` +
        `<div class="kv"><span class="k">last turn:</span> ${nearest.last_turn}</div>` +
        `<div class="kv"><span class="k">hits total:</span> ${nearest.hits_total}</div>` +
        (nearest.url ? `<h3>Link</h3><p><a href="${escapeHtml(nearest.url)}" target="_blank">${escapeHtml(nearest.url)}</a></p>` : "");
    }
  });

  // ── Event handlers ─────────────────────────────────────────────────
  Atlas.on("turn_event", () => {
    renderDAG();
    renderCost();
  });
  Atlas.on("turn_reset", () => {
    renderDAG();
    renderCost();
  });
  Atlas.on("view_change", async v => {
    if (v === "flow") {
      resizeCanvas();
      renderDAG();
      renderCost();
      // Refetch cloud when entering view
      await fetchCloud();
    }
  });
  window.addEventListener("resize", () => {
    resizeCanvas();
    if (Atlas.state.view === "flow") renderDAG();
  });

  // Initial load
  resizeCanvas();
  fetchCloud();
  requestAnimationFrame(loop);
  // Periodic cloud refresh
  setInterval(() => { if (Atlas.state.view === "flow") fetchCloud(); }, 15000);
})();
