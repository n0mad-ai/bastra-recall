// Mini Markdown (old map inspector), built as DOM nodes, text only via textContent. One renderer
// for the memory reader, task reports and agent answers. Headings become
// h3, list items one flat ul, fenced and indented code a pre (which lines are code: code-lines.js), a
// free-standing ---/***/___ line a thin rule; inside a line: [[wiki links]] to memories, `code`,
// **bold**, *emphasis*, [links](https://…) and bare web addresses. HTML comments (auto-related
// markers) are bookkeeping and dropped.
import { h } from "../dom.js";
import { vault } from "./vault-data.js";
import { inlineMatches } from "./inline-scan.js";
import { codeLines } from "./code-lines.js";

/** [[id]] or [[id|label]]: a span, not a button, as it has to wrap inside running text; a link
 *  that names no memory in the vault stays a dead mark without action. */
function wikiLink(raw, label, onLink) {
  const id = raw.trim(),
    target = vault()?.byId.get(id);
  return h("span.mb-wl", {
    cls: target ? "" : "is-dead",
    text: label ?? target?.title ?? id,
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
  let last = 0;
  for (const { index, end, groups: m } of inlineMatches(text)) {
    let start = index;
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
    last = end;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function markdown(md, onLink) {
  const out = [];
  let list = null,
    code = null,
    afterBlank = true;
  const flush = () => {
    if (code) out.push(h("pre", { text: code.join("\n") }));
    code = null;
  };
  // HTML comments (auto-related markers) are bookkeeping, not text
  const lines = md.replace(/<!--[\s\S]*?-->/g, "").split("\n"),
    kinds = codeLines(lines);
  for (const [i, raw] of lines.entries()) {
    const line = raw.trimEnd(),
      blankBefore = afterBlank,
      kind = kinds[i];
    afterBlank = !line.trim();
    if (kind?.fence) {
      flush();
      if (kind.fence === "open") code = [];
      list = null;
      continue;
    }
    if (kind) {
      if (!code) code = [];
      code.push(kind.code);
      list = null;
      continue;
    }
    flush();
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
  flush();
  return out;
}
