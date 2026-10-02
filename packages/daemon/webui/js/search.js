/** Topbar search: type-ahead over the loaded nodes, Enter/click flies the
 *  camera to the hit and opens the inspector. */

import { searchNodes } from "./graph-data.js";

const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function createSearch(input, resultsEl, nodes, { colorOf, onPick, aiSearch, onOpenChange }) {
  let items = []; // [{node, ai}]
  let agentItems = []; // copilot finds — pinned on top until the next query
  let active = -1;
  let seq = 0; // guards stale AI responses
  let emptyOk = false; // an active sentence query keeps the box open at 0 hits

  const all = () => [...agentItems, ...items];

  function setOpen(open) {
    if (resultsEl.hidden === !open) return;
    resultsEl.hidden = !open;
    onOpenChange?.(open);
  }

  function hide() {
    setOpen(false);
    active = -1;
  }

  function render() {
    const list = all();
    if (!list.length && !emptyOk) {
      hide();
      return;
    }
    // labelled groups + a per-row AI badge, so the source of every hit
    // stays readable even while scrolling past the group header
    let html = "";
    let agentDividerDone = false;
    let directDividerDone = false;
    let aiDividerDone = false;
    list.forEach((it, i) => {
      if (it.agent && !agentDividerDone) {
        html += `<li class="divider ai">agent found</li>`;
        agentDividerDone = true;
      }
      if (!it.ai && !it.agent && !directDividerDone) {
        html += `<li class="divider">matches</li>`;
        directDividerDone = true;
      }
      if (it.ai && !aiDividerDone) {
        html += `<li class="divider ai">AI recall — semantic</li>`;
        aiDividerDone = true;
      }
      html += `<li data-i="${i}" class="${i === active ? "active" : ""}${it.ai ? " ai-row" : ""}${it.agent ? " agent-row" : ""}">
        <span class="dot" data-color="${esc(colorOf(it.node))}"></span>
        <span class="r-title">${esc(it.node.title)}</span>
        ${it.ai || it.agent ? `<span class="ai-badge">AI</span>` : ""}
        <span class="r-type">${esc(it.node.kind === "ghost" ? "unwritten" : it.node.type)}</span>
      </li>`;
    });
    if (!list.length) html = `<li class="divider">no matches — ask the copilot →</li>`;
    resultsEl.innerHTML = html;
    // style-src 'self' blocks inline style attributes: colour through the CSSOM.
    for (const dot of resultsEl.querySelectorAll(".dot[data-color]")) dot.style.background = dot.dataset.color;
    setOpen(true);
  }

  function pick(i) {
    const it = all()[i];
    if (!it) return;
    hide();
    input.blur();
    onPick?.(it.node);
  }

  let debounce = 0;
  input.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(async () => {
      const q = input.value;
      const mySeq = ++seq;
      const direct = searchNodes(nodes, q);
      items = direct.map((n) => ({ node: n, ai: false }));
      agentItems = []; // a new query supersedes the copilot's last finds
      emptyOk = q.trim().length >= 3; // sentence typed → keep the box open
      active = items.length ? 0 : -1;
      render();
      // semantic pass: full sentences welcome — daemon recall (BM25+vectors)
      if (aiSearch && q.trim().length >= 3) {
        const hits = await aiSearch(q).catch(() => []);
        if (mySeq !== seq) return; // a newer query took over
        const seen = new Set(direct.map((n) => n.id));
        const extra = hits.filter((n) => !seen.has(n.id)).map((n) => ({ node: n, ai: true }));
        if (extra.length) {
          items = [...items, ...extra];
          if (active === -1) active = 0;
          render();
        }
      }
    }, 160);
  });

  input.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      const n = all().length;
      if (!n) return;
      active = (active + (ev.key === "ArrowDown" ? 1 : n - 1)) % n;
      render();
    } else if (ev.key === "Enter") {
      pick(active >= 0 ? active : 0);
    } else if (ev.key === "Escape") {
      hide();
      input.blur();
    }
  });

  resultsEl.addEventListener("pointerdown", (ev) => {
    const li = ev.target.closest("li[data-i]");
    if (li) {
      ev.preventDefault();
      pick(Number(li.dataset.i));
    }
  });

  document.addEventListener("click", (ev) => {
    if (!resultsEl.hidden && !ev.target.closest("#searchbox")) hide();
  });

  // "/" focuses the search from anywhere
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "/" && document.activeElement !== input) {
      ev.preventDefault();
      input.focus();
      input.select();
    }
  });

  return {
    /** Pin the copilot's finds on top of the list, highlighted. */
    setAgentHits(nodeList) {
      agentItems = nodeList.map((n) => ({ node: n, agent: true }));
      if (agentItems.length) {
        emptyOk = true;
        active = 0;
        render();
      }
    },
  };
}
