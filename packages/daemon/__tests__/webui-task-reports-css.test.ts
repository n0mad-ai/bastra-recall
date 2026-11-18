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

test("N4/N2: rows with open notes are amber like the notes in the report", () => {
  const work = rules.find(([sel]) => sel === ".tk-rv .mb-row.is-work");
  assert.ok(work);
  assert.match(work[1]["box-shadow"], /var\(--amber\)/);
  const badge = rules.find(([sel]) => sel === ".tk-rv__work");
  assert.equal(badge?.[1].color, "var(--amber)");
  const drafts = rules.find(([sel]) => sel === ".tk-rv .mb-row .tk-an__count.is-draft");
  assert.equal(drafts?.[1].color, "var(--amber)", "your own drafts are no longer grey in the list");
});
