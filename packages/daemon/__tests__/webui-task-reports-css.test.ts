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

test("text size: medium and large are bigger and airier than small (the reader's 14.5 px)", () => {
  const px = (sel: string) => parseFloat(rule(sel)["font-size"]);
  assert.ok(px(".tk-rep__md.is-size-m") >= 16 && px(".tk-rep__md.is-size-l") > px(".tk-rep__md.is-size-m"));
  assert.ok(parseFloat(rule(".tk-rep__md.is-size-m")["line-height"]) > 1.6);
});

test("one height for the view's head, the list rows and the report's head; title and meta one line each", () => {
  assert.match(rule(".tk-rv")["--rv-row"], /^\d+px$/);
  for (const sel of [".tk-rv .mb__head", ".tk-rv .mb-row", ".tk-rep__head"])
    assert.equal(rule(sel).height, "var(--rv-row)", sel);
  assert.equal(rule(".tk-rep__head")["flex-wrap"], "nowrap");
  assert.equal(rule(".tk-rv .mb-row")["padding-block"], "0");
  const title = rule(".tk-rep__title");
  assert.deepEqual([title["white-space"], title["text-overflow"]], ["nowrap", "ellipsis"]);
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
