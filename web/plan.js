// Plan view — renders business.md + /distill button + accept/reject modal.

(function() {
  const contentEl = document.getElementById("plan-content");
  const statusEl  = document.getElementById("plan-status");
  const distillBtn = document.getElementById("distill-btn");
  const modal = document.getElementById("distill-modal");
  const previewEl = document.getElementById("distill-preview");
  const acceptBtn = document.getElementById("distill-accept");
  const rejectBtn = document.getElementById("distill-reject");

  let currentBusiness = "";
  let currentProposal = "";

  async function loadBusiness() {
    try {
      const d = await (await fetch("/api/business")).json();
      currentBusiness = d.content || "";
      contentEl.innerHTML = marked.parse(currentBusiness || "# Business plan\n\n_(empty)_");
    } catch (e) {
      contentEl.innerHTML = `<em style="color:#ff6060">Error loading business.md: ${e.message}</em>`;
    }
  }

  async function runDistill() {
    distillBtn.disabled = true;
    statusEl.textContent = "distilling from conversation…";
    currentProposal = "";
    previewEl.textContent = "";
    modal.classList.add("open");
    try {
      await Atlas.sseFetch("/api/command", { name: "distill" }, ev => {
        if (ev.type === "distill_token") {
          currentProposal += ev.text;
          previewEl.textContent = currentProposal;
          previewEl.scrollTop = previewEl.scrollHeight;
        } else if (ev.type === "distill_done") {
          currentProposal = ev.proposed;
          previewEl.textContent = currentProposal;
        } else if (ev.type === "error") {
          previewEl.textContent = "Error: " + ev.message;
        }
      });
    } finally {
      distillBtn.disabled = false;
      statusEl.textContent = "distill complete — accept or reject below.";
    }
  }

  async function accept() {
    if (!currentProposal) return;
    acceptBtn.disabled = true;
    try {
      const r = await fetch("/api/business", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: currentProposal }),
      });
      if (r.ok) {
        modal.classList.remove("open");
        statusEl.textContent = "business.md updated.";
        await loadBusiness();
      } else {
        statusEl.textContent = `save failed: HTTP ${r.status}`;
      }
    } finally {
      acceptBtn.disabled = false;
    }
  }
  function reject() {
    modal.classList.remove("open");
    currentProposal = "";
    statusEl.textContent = "distill rejected.";
  }

  distillBtn.addEventListener("click", runDistill);
  acceptBtn.addEventListener("click", accept);
  rejectBtn.addEventListener("click", reject);
  modal.addEventListener("click", e => { if (e.target === modal) reject(); });

  Atlas.on("view_change", v => { if (v === "plan") loadBusiness(); });

  // Initial
  loadBusiness();
})();
