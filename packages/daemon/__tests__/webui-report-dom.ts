// A small fake DOM for the UI v2 task report tests: just what dom.js h(), the
// Markdown output, the note decoration and the reading view use. The real
// modules run in a VM context with this h() in place of the browser's.

export class Node_ {
  tagName: string;
  children: Node_[] = [];
  parent: Node_ | null = null;
  attrs: Record<string, string> = {};
  listeners: Record<string, Array<(e?: unknown) => unknown>> = {};
  own = "";
  value = "";
  readOnly = false;
  disabled = false;
  hidden = false;
  scrollTop = 0;
  selectionStart = 0;
  selectionEnd = 0;
  selectionDirection = "none";
  dataset: Record<string, string> = {};
  clientWidth = 0;
  style = { setProperty() {}, height: "" };
  private set = new Set<string>();
  classList = {
    add: (...c: string[]) => c.forEach((x) => this.set.add(x)),
    remove: (...c: string[]) => c.forEach((x) => this.set.delete(x)),
    toggle: (c: string, on: boolean) => (on ? this.set.add(c) : this.set.delete(c)),
    contains: (c: string) => this.set.has(c),
  };
  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
  /** 3 for a text node, 1 for an element, as in the browser. */
  get nodeType() {
    return this.tagName === "#TEXT" ? 3 : 1;
  }
  get className() {
    return [...this.set].join(" ");
  }
  set className(v: string) {
    this.set = new Set(v.split(" ").filter(Boolean));
  }
  get textContent(): string {
    return this.own + this.children.map((c) => c.textContent).join("");
  }
  set textContent(v: string) {
    this.own = String(v);
    this.children = [];
  }
  get isConnected() {
    return false;
  }
  get firstChild() {
    return this.children[0] ?? null;
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  addEventListener(ev: string, fn: (e?: unknown) => unknown) {
    (this.listeners[ev] ||= []).push(fn);
  }
  get childNodes() {
    return [...this.children];
  }
  replaceChildren(...nodes: Node_[]) {
    this.own = "";
    this.children = [];
    this.append(...nodes);
  }
  append(...nodes: Array<Node_ | string>) {
    for (const n of nodes) {
      const node = typeof n === "string" ? Object.assign(new Node_("#text"), { own: n }) : n;
      node.parent = this;
      this.children.push(node);
    }
  }
  after(node: Node_) {
    const siblings = this.parent!.children;
    siblings.splice(siblings.indexOf(this) + 1, 0, node);
    node.parent = this.parent;
  }
  all(): Node_[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  contains(node: unknown) {
    return node === this || this.all().includes(node as Node_);
  }
  querySelectorAll(sel: string) {
    const [outer, inner] = sel.split(" ").map((s) => s.toUpperCase());
    return this.all()
      .filter((n) => n.tagName === outer)
      .flatMap((n) => n.all().filter((c) => c.tagName === inner));
  }
  find(cls: string) {
    return this.all().filter((n) => n.classList.contains(cls));
  }
  click() {
    return Promise.all((this.listeners.click ?? []).map((fn) => fn()));
  }
  setSelectionRange(start: number, end: number, direction = "none") {
    Object.assign(this, { selectionStart: start, selectionEnd: end, selectionDirection: direction });
  }
  /** Where the element stands (getBoundingClientRect().top), set by a test. */
  top = 0;
  /** How often scrollIntoView() was called. */
  scrolled = 0;
  getBoundingClientRect() {
    return { top: this.top };
  }
  removeAttribute(k: string) {
    delete this.attrs[k];
  }
  scrollIntoView() {
    this.scrolled++;
  }
  focus() {}
}

const present = (v: unknown) => v !== undefined && v !== null && v !== false;

function applyProp(el: Node_, k: string, v: any) {
  if (k === "on") for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn as never);
  else if (k === "text") el.textContent = v;
  else if (k === "cls") el.classList.add(...String(v).split(" ").filter(Boolean));
  else el.setAttribute(k, String(v));
}

export function h(tag: string, props: Record<string, any> | null, ...children: unknown[]) {
  const [name, ...classes] = tag.split(".");
  const el = new Node_(name || "div");
  if (classes.length) el.className = classes.join(" ");
  for (const [k, v] of Object.entries(props ?? {})) if (present(v)) applyProp(el, k, v);
  for (const c of children.flat(Infinity as 1)) if (present(c)) el.append(c as Node_);
  return el;
}
