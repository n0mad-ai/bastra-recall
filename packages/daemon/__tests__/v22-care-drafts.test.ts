import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

type Element = {
  tag: string;
  children: Element[];
  events: Record<string, Function>;
  value: string;
  textContent: string;
  hidden: boolean;
  name: string;
  disabled?: boolean;
  parentNode?: object;
  after: (node: Element) => void;
  remove: () => void;
  addEventListener: (event: string, callback: Function) => void;
  replaceChildren: (...children: Element[]) => void;
};

function element(tag: string, props: Record<string, any> | null, ...children: Element[]): Element {
  return {
    tag,
    children: children.flat(Infinity).filter(Boolean),
    events: props?.on || {},
    value: "",
    textContent: props?.text || "",
    hidden: false,
    dataset: {},
    name: props?.name || "",
    parentNode: {},
    after(node: Element) {
      this.children.push(node);
    },
    remove() {},
    addEventListener(event: string, callback: Function) {
      this.events[event] = callback;
    },
    classList: { toggle() {} },
    focus() {},
    replaceChildren(...nodes: Element[]) {
      this.children = nodes.flat(Infinity).filter(Boolean);
    },
  } as Element;
}

function find(node: Element, predicate: (el: Element) => boolean): Element | undefined {
  if (predicate(node)) return node;
  for (const child of node.children) {
    const match = find(child, predicate);
    if (match) return match;
  }
  return undefined;
}

async function load(fetch = async () => ({ ok: true, json: async () => ({}) })) {
  const files = ["care-note.js", "membrowser-care.js"];
  const sources = await Promise.all(
    files.map((file) => readFile(new URL(`../webui/v22/js/views/${file}`, import.meta.url), "utf8"))
  );
  return runInNewContext(
    sources.map((s) => s.replace(/^import .*;$/gm, "").replace(/^export /gm, "")).join("\n") + "\n({careBlock})",
    {
      h: element,
      fetch,
      growTextarea() {},
      t: (key: string) => key,
    }
  );
}

const button = (node: Element, text: string) => find(node, (el) => el.textContent === text)!;
const textarea = (node: Element) => find(node, (el) => el.tag.startsWith("textarea"))!;

function type(area: Element, text: string) {
  area.value = text;
  area.events.input();
}

test("new care note keeps its text and selected kind when the reader is rebuilt or reopened", async () => {
  const { careBlock } = await load();
  const deps = { care: [], add() {}, rerender() {} };
  const original = careBlock({ id: "a" }, deps);
  const kind = button(original, "mb.care.edit");
  kind.events.click({ currentTarget: kind });
  type(textarea(original), "Unsaved multiline\nnote");
  careBlock({ id: "b" }, deps); // another memory must not inherit this draft
  const reopened = careBlock({ id: "a" }, deps);
  assert.equal(textarea(reopened).value, "Unsaved multiline\nnote");
  assert.equal(find(reopened, (el) => el.tag === "div.mb-care__compose")?.hidden, false);
});

test("editing an existing care note survives a reader rebuild with the draft unchanged", async () => {
  const { careBlock } = await load();
  const deps = {
    care: [{ id: "a", kind: "note", note: "Stored note", date: "2026-11-16", done: false }],
    add() {},
    rerender() {},
  };
  const original = careBlock({ id: "a" }, deps);
  button(original, "mb.careEdit").events.click();
  type(textarea(original), "Changed, not saved");
  const reopened = careBlock({ id: "a" }, deps);
  assert.equal(textarea(reopened).value, "Changed, not saved");
  button(reopened, "mb.careCancel").events.click();
  const cancelled = careBlock({ id: "a" }, deps);
  assert.equal(find(cancelled, (el) => el.textContent === "Stored note")?.textContent, "Stored note");
});

test("a save failure after switching away and back updates the visible memory editor", async () => {
  const files = ["membrowser-edit-model.js", "membrowser-edit.js"];
  const sources = await Promise.all(
    files.map((file) => readFile(new URL(`../webui/v22/js/views/${file}`, import.meta.url), "utf8"))
  );
  let answer: (result: unknown) => void = () => {};
  const { readerEdit } = runInNewContext(
    sources.map((s) => s.replace(/^import[\s\S]*?;\n/gm, "").replace(/^export /gm, "")).join("\n") + "\n({readerEdit})",
    {
      h: element,
      growTextarea() {},
      t: (key: string) => key,
      window: { addEventListener() {} },
      fetch: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    }
  );
  let reloaded: (result: unknown) => void = () => {};
  const deps = () => ({
    anchor: element("h2", null),
    box: element("div", null),
    text: element("div", null),
    refresh() {},
    rerender() {},
    reload: () =>
      new Promise((resolve) => {
        reloaded = resolve;
      }),
    archived() {},
  });
  const first = deps();
  const original = readerEdit({ id: "a" }, first);
  const detail = { body: "Old body", summary: "Summary", tags: ["tag"], revision: "r1", rule: { state: "note" } };
  original.attach(detail);
  original.acts[0].events.click();
  const body = find(first.anchor, (el) => el.name === "body")!;
  type(body, "Unsaved body");
  const saving = button(first.anchor, "mb.ed.save").events.click();
  const second = deps();
  const reopened = readerEdit({ id: "a" }, second);
  reopened.attach(detail);
  answer({ status: 500, json: async () => ({ error: "failed" }) });
  await saving;
  assert.equal(find(second.anchor, (el) => el.name === "body")?.value, "Unsaved body");
  assert.equal(button(second.anchor, "mb.ed.save").disabled, false);
  assert.ok(find(second.anchor, (el) => el.textContent === "mb.ed.fail"));
  const conflicting = button(second.anchor, "mb.ed.save").events.click();
  answer({ status: 409, json: async () => ({}) });
  await conflicting;
  const reload = button(second.anchor, "mb.ed.reload").events.click();
  const third = deps();
  readerEdit({ id: "a" }, third).attach(detail);
  reloaded({ ...detail, body: "Current body", revision: "r2" });
  await reload;
  assert.equal(find(third.anchor, (el) => el.name === "body")?.value, "Current body");
  button(third.anchor, "mb.ed.useStash").events.click();
  assert.equal(find(third.anchor, (el) => el.name === "body")?.value, "Unsaved body");
});

test("a care save completing after the reader was closed clears only its saved draft", async () => {
  let answer: (result: any) => void = () => {};
  const { careBlock } = await load(
    () =>
      new Promise((resolve) => {
        answer = resolve;
      })
  );
  const care: unknown[] = [];
  const deps = { care, add: (entry: unknown) => care.push(entry), rerender() {} };
  const original = careBlock({ id: "a" }, deps);
  const kind = button(original, "mb.care.note");
  kind.events.click({ currentTarget: kind });
  type(textarea(original), "Saved note");
  const pending = button(original, "mb.careSend").events.click();
  careBlock({ id: "b" }, deps); // no active reader for a at completion
  answer({
    ok: true,
    json: async () => ({ entry: { id: "a", kind: "note", note: "Saved note", date: "2026-11-16", done: false } }),
  });
  await pending;
  const reopened = careBlock({ id: "a" }, deps);
  assert.equal(textarea(reopened).value, "");
  assert.ok(find(reopened, (el) => el.textContent === "Saved note"));
  assert.equal(find(reopened, (el) => el.tag === "div.cn__msg")?.textContent, "");
});
