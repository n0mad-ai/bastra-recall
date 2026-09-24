/** Import dialog (#208) — the visual sibling of `bastra import`: paste (or
 *  pick a file with) a memory list from another AI tool; candidates are
 *  staged in import-review.md via POST /ui/import for the next session to
 *  distill with the user. Staging only — the dialog never saves memories.
 *
 *  @param {object} deps
 *  @param {HTMLElement} deps.modal    the #import-modal container
 *  @param {HTMLElement} deps.opener   the topbar button that opens it */

import { postImport, postImportVault } from "../graph-data.js";

const $ = (sel) => document.querySelector(sel);

// per-source guidance: where THIS tool keeps its memory list
const SOURCE_HINTS = {
  chatgpt:
    "ChatGPT: Settings → Personalization → Manage memories — copy the list and paste it here. " +
    "Full chat history (conversations.json)? Run `bastra import <file>` in a terminal instead.",
  claude:
    "Claude: Settings → Memory — copy your memory text and paste it here. " +
    "Full chat history (conversations.json)? Run `bastra import <file>` in a terminal instead.",
  gemini: "Gemini: Settings → Saved Info — copy the entries and paste them here.",
  text: "Any plain list works — one fact per line, bullets and numbering are fine.",
};

export function createImportDialog({ modal, opener }) {
  const textEl = $("#import-text");
  const statusEl = $("#import-status");
  const stageBtn = $("#import-stage");
  const fileInput = $("#import-file");
  const sourceHintEl = $("#import-source-hint");
  const nextEl = $("#import-next");
  let source = "chatgpt";
  let busy = false;
  sourceHintEl.textContent = SOURCE_HINTS[source];

  function setStatus(text, cls = "") {
    statusEl.textContent = text;
    statusEl.className = cls;
  }

  function open() {
    modal.hidden = false;
    setStatus("");
    nextEl.hidden = true;
    document.addEventListener("keydown", onKey);
    textEl.focus();
  }

  function close() {
    modal.hidden = true;
    document.removeEventListener("keydown", onKey);
  }

  function onKey(ev) {
    if (ev.key === "Escape") close();
  }

  // #310: staged candidates are actionable state — surface them on the map.
  // Badge on the opener, fed by GET /hook/import (same loopback origin);
  // polled so CLI-side staging shows up without a reload.
  const badgeEl = $("#import-badge");
  const IDLE_TITLE = opener.title;
  async function refreshBadge() {
    try {
      const r = await fetch("/hook/import");
      if (!r.ok) return;
      const d = await r.json();
      const n = typeof d.open === "number" ? d.open : 0;
      badgeEl.hidden = n === 0;
      badgeEl.textContent = n > 99 ? "99+" : String(n);
      opener.title =
        n > 0
          ? `Import memories — ${n} staged candidate(s) waiting for review; open for the next step`
          : IDLE_TITLE;
    } catch {
      /* daemon busy — next poll */
    }
  }
  refreshBadge();
  setInterval(refreshBadge, 30_000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshBadge();
  });

  opener.addEventListener("click", open);
  $("#import-cancel").addEventListener("click", close);
  modal.addEventListener("pointerdown", (ev) => {
    if (ev.target === modal) close(); // click outside the box = close
  });

  $("#import-source").addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-source]");
    if (!b) return;
    source = b.dataset.source;
    sourceHintEl.textContent = SOURCE_HINTS[source];
    $("#import-source")
      .querySelectorAll("button")
      .forEach((x) => x.classList.toggle("active", x === b));
  });

  $("#import-choose").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (!file) return;
    // #313: bastra's own vault files are never import sources — the server
    // also refuses by content, this just fails earlier with the name visible
    if (/^(import-review|vault-care|report)\.md$/i.test(file.name)) {
      setStatus(`${file.name} is written by bastra itself — not an import source`, "err");
      return;
    }
    textEl.value = await file.text();
    // filename hints the source, same heuristics as the CLI
    const name = file.name.toLowerCase();
    const hinted = /chatgpt|openai/.test(name)
      ? "chatgpt"
      : /claude|anthropic/.test(name)
        ? "claude"
        : /gemini|takeout/.test(name)
          ? "gemini"
          : null;
    if (hinted) $(`#import-source button[data-source="${hinted}"]`)?.click();
    setStatus(`loaded ${file.name}`);
  });

  stageBtn.addEventListener("click", async () => {
    const text = textEl.value.trim();
    if (!text || busy) return;
    busy = true;
    stageBtn.disabled = true;
    setStatus("staging…");
    try {
      const r = await postImport(text, source);
      setStatus(
        `✓ ${r.staged} staged` +
          (r.skipped_duplicates > 0 ? ` · ${r.skipped_duplicates} duplicate(s) skipped` : "") +
          ` · ${r.open_total} open`,
        "ok",
      );
      // #309: name the next action instead of leaving the user standing there
      nextEl.hidden = false;
      refreshBadge(); // #310: the badge mirrors the new open count immediately
      textEl.value = "";
    } catch (err) {
      setStatus(err.message, "err");
    } finally {
      busy = false;
      stageBtn.disabled = false;
    }
  });

  // Folder import (#215): a whole memory folder → its own isolated set, no
  // review. The daemon reads the path locally (loopback), so a plain text
  // path is all we need — no file upload.
  const vaultDirEl = $("#import-vault-dir");
  const vaultLabelEl = $("#import-vault-label");
  const vaultRunBtn = $("#import-vault-run");
  const vaultStatusEl = $("#import-vault-status");

  // folder picker: navigable directory list from GET /ui/fs (dirs only) —
  // click descends, ".." ascends, "Use this folder" fills the path field
  const browserEl = $("#import-vault-browser");
  const browserPathEl = $("#import-vault-browser-path");
  const browserListEl = $("#import-vault-browser-list");
  let browsePath = null;

  async function loadBrowser(path) {
    const res = await fetch(`/ui/fs${path ? `?path=${encodeURIComponent(path)}` : ""}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `browse failed: ${res.status}`);
    browsePath = data.path;
    browserPathEl.textContent = data.path;
    browserListEl.innerHTML = "";
    if (data.parent) {
      const up = document.createElement("li");
      up.textContent = "..";
      up.className = "up";
      up.addEventListener("click", () => loadBrowser(data.parent).catch((e) => setVaultStatus(e.message, "err")));
      browserListEl.append(up);
    }
    for (const d of data.dirs) {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = d.name;
      li.append(name);
      if (d.md > 0) {
        const count = document.createElement("span");
        count.className = "count";
        count.textContent = `${d.md} md`;
        li.append(count);
      }
      li.addEventListener("click", () => loadBrowser(d.path).catch((e) => setVaultStatus(e.message, "err")));
      browserListEl.append(li);
    }
  }

  $("#import-vault-browse").addEventListener("click", () => {
    if (!browserEl.hidden) {
      browserEl.hidden = true;
      return;
    }
    browserEl.hidden = false;
    loadBrowser(vaultDirEl.value.trim() || null).catch(() =>
      loadBrowser(null).catch((e) => setVaultStatus(e.message, "err")),
    );
  });

  $("#import-vault-use").addEventListener("click", () => {
    if (browsePath) vaultDirEl.value = browsePath;
    browserEl.hidden = true;
  });

  function setVaultStatus(text, cls = "") {
    vaultStatusEl.textContent = text;
    vaultStatusEl.className = cls;
  }

  vaultRunBtn.addEventListener("click", async () => {
    const dir = vaultDirEl.value.trim();
    if (!dir || busy) return;
    busy = true;
    vaultRunBtn.disabled = true;
    setVaultStatus("importing…");
    try {
      const r = await postImportVault(dir, vaultLabelEl.value.trim() || undefined);
      setVaultStatus(
        `✓ imported ${r.imported}/${r.scanned} into ${r.folder}/` +
          (r.skipped > 0 ? ` · ${r.skipped} skipped` : "") +
          // #530 follow-up: source gone, memory kept — nothing removed.
          (r.orphaned > 0 ? ` · ${r.orphaned} orphaned (source gone, kept)` : ""),
        "ok",
      );
    } catch (err) {
      setVaultStatus(err.message, "err");
    } finally {
      busy = false;
      vaultRunBtn.disabled = false;
    }
  });

  return { open };
}
