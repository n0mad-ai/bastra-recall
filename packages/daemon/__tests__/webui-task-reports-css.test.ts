// N6 (Daniel 18.11.2026): in a report, the place under the pointer stands out more clearly and the
// "note" button is easier to see, without any text moving. Without a browser the stylesheet is the
// proof: every hover rule on a report place or its note button changes colour, background, shadow,
// outline or opacity only, never a property that takes room.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const css = await readFile(new URL("../webui/app/css/tasks-reports.css", import.meta.url), "utf8");
/** [selector, { property: value }] for every plain rule (no nesting in this file). */
const rules = css
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("}")
  .map((chunk) => chunk.split("{"))
  .filter((parts) => parts.length === 2)
  .map(([sel, body]) => [
    sel.trim(),
    Object.fromEntries(
      body
        .split(";")
        .map((d) => d.split(":").map((s) => s.trim()))
        .filter(([k, v]) => k && v)
        .map(([k, ...v]) => [k, v.join(":")])
    ),
  ]) as Array<[string, Record<string, string>]>;

/** Properties that paint without taking room. */
const PAINT_ONLY = new Set([
  "color",
  "background",
  "background-color",
  "border-color",
  "box-shadow",
  "outline",
  "outline-color",
  "outline-offset",
  "opacity",
]);

test("N6: hover on a report place and its note button changes paint only, so no content moves", () => {
  const hover = rules.filter(([sel]) => /tk-an/.test(sel) && /:hover/.test(sel));
  assert.ok(hover.length >= 3);
  for (const [sel, decls] of hover)
    for (const prop of Object.keys(decls)) assert.ok(PAINT_ONLY.has(prop), `${sel} sets ${prop}, which takes room`);
});

test("N6: the place under the pointer gets a background and the note button a clear amber frame", () => {
  const place = rules.find(([sel]) => /\.tk-an:not\(tr\)[^,]*:hover$/.test(sel));
  assert.ok(place, "a hover rule for the place itself");
  assert.ok(place[1].background && place[1].outline, "background and outline, no padding");
  const row = rules.find(([sel]) => /tr\.tk-an[^,]*:hover > td$/.test(sel));
  assert.ok(row?.[1].background, "a table row lights up as well");
  const btn = rules.find(([sel]) => sel.includes(".tk-an:hover > .tk-an__btn"));
  assert.ok(btn, "the button while its place is hovered");
  assert.equal(btn[1].opacity, "1");
  assert.match(btn[1]["border-color"] ?? "", /217, 164, 65|--amber/);
  assert.ok(btn[1].background, "a filled button, not a faint outline");
});

const rule = (sel: string) => rules.find(([s]) => s === sel)?.[1] ?? assert.fail(`no rule ${sel}`);

test("answer area: one framed unit set apart from the text; hover and choice change paint only", () => {
  const area = rule(".tk-ask");
  assert.ok(area.border && area["border-left"] && area.background && area.padding, "a framed surface of its own");
  const hover = rules.filter(([sel]) => /tk-ask/.test(sel) && /:hover|:focus-visible|\.is-on/.test(sel));
  assert.ok(hover.length >= 4);
  for (const [sel, decls] of hover)
    for (const prop of Object.keys(decls)) assert.ok(PAINT_ONLY.has(prop), `${sel} sets ${prop}, which takes room`);
  const chosen = rule(".tk-ask__opt.is-on");
  assert.equal(chosen["border-color"], "var(--amber)", "the choice is amber");
  assert.match(chosen["box-shadow"], /var\(--amber\)/);
});

test("answer area: one row of equal fields across the whole width, wrapping into rows just as wide", () => {
  // Daniel 18.11.2026 (draft D, flatter): options, own answer and clarification as equal fields
  const area = rule(".tk-ask");
  assert.equal(area.display, "grid");
  assert.match(area["grid-template-columns"], /^repeat\(auto-fit, minmax\([\d.]+em, 1fr\)\)$/, "equal, filling");
  const field = rule(".tk-ask__opt");
  assert.equal(field["flex-direction"], "column", "the key on top, the name below");
  assert.equal(field["min-height"], undefined, "no fixed height: key and name decide");
  assert.equal(field["min-width"], "0", "a long name wraps instead of widening its column");
  for (const sel of [".tk-ask__opt.is-free", ".tk-ask__opt.is-clarify"])
    assert.ok(!rules.some(([s, d]) => s.split(",").some((x) => x.trim() === sel) && (d.padding || d.font)), sel);
  assert.ok(!/tk-ask__(opts|alt)\b/.test(css), "no separate groups any more");
});

const panels = await readFile(new URL("../webui/app/css/panels.css", import.meta.url), "utf8");

test("jump list rows look like the panel's other lists: whole row marked, no stripe of their own", () => {
  // Daniel 18.11.2026: the active row is filled as a whole, the active line sits on the panel's outer
  // right edge (.ls-ind, set by data-lsel), as in the areas list
  const selected = /\.area-row\.is-on[^{]*\{[^}]*background: ([^;]+);/.exec(panels)?.[1];
  assert.ok(selected, "the areas list's selected background");
  const here = rules.find(([sel]) => sel.split(",").some((s) => s.trim() === ".tk-toc__j.is-here"));
  assert.equal(here?.[1].background, selected, "the place being read is filled like a selected row");
  for (const [sel, decls] of rules.filter(([s]) => /tk-toc/.test(s)))
    for (const prop of Object.keys(decls)) assert.doesNotMatch(prop, /^border-(left|right)/, `${sel} sets ${prop}`);
  // the draft Daniel chose: texts wrap, never cut
  const text = rule(".tk-toc__t");
  assert.ok(!text["white-space"] && !text["text-overflow"] && !text["-webkit-line-clamp"], "wraps, not cut");
  assert.equal(rule(".tk-toc__h")["text-transform"], "uppercase", "small mono labels above the blocks");
  assert.equal(rule(".tk-toc__h-n.is-amber").color, "var(--amber)");
});

test("text size: medium and large are bigger and airier than small (the reader's 14.5 px)", () => {
  const px = (sel: string) => parseFloat(rule(sel)["font-size"]);
  assert.ok(px(".tk-rep__md.is-size-m") >= 16 && px(".tk-rep__md.is-size-l") > px(".tk-rep__md.is-size-m"));
  assert.ok(parseFloat(rule(".tk-rep__md.is-size-m")["line-height"]) > 1.6);
});

test("one height for the view's head, the list rows and the report's head; title up to two lines, meta one", () => {
  assert.match(rule(".tk-rv")["--rv-row"], /^\d+px$/);
  for (const sel of [".tk-rv .mb-row", ".tk-rep__head"]) assert.equal(rule(sel).height, "var(--rv-row)", sel);
  // the view's head holds project, status filter, search and count: it keeps the row height while they
  // fit in one line and grows and wraps instead of clipping a switch when they do not (Daniel 26.11.2026)
  const head = rule(".tk-rv .mb__head");
  assert.deepEqual([head["min-height"], head.height, head["flex-wrap"]], ["var(--rv-row)", "auto", "wrap"]);
  assert.equal(rule(".tk-rep__head")["flex-wrap"], "nowrap");
  assert.equal(rule(".tk-rv .mb-row")["padding-block"], "0");
  // the title may take a second line (then "…"); two title lines and the meta line fit the row height
  const title = rule(".tk-rep__title");
  assert.deepEqual([title["-webkit-line-clamp"], title.overflow], ["2", "hidden"]);
  const lines = 2 * parseFloat(title["font-size"]) * parseFloat(title["line-height"]);
  assert.ok(lines + 3 + 14 <= 55, `two title lines (${lines}px) and the meta line fit 56px`);
  const meta = rule(".tk-rep__meta");
  assert.deepEqual([meta["white-space"], meta["flex-wrap"], meta.overflow], ["nowrap", "nowrap", "hidden"]);
  const narrow = rule(".tk-rv.is-narrow .tk-rep__head");
  assert.deepEqual([narrow["flex-wrap"], narrow.height], ["wrap", "auto"], "narrow screens may wrap");
});

test("the report text starts the reader's padding below the head: no first heading margin on top", () => {
  // the head stands above the scrolling text, so the first heading's margin no longer collapses into
  // the gap below it (Daniel 26.11.2026: the gap below the head was too high)
  assert.equal(rule(".mb-rd .tk-rep__md > :first-child")["margin-top"], "0");
});

test("N4/N2: your own drafts are amber in the list like the notes in the report", () => {
  const badge = rules.find(([sel]) => sel === ".tk-rv .tk-rv__work");
  assert.equal(badge?.[1].color, "var(--amber)");
  const drafts = rules.find(([sel]) => sel === ".tk-rv .mb-row .tk-an__count.is-draft");
  assert.equal(drafts?.[1].color, "var(--amber)", "your own drafts are no longer grey in the list");
});

/** The selectors of a rule, one by one. */
const selectorsOf = (sel: string) => sel.split(",").map((x) => x.trim());
/** The declarations every rule naming exactly `sel` sets, merged in file order. */
const merged = (sel: string) =>
  Object.assign({}, ...rules.filter(([s]) => selectorsOf(s).includes(sel)).map(([, d]) => d)) as Record<string, string>;

test("status colours (Daniel 26.11.2026): one colour token per state, question and handed over differ", () => {
  const tone = (state: string) => merged(`.tk-rv .st-${state}`)["--tc"];
  assert.deepEqual(
    Object.fromEntries(
      ["new", "question", "in_progress", "handed", "done", "read", "outdated"].map((s) => [s, tone(s)])
    ),
    {
      new: "var(--accent)",
      question: "var(--amber)",
      in_progress: "var(--amber)",
      handed: "var(--ink-soft)",
      done: "var(--ok)",
      read: "var(--line-45)",
      outdated: "var(--muted)",
    }
  );
  // the labels carry .mb-row__ai, which membrowser.css (loaded later) paints cyan: ".tk-rv" in front wins
  assert.equal(rule(".tk-rv .tk-rv__done").color, "var(--ok)");
  assert.equal(rule(".tk-rv .tk-rv__handed").color, "var(--ink-soft)");
  assert.equal(rule(".tk-rv .tk-rv__old").color, "var(--muted)");
  assert.equal(rule(".tk-rv .tk-rv__work.tk-rv__draft")["border-style"], "dashed", "in progress: the drafts' dashes");
  for (const [sel, decls] of rules.filter(([s]) => /\.st-/.test(s)))
    for (const v of Object.values(decls))
      assert.doesNotMatch(v, /#[0-9a-f]{3,8}\b/i, `${sel}: a token, no new colour value`);
});

test("one marking per row: a stripe on the left for open states, none for new and done; no lines above or below", () => {
  const stripe = (state: string) => merged(`.tk-rv .mb-row.st-${state}`)["--stripe"];
  for (const s of ["question", "in_progress", "handed"]) assert.equal(stripe(s), "0 0 var(--tc)", `${s} has a stripe`);
  for (const s of ["new", "done", "read", "outdated"]) assert.equal(stripe(s), undefined, `${s} has no stripe`);
  // new and done: no tint either (the green dot is enough for done, Daniel 26.11.2026)
  for (const s of ["new", "done"]) assert.equal(merged(`.tk-rv .mb-row.st-${s}`).background, undefined, s);
  assert.ok(merged(".tk-rv .mb-row.st-question").background, "a question is tinted");
  // the row's shadow is the left stripe only: no line on the right, none at the top or bottom
  const shadow = merged(".tk-rv .mb-row")["box-shadow"];
  assert.equal(shadow.replace(/\s+/g, " "), "inset 2px var(--stripe)");
  assert.equal(merged(".tk-rv .mb-row.is-sel")["box-shadow"], shadow, "the selection overrides membrowser's lines");
  assert.ok(!/--mark/.test(css), "no selection line on the right edge any more");
  // the open report: the accent stripe on the left, in the state stripe's place, winning over it by order
  assert.equal(merged(".tk-rv .mb-row.is-sel")["--stripe"], "0 0 var(--accent)");
  const last = (pred: (sel: string, d: Record<string, string>) => boolean) =>
    rules
      .map(([s, d], i) => (pred(s as string, d as Record<string, string>) ? i : -1))
      .reduce((a, b) => Math.max(a, b));
  const sel = last((s, d) => selectorsOf(s).includes(".tk-rv .mb-row.is-sel") && d["--stripe"] === "0 0 var(--accent)");
  for (const s of ["question", "in_progress", "handed"])
    assert.ok(
      sel > last((x, d) => selectorsOf(x).includes(`.tk-rv .mb-row.st-${s}`) && "--stripe" in d),
      `selection after the ${s} stripe`
    );
  assert.ok(!/inset 0 (1px|-1px)/.test(css), "no coloured line above or below a row any more");
});

test("reader head: outside the scrolling text, with a shadow down onto it; the jump stops above the reading line", () => {
  const head = rule(".tk-rep__head");
  assert.equal(head.position, undefined, "not sticky inside the scroller any more");
  assert.equal(head.margin, undefined, "no negative margin over the reader's padding");
  assert.match(head["box-shadow"], /^0 \d+px \d+px -?\d+px var\(--shade-\d+\)$/, "a drop shadow downwards");
  assert.equal(rule(".tk-rv__pane > .mb__reader").flex, "1", "the text scrolls below the head");
  const stop = parseFloat(merged(".tk-rep__md .tk-an__card")["scroll-margin-top"]);
  assert.ok(stop > 0 && stop < 64, "a jump lands above the jump list's reading line (OUTLINE_LINE)");
});
