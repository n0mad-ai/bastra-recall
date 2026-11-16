import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

async function links() {
  const source = await readFile(new URL("../webui/v22/js/views/ring-links.js", import.meta.url), "utf8");
  return runInNewContext(
    source.replace(/^import [\s\S]*?;$/gm, "").replace(/^export /gm, "") + "\n({ nodeTier, linkCurve, linkedDots })",
    { RC: {}, MUT: "", ACC: "", areaCol: () => "", s() {}, clear() {}, Set, Map }
  );
}

test("ring dimming: selected segment soft, other segments dim, no selection unchanged", async () => {
  const { nodeTier } = await links();
  // memory of area "bastra-recall" selected (focus = its area)
  assert.equal(nodeTier("bastra-recall", "bastra-recall", "bastra-recall"), "soft");
  assert.equal(nodeTier("vault", "bastra-recall", "bastra-recall"), "dim");
  // hovering another segment while the card is open: that one is lit, the selected one dims
  assert.equal(nodeTier("vault", "vault", "bastra-recall"), "on");
  assert.equal(nodeTier("bastra-recall", "vault", "bastra-recall"), "dim");
  // area focus without a memory, plain hover and the rest state stay as before
  assert.equal(nodeTier("vault", "vault", null), "on");
  assert.equal(nodeTier("bastra-recall", "vault", null), "dim");
  assert.equal(nodeTier("vault", null, null), "on");
});

test("ring links: only targets that are on the ring and shown, each once", async () => {
  const { linkedDots } = await links();
  const dotOf = new Map([
    ["a", { id: "a", x: 0, y: 0 }],
    ["b", { id: "b", x: 1, y: 1 }],
    ["c", { id: "c", x: 2, y: 2 }],
  ]);
  const m = {
    links: [
      { id: "b", rel: "linked" },
      { id: "b", rel: "derived" },
      { id: "c", rel: "derived" },
      { id: "gone", rel: "linked" },
    ],
  };
  const all = linkedDots(m, dotOf, () => true);
  assert.deepEqual(JSON.parse(JSON.stringify(all.map((x: { p: { id: string }; rel: string }) => [x.p.id, x.rel]))), [
    ["b", "linked"],
    ["c", "derived"],
  ]);
  // c outside the time window
  const shown = linkedDots(m, dotOf, (id: string) => id !== "c");
  assert.equal(shown.length, 1);
  assert.equal(shown[0].p.id, "b");
});

test("ring links: curve runs from source to target, bent towards the centre", async () => {
  const { linkCurve } = await links();
  assert.equal(linkCurve({ x: 200, y: 0 }, { x: 0, y: 200 }), "M200.0 0.0Q50.0 50.0 0.0 200.0");
  // opposite dots: control point at the centre
  assert.equal(linkCurve({ x: -150, y: 20 }, { x: 150, y: -20 }), "M-150.0 20.0Q0.0 0.0 150.0 -20.0");
});
