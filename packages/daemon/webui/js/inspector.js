/** Inspector panel: full memory body with clickable wikilinks, or the
 *  "unwritten note" view for ghosts. Markdown rendering is a deliberate
 *  mini-renderer (paragraphs, headings, lists, bold/italic/code, links,
 *  wikilinks) — enough for memory bodies, no vendored parser.
 *
 *  XSS policy: every string from the vault is HTML-escaped via esc() BEFORE
 *  the inline pass; inline() only introduces tags it constructs itself, with
 *  escaped attribute values and http(s)-restricted hrefs. Raw HTML in a
 *  memory body renders as text, never as markup. */

import { fetchNode, HEAT_MIN_WEIGHT } from "./graph-data.js";

const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** inline markdown on an already-escaped string */
function inline(s, known) {
  return s
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, id, label) => {
      const dead = known.has(id) ? "" : " dead";
      return `<button class="wikilink${dead}" data-link="${esc(id)}">${esc(label ?? id)}</button>`;
    })
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, `<a href="$2" target="_blank" rel="noopener">$1</a>`)
    .replace(/(^|\s)(https?:\/\/[^\s<]+)/g, `$1<a href="$2" target="_blank" rel="noopener">$2</a>`);
}

function renderMarkdown(md, known) {
  const out = [];
  let list = null;
  const closeList = () => {
    if (list) {
      out.push(`<ul>${list.join("")}</ul>`);
      list = null;
    }
  };
  for (const raw of md.split("\n")) {
    const line = raw.trimEnd();
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    const li = /^\s*[-*]\s+(.*)$/.exec(line);
    if (h) {
      closeList();
      out.push(`<h3>${inline(esc(h[2]), known)}</h3>`);
    } else if (li) {
      (list ??= []).push(`<li>${inline(esc(li[1]), known)}</li>`);
    } else if (line.trim() === "") {
      closeList();
      out.push("");
    } else {
      closeList();
      out.push(`<p>${inline(esc(line), known)}</p>`);
    }
  }
  closeList();
  return out.join("\n");
}

export function createInspector(el, contentEl, { knownIds, onNavigate, clusterColorOf, getCare, onAnnotate }) {
  let current = null; // node currently shown
  let careKind = null; // selected flag kind while composing

  const close = () => {
    el.hidden = true;
    current = null;
  };

  el.querySelector("#inspector-close").addEventListener("click", close);

  contentEl.addEventListener("click", async (ev) => {
    const link = ev.target.closest("button.wikilink");
    if (link) {
      onNavigate?.(link.dataset.link);
      return;
    }
    const kindBtn = ev.target.closest("button.care-kind");
    if (kindBtn && current) {
      careKind = kindBtn.dataset.kind;
      contentEl.querySelectorAll(".care-kind").forEach((b) => b.classList.toggle("active", b === kindBtn));
      contentEl.querySelector(".care-compose").hidden = false;
      contentEl.querySelector(".care-note").focus();
      return;
    }
    const submit = ev.target.closest("button.care-submit");
    if (submit && current) {
      if (!careKind) {
        // the compose box is hidden until a kind is picked (care.css [hidden]
        // guard); if that guard is ever bypassed, don't swallow the note silently
        submit.textContent = "pick a flag kind first";
        return;
      }
      const note = contentEl.querySelector(".care-note").value.trim();
      submit.disabled = true;
      submit.textContent = "flagging…";
      try {
        await onAnnotate?.(current.id, careKind, note);
        show(current); // re-render with the fresh flag list
      } catch {
        submit.disabled = false;
        submit.textContent = "failed — retry";
      }
      return;
    }
    // "mark as skill" (#215): declare the ghost target as living on another
    // surface — it joins the skills ring on the next graph load.
    const skillBtn = ev.target.closest("button.skill-declare");
    if (skillBtn && current) {
      skillBtn.disabled = true;
      skillBtn.textContent = "declaring…";
      try {
        const res = await fetch("/ui/skills", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: current.id }),
        });
        if (!res.ok) throw new Error(String(res.status));
        skillBtn.textContent = "✓ declared — reloading…";
        setTimeout(() => location.reload(), 600);
      } catch {
        skillBtn.disabled = false;
        skillBtn.textContent = "failed — retry";
      }
    }
  });

  /** The vault-care block: existing open flags + compose row. Flags are
   *  worked off later in an AI session — the map never edits memories. */
  function careBlock(node) {
    const open = (getCare?.(node.id) ?? []).filter((a) => !a.done);
    const existing = open.length
      ? `<ul class="care-list">${open
          .map((a) => `<li><span class="care-badge">${esc(a.kind)}</span><span>${esc(a.note || "—")}</span><span class="care-date">${esc(a.date)}</span></li>`)
          .join("")}</ul>`
      : "";
    const kinds = node.kind === "ghost" ? ["write", "note"] : ["delete", "edit", "note"];
    return `
      <div class="insp-section-title">Vault care</div>
      ${existing}
      <div class="care-kinds">${kinds
        .map((k) => `<button class="care-kind" data-kind="${k}">${k}</button>`)
        .join("")}</div>
      <div class="care-compose" hidden>
        <textarea class="care-note" rows="2" maxlength="500" placeholder="what should happen with this note?"></textarea>
        <button class="care-submit">Flag for session</button>
      </div>`;
  }

  /** Was die Karte über dieses Memory behauptet, in Worten (#227).
   *
   *  zzallirog: der Renderer „führt die Zahl auf, statt sie zu berichten" — ein
   *  heller Knoten war nicht von einem zu unterscheiden, der nur hell ist, weil
   *  sonst nichts berührt wurde. `heat` ist ein ANTEIL am wärmsten Memory
   *  dieses Vaults, also nur innerhalb dieses Bildes lesbar; die Zahlen
   *  dahinter sind es absolut. Deshalb stehen beide da, und die rohen zuerst.
   *
   *  Ohne Kontakt bleibt die Zeile weg — eine 0 zu behaupten wäre auch eine
   *  Aussage, und zwar eine, die niemand gefragt hat. */
  function demandLine(node) {
    const r = node.reach;
    if (!r || !r.weight) return "";
    const parts = [];
    if (r.loaded) parts.push(`${r.loaded}× geladen`);
    if (r.acted_on) parts.push(`${r.acted_on}× angewendet`);
    if (r.last_at) {
      const days = (Date.now() - Date.parse(r.last_at)) / 86400000;
      parts.push(
        days < 1 ? "zuletzt heute" : days < 2 ? "zuletzt gestern" : `zuletzt vor ${Math.round(days)} Tagen`,
      );
    }
    // Der Anteil nur, wenn die Karte ihn auch zeichnet — sonst erklärt die
    // Zeile ein Leuchten, das gar nicht da ist.
    const share =
      typeof node.heat === "number" && node.heat > 0 && r.weight >= HEAT_MIN_WEIGHT
        ? ` · ${Math.round(node.heat * 100)}% der wärmsten hier`
        : "";
    return `<div class="insp-meta">${esc(parts.join(" · "))}${share}</div>`;
  }

  function kicker(node) {
    const kindLabel = node.kind === "ghost" ? "unwritten" : node.kind === "skill" ? "skill" : node.type;
    return `<div class="insp-kicker">
      <span class="dot" data-color="${esc(clusterColorOf(node))}"></span>
      <span>${esc(node.cluster)}</span><span>·</span><span>${esc(kindLabel)}</span>
    </div>`;
  }

  function chips(items, accentFirst = false) {
    if (!items.length) return "";
    return `<div class="chips">${items
      .map((t, i) => `<span class="chip${accentFirst && i === 0 ? " accent" : ""}">${esc(t)}</span>`)
      .join("")}</div>`;
  }

  function linkList(title, ids) {
    if (!ids?.length) return "";
    const lis = ids
      .map((id) => `<li><button class="wikilink${knownIds.has(id) ? "" : " dead"}" data-link="${esc(id)}">${esc(id)}</button></li>`)
      .join("");
    return `<div class="insp-section-title">${title}</div><ul class="link-list">${lis}</ul>`;
  }

  // The CSP forbids inline style attributes (style-src 'self'), so a dot's
  // colour travels as data-color and is set through the CSSOM after insertion.
  const content = {
    set html(html) {
      contentEl.innerHTML = html;
      for (const dot of contentEl.querySelectorAll(".dot[data-color]")) dot.style.background = dot.dataset.color;
    },
  };

  async function show(node) {
    el.hidden = false;
    current = node;
    careKind = null;

    if (node.kind === "ghost") {
      content.html = `
        ${kicker(node)}
        <div class="insp-title">${esc(node.title)}</div>
        <div class="ghost-note">This note doesn't exist yet — it only lives as a link target.
        ${node.bridge ? "Several clusters point here: a connection worth writing down." : "Following the links below shows who expects it."}</div>
        ${node.bridge ? chips(node.bridge) : ""}
        ${linkList("Linked from", node.linked_by)}
        <div class="insp-section-title">Not a note?</div>
        <div class="ghost-note">If this id is a skill or doc living on another surface, declare it —
        it becomes a solid node in the skills ring instead of an unwritten ghost.</div>
        <button class="skill-declare">Mark as skill</button>
        ${careBlock(node)}
      `;
      return;
    }

    if (node.kind === "skill") {
      content.html = `
        ${kicker(node)}
        <div class="insp-title">${esc(node.title)}</div>
        <div class="ghost-note">Declared skill — it lives on another surface; the vault only references
        it. ${esc(node.summary || "")}</div>
        ${node.bridge ? chips(node.bridge) : ""}
        ${linkList("Linked from", node.linked_by)}
        <div class="insp-meta">undeclare via <code>bastra skills remove ${esc(node.id)}</code></div>
      `;
      return;
    }

    content.html = `${kicker(node)}<div class="insp-title">${esc(node.title)}</div><div class="insp-loading">loading…</div>`;
    const full = await fetchNode(node.id);
    if (el.hidden || current !== node) return; // closed or replaced while loading
    if (!full) {
      content.html = `${kicker(node)}<div class="insp-title">${esc(node.title)}</div>
        <div class="ghost-note">Body could not be loaded.</div>`;
      return;
    }
    content.html = `
      ${kicker(node)}
      <div class="insp-title">${esc(full.title)}</div>
      ${chips([full.scope, ...full.tags], true)}
      <div class="insp-meta">updated ${esc(full.updated)}${full.source ? ` · ${esc(full.source)}` : ""}</div>
      ${demandLine(node)}
      <div class="insp-body">${renderMarkdown(full.body, knownIds)}</div>
      ${node.bridge ? `<div class="insp-section-title">Bridges into</div>${chips(node.bridge)}` : ""}
      ${linkList("Connections", full.related)}
      ${careBlock(node)}
    `;
    contentEl.scrollTop = 0;
  }

  return { show, close, isOpen: () => !el.hidden };
}
