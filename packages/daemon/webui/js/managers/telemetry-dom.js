/** Shared DOM helpers for the Telemetry tab (#463, split out under #601):
 *  every section — telemetry-view.js and telemetry-view-code.js alike —
 *  builds its tables and figures out of these same few primitives, so a
 *  table in one section looks like a table in any other by construction,
 *  not by copying markup. */

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const fmt = (n) => (typeof n === "number" && Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "—");
export const pct = (n, total) => (total > 0 ? `${((n / total) * 100).toFixed(1)}%` : "—");
export const ms = (n) => (typeof n === "number" ? `${Math.round(n)} ms` : "—");
export const shortSession = (id) => (id.length > 12 ? `${id.slice(0, 8)}…` : id);

/** A cell with a proportional bar next to its number. */
export function barCell(n, max, mute = false) {
  const w = max > 0 ? Math.max(0, Math.min(100, (n / max) * 100)) : 0;
  const i = h("i", { class: mute ? "mute" : null });
  i.style.width = `${w}%`;
  return h("td", { class: "bar" }, h("span", { class: "tv-bar" }, i));
}

/** `extraClass` reaches a modifier like `snug` (hug content, don't stretch
 *  to 100%) onto one table without a new house pattern per call site. */
export function table(headers, rows, extraClass) {
  return h(
    "table",
    { class: extraClass ? `tv-table ${extraClass}` : "tv-table" },
    h("thead", null, h("tr", null, headers.map((t) => h("th", null, t)))),
    h("tbody", null, rows),
  );
}
export const td = (v, cls) => h("td", { class: cls ?? null }, v);
export const note = (text, warn = false) => h("p", { class: `tv-note${warn ? " warn" : ""}` }, text);
export const empty = (text) => h("p", { class: "tv-empty" }, text);
export const h3 = (text) => h("h3", { class: "tv-h3" }, text);
export const section = (title, question, ...body) =>
  h("section", { class: "tv-section" }, h("h2", { class: "section-title" }, title), h("p", { class: "tv-q" }, question), ...body);
