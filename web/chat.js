// Atlas chat client. SSE stream + marked.js + tippy.js source hovers.

const messagesEl = document.getElementById("messages");
const inputEl = document.getElementById("input");
const sendBtn = document.getElementById("send");
const statusEl = document.getElementById("status");

let sourcesForTurn = {};  // source_id → {source_title, snippet, source_url}
let currentBubble = null;
let currentBuffer = "";

marked.setOptions({ gfm: true, breaks: true });

function refreshStatus() {
  fetch("/api/status").then(r => r.json()).then(s => {
    statusEl.textContent = `${s.sources_warm} sources warm · ${s.history_turns} turns`;
  }).catch(() => { statusEl.textContent = "server unreachable"; });
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function renderMarkdown(text) {
  // Replace [source_id] with clickable <span class="citation" data-sid="…"> BEFORE marked runs
  const decorated = text.replace(/\[([^\]\s]+?::[^\]]+?)\]|\[(web:[^\]]+?)\]/g,
    (_, sid, webid) => {
      const id = sid || webid;
      return `<span class="citation" data-sid="${id.replace(/"/g,'&quot;')}">[${id}]</span>`;
    });
  return marked.parse(decorated);
}

function wireCitationTooltips(container) {
  container.querySelectorAll(".citation").forEach(node => {
    const sid = node.dataset.sid;
    const src = sourcesForTurn[sid];
    const content = src
      ? `<strong>${src.source_title || src.source_name || sid}</strong><br><br>${escapeHtml((src.snippet || "").slice(0, 400))}${src.source_url ? `<br><br><a href="${src.source_url}" target="_blank" style="color:#22c55e">${src.source_url}</a>` : ""}`
      : `<em>source ${sid} (no snippet cached)</em>`;
    tippy(node, {
      content, allowHTML: true, theme: "atlas",
      placement: "top", maxWidth: 380, interactive: true,
    });
  });
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[c]);
}

function appendUserMessage(text) {
  const wrap = el("div", "msg user");
  const bubble = el("div", "bubble", text);
  wrap.appendChild(bubble);
  messagesEl.appendChild(wrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function startAssistantMessage() {
  const wrap = el("div", "msg assistant");
  const meta = el("div", "meta");
  meta.innerHTML = '<span class="status-line">…planning…</span>';
  const bubble = el("div", "bubble");
  wrap.append(meta, bubble);
  messagesEl.appendChild(wrap);
  currentBubble = bubble;
  currentBuffer = "";
  sourcesForTurn = {};
  return { wrap, meta, bubble };
}

function finalizeAssistant(wrap, sources) {
  currentBubble.innerHTML = renderMarkdown(currentBuffer);
  wireCitationTooltips(currentBubble);
  if (sources && sources.length) {
    const s = el("div", "sources");
    s.appendChild(el("h4", null, `Sources (${sources.length})`));
    sources.forEach(src => {
      const line = el("div", "src");
      line.innerHTML = `<a href="${src.source_url || '#'}" target="_blank">${escapeHtml(src.source_title || src.source_name || src.source_id)}</a> <span style="color:#555">${escapeHtml(src.source_id)}</span>`;
      s.appendChild(line);
    });
    wrap.appendChild(s);
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function sendMessage() {
  const query = inputEl.value.trim();
  if (!query) return;
  inputEl.value = "";
  sendBtn.disabled = true;

  appendUserMessage(query);
  const { wrap, meta, bubble } = startAssistantMessage();

  const resp = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });

  if (!resp.ok || !resp.body) {
    bubble.textContent = `Error: ${resp.status}`;
    sendBtn.disabled = false;
    return;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let finalSources = [];

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
      let ev;
      try { ev = JSON.parse(line.slice(6)); } catch { continue; }
      switch (ev.type) {
        case "status":
          meta.querySelector(".status-line").textContent = ev.message;
          break;
        case "plan":
          meta.innerHTML = "";
          ev.workers.forEach(w => {
            const chip = el("span", "worker", w.focus);
            meta.appendChild(chip);
          });
          break;
        case "worker_done": {
          const chips = meta.querySelectorAll(".worker");
          const chip = chips[ev.id];
          if (chip) {
            chip.textContent = `${ev.focus} · ${ev.n_sources}`;
            if (ev.error) chip.classList.add("error");
          }
          break;
        }
        case "token":
          currentBuffer += ev.text;
          currentBubble.innerHTML = renderMarkdown(currentBuffer);
          messagesEl.scrollTop = messagesEl.scrollHeight;
          break;
        case "sources":
          ev.sources.forEach(s => { sourcesForTurn[s.source_id] = s; });
          finalSources = ev.sources;
          break;
        case "done":
          finalizeAssistant(wrap, finalSources);
          refreshStatus();
          sendBtn.disabled = false;
          return;
        case "error":
          bubble.textContent = `Error: ${ev.message}`;
          sendBtn.disabled = false;
          return;
      }
    }
  }
  sendBtn.disabled = false;
}

sendBtn.addEventListener("click", sendMessage);
inputEl.addEventListener("keydown", e => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendMessage(); }
});

refreshStatus();
