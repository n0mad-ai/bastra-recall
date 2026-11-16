// Tiny DOM helpers. Styles never go through the `style` attribute (CSP
// style-src 'self'); dynamic values are custom properties set via CSSOM.
const SVG_NS = "http://www.w3.org/2000/svg";

/** h("div.a.b", { on: {click}, vars: {"--x": "1px"}, attrs }, ...children) */
export function h(tag, props, ...children) {
  const [name, ...classes] = tag.split(".");
  const el = document.createElement(name || "div");
  if (classes.length) el.className = classes.join(" ");
  apply(el, props);
  append(el, children);
  return el;
}

export function s(tag, props, ...children) {
  const [name, ...classes] = tag.split(".");
  const el = document.createElementNS(SVG_NS, name);
  if (classes.length) el.setAttribute("class", classes.join(" "));
  apply(el, props);
  append(el, children);
  return el;
}

function apply(el, props) {
  if (!props) return;
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "on") for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === "vars") setVars(el, v);
    else if (k === "text") el.textContent = v;
    else if (k === "cls") el.classList.add(...String(v).split(" ").filter(Boolean));
    else if (k === "ref") v(el);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function setVars(el, vars) {
  for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, String(v));
}

/** 24×24 stroke icon from a path string. */
export function icon(d, cls = "") {
  return s(`svg${cls ? "." + cls : ""}`, { viewBox: "0 0 24 24", "aria-hidden": "true" }, s("path.ico", { d }));
}

export function clear(el) {
  el.replaceChildren();
  return el;
}
