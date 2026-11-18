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
  for (const sel of [".tk-rv .mb__head", ".tk-rv .mb-row", ".tk-rep__head"])
    assert.equal(rule(sel).height, "var(--rv-row)", sel);
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

test("N4/N2: rows with open notes are amber like the notes in the report", () => {
  const work = rules.find(([sel]) => sel === ".tk-rv .mb-row.is-work");
  assert.ok(work);
  assert.match(work[1]["box-shadow"], /var\(--amber\)/);
  const badge = rules.find(([sel]) => sel === ".tk-rv__work");
  assert.equal(badge?.[1].color, "var(--amber)");
  const drafts = rules.find(([sel]) => sel === ".tk-rv .mb-row .tk-an__count.is-draft");
  assert.equal(drafts?.[1].color, "var(--amber)", "your own drafts are no longer grey in the list");
});
