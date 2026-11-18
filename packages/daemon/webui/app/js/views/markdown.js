// Mini Markdown (old map inspector), built as DOM nodes, text only via textContent. One renderer
// for every reader: the memory browser (views/memory-browser.js, which re-exports it), the task
// reports (sections/tasks-reports.js) and the agent window's answers (agent.js). Headings become
// h3, list items one flat ul, fenced code a pre, a free-standing ---/***/___ line a thin rule; inside
// a line: [[wiki links]] to memories, `code`, **bold**, *emphasis*, [links](https://…) and bare
// web addresses. HTML comments (auto-related markers) are bookkeeping and dropped.
import { h } from "../dom.js";
import { vault } from "./vault-data.js";

const INLINE =
  /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]|`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\((https?:[^)\s]+)\)|(https?:\/\/[^\s<)]+)|(^|[^*\w])\*([^*\s][^*]*)\*/g;

/** [[id]] or [[id|label]]: a span, not a button, as it has to wrap inside running text; a link
 *  that names no memory in the vault stays a dead mark without action. */
function wikiLink(raw, label, onLink) {
  const id = raw.trim(),
    target = vault()?.byId.get(id);
  return h("span.mb-wl", {
    cls: target ? "" : "is-dead",
    text: label ?? target?.title ?? raw,
    title: id,
    role: target ? "link" : null,
    tabindex: target ? "0" : null,
    on: target
      ? {
          click: () => onLink(id),
          keydown: (e) => {
            if (e.key === "Enter") onLink(id);
          },
        }
      : null,
  });
}

function inline(text, onLink) {
  const out = [];
  let last = 0,
    m;
  INLINE.lastIndex = 0;
  while ((m = INLINE.exec(text))) {
    let start = m.index;
    if (m[9] !== undefined) {
      start += m[8].length;
    }
    if (start > last) out.push(text.slice(last, start));
    if (m[1] !== undefined) out.push(wikiLink(m[1], m[2], onLink));
    else if (m[3] !== undefined) out.push(h("code", { text: m[3] }));
    else if (m[4] !== undefined) out.push(h("strong", { text: m[4] }));
    else if (m[5] !== undefined) out.push(h("a", { href: m[6], target: "_blank", rel: "noopener", text: m[5] }));
    else if (m[7] !== undefined) out.push(h("a", { href: m[7], target: "_blank", rel: "noopener", text: m[7] }));
    else out.push(h("em", { text: m[9] }));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function markdown(md, onLink) {
  const out = [];
  let list = null,
    fence = null,
    afterBlank = true;
  // HTML comments (auto-related markers) are bookkeeping, not text
  for (const raw of md.replace(/<!--[\s\S]*?-->/g, "").split("\n")) {
    const line = raw.trimEnd(),
      blankBefore = afterBlank;
    afterBlank = !line.trim();
    if (/^```/.test(line)) {
      if (fence) {
        out.push(h("pre", { text: fence.join("\n") }));
        fence = null;
      } else {
        list = null;
        fence = [];
      }
      continue;
    }
    if (fence) {
      fence.push(raw);
      continue;
    }
    const hd = /^(#{1,6})\s+(.*)$/.exec(line),
      li = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
    // a thematic break only where it stands free: right under a text line, --- stays that text
    if (blankBefore && /^ {0,3}([-*_])(?:[ \t]*\1){2,}$/.test(line)) {
      list = null;
      out.push(h("hr"));
    } else if (hd) {
      list = null;
      out.push(h("h3", null, inline(hd[2], onLink)));
    } else if (li) {
      if (!list) {
        list = h("ul");
        out.push(list);
      }
      list.append(h("li", null, inline(li[1], onLink)));
    } else if (!line.trim()) list = null;
    else {
      list = null;
      out.push(h("p", null, inline(line, onLink)));
    }
  }
  if (fence) out.push(h("pre", { text: fence.join("\n") }));
  return out;
}
