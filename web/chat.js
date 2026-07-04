// Chat view: input, send, message rendering with markdown + citation tooltips + inline cost.

(function() {
  const messagesEl = document.getElementById("messages");
  const inputEl = document.getElementById("input");
  const sendBtn = document.getElementById("send");

  marked.setOptions({ gfm: true, breaks: true });

  let sourcesByTurn = {};                  // sid → {source_title, snippet, source_url}
  let currentBubble = null;
  let currentMeta = null;
  let currentWrap = null;
  let currentFooter = null;

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  const escapeHtml = s => s.replace(/[&<>"']/g, c =>
    ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"}[c]));

  function renderMarkdown(text) {
    // Decorate [source::sub] and [web:...] citations
    const decorated = text.replace(
      /\[([A-Za-z0-9_\-\.]+::[A-Za-z0-9_\-\.: ]+?)\]|\[(web:[^\]]+?)\]/g,
      (_, sid, webid) => {
        const id = sid || webid;
        return `<span class="citation" data-sid="${id.replace(/"/g,'&quot;')}">[${id}]</span>`;
      }
    );
    return marked.parse(decorated);
  }

  function wireCitations(container) {
    container.querySelectorAll(".citation").forEach(node => {
      const sid = node.dataset.sid;
      const src = sourcesByTurn[sid];
      const content = src
        ? `<strong>${escapeHtml(src.source_title || src.source_name || sid)}</strong><br><br>` +
          escapeHtml((src.snippet || "").slice(0, 400)) +
          (src.source_url ? `<br><br><a href="${escapeHtml(src.source_url)}" target="_blank" style="color:#d9453a">${escapeHtml(src.source_url)}</a>` : "")
        : `<em>source ${escapeHtml(sid)} (no snippet cached)</em>`;
      tippy(node, {
        content, allowHTML: true, theme: "atlas",
        placement: "top", maxWidth: 380, interactive: true,
      });
    });
  }

  function appendUser(text) {
    const wrap = el("div", "msg user");
    wrap.appendChild(el("div", "bubble", text));
    messagesEl.appendChild(wrap);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function startAssistant() {
    const wrap = el("div", "msg assistant");
    const meta = el("div", "meta");
    meta.innerHTML = '<span class="status-line">…planning…</span>';
    const bubble = el("div", "bubble");
    const footer = el("div", "cost-footer");
    footer.style.display = "none";
    wrap.append(meta, bubble, footer);
    messagesEl.appendChild(wrap);
    currentWrap = wrap; currentMeta = meta; currentBubble = bubble; currentFooter = footer;
    sourcesByTurn = {};
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function renderCostFooter() {
    const t = Atlas.state.turn;
    if (!t.cost.calls.length) return;
    const groups = { plan: 0, worker: 0, merge: 0, web: 0 };
    for (const c of t.cost.calls) {
      const key = groups.hasOwnProperty(c.role) ? c.role : c.role;
      if (groups[key] === undefined) groups[key] = 0;
      groups[key] += c.dollars || 0;
    }
    const tags = [];
    if (groups.plan) tags.push(`plan <strong>$${groups.plan.toFixed(3)}</strong>`);
    if (groups.worker) tags.push(`workers <strong>$${groups.worker.toFixed(3)}</strong>`);
    if (groups.merge) tags.push(`merge <strong>$${groups.merge.toFixed(3)}</strong>`);
    currentFooter.innerHTML =
      `<span class="cost-tag">turn <strong>$${t.cost.total.toFixed(3)}</strong></span>` +
      tags.map(t => `<span class="cost-tag">${t}</span>`).join("");
    currentFooter.style.display = "";
  }

  function finalizeAssistant() {
    if (!currentBubble) return;
    const t = Atlas.state.turn;
    // Render final markdown
    currentBubble.innerHTML = renderMarkdown(t.answer_text || currentBubble.textContent);
    wireCitations(currentBubble);

    // Source list under the message
    if (t.sources && t.sources.length) {
      const s = el("div", "sources");
      s.appendChild(el("h4", null, `Sources (${t.sources.length})`));
      t.sources.forEach(src => {
        const line = el("div", "src");
        const title = src.source_title || src.source_name || src.source_id;
        line.innerHTML = `<a href="${src.source_url || '#'}" target="_blank">${escapeHtml(title)}</a> <span class="sid">${escapeHtml(src.source_id)}</span>`;
        s.appendChild(line);
      });
      currentBubble.after(s);
    }

    renderCostFooter();
    Atlas.refreshStatus();
    sendBtn.disabled = false;
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // Turn event handler → updates meta chips + streams tokens
  Atlas.on("turn_event", ev => {
    if (!currentBubble) return;
    switch (ev.type) {
      case "turn_start":
        currentMeta.querySelector(".status-line").textContent = `turn ${ev.turn} · planning…`;
        break;
      case "plan":
        currentMeta.innerHTML = "";
        ev.workers.forEach(w => {
          const chip = el("span", "worker", w.focus);
          chip.dataset.workerId = w.id;
          currentMeta.appendChild(chip);
        });
        break;
      case "tool_call_start": {
        const chip = currentMeta.querySelector(`.worker[data-worker-id="${ev.worker_id}"]`);
        if (chip) { chip.classList.add("working"); chip.textContent = `${chip.textContent} · fetching`; }
        break;
      }
      case "worker_done": {
        const chip = currentMeta.querySelector(`.worker[data-worker-id="${ev.id}"]`);
        if (chip) {
          chip.classList.remove("working");
          if (ev.error) chip.classList.add("error");
          else chip.classList.add("done");
          chip.textContent = `${ev.focus} · ${ev.n_sources}`;
        }
        break;
      }
      case "merge_start":
        currentMeta.appendChild(el("span", "worker working", "merging"));
        break;
      case "token":
        currentBubble.innerHTML = renderMarkdown(Atlas.state.turn.answer_text);
        messagesEl.scrollTop = messagesEl.scrollHeight;
        break;
      case "sources":
        ev.sources.forEach(s => { sourcesByTurn[s.source_id] = s; });
        break;
      case "cost_update":
        renderCostFooter();
        break;
      case "turn_done":
        finalizeAssistant();
        break;
      case "error":
        currentBubble.innerHTML = `<em style="color:#ff6060">Error: ${escapeHtml(ev.message)}</em>`;
        sendBtn.disabled = false;
        break;
    }
  });

  // ── Send handler ───────────────────────────────────────────────────
  async function send() {
    const query = inputEl.value.trim();
    if (!query) return;
    inputEl.value = "";
    sendBtn.disabled = true;

    // Slash-command intercept
    if (query.startsWith("/")) {
      const name = query.slice(1).split(/\s+/)[0].toLowerCase();
      if (["distill", "sources", "cost", "reset"].includes(name)) {
        appendUser(query);
        startAssistant();
        currentMeta.innerHTML = `<span class="status-line">/${name}…</span>`;
        try {
          let acc = "";
          await Atlas.sseFetch("/api/command", { name }, ev => {
            if (ev.type === "command_result") {
              acc = ev.markdown;
              currentBubble.innerHTML = renderMarkdown(acc);
            } else if (ev.type === "distill_token") {
              acc += ev.text;
              currentBubble.innerHTML = renderMarkdown(acc);
            } else if (ev.type === "distill_done") {
              // Save proposal for /plan view
              window._distillProposal = { proposed: ev.proposed, current: ev.current };
              currentBubble.innerHTML += `<br><br><em>Proposal ready — switch to Plan tab to review + accept.</em>`;
            } else if (ev.type === "error") {
              currentBubble.innerHTML = `<em style="color:#ff6060">Error: ${escapeHtml(ev.message)}</em>`;
            }
          });
        } finally {
          currentMeta.innerHTML = `<span class="status-line">/${name} done</span>`;
          sendBtn.disabled = false;
          Atlas.refreshStatus();
        }
        return;
      }
    }

    appendUser(query);
    Atlas.newTurnState(query);
    startAssistant();

    try {
      await Atlas.sseFetch("/api/chat", { query }, ev => Atlas.markTurnEvent(ev));
    } catch (e) {
      currentBubble.innerHTML = `<em style="color:#ff6060">Error: ${escapeHtml(e.message)}</em>`;
      sendBtn.disabled = false;
    }
  }

  sendBtn.addEventListener("click", send);
  inputEl.addEventListener("keydown", e => {
    // Plain Enter sends. Shift+Enter (or Cmd/Ctrl+Enter) inserts a newline.
    if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      send();
    }
  });
})();
