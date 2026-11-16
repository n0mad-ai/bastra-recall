import test from "node:test";
import assert from "node:assert/strict";
import { createRenderer } from "../../packages/daemon/webui/js/renderer.js";

function globals(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const old = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => (old ? Object.defineProperty(globalThis, key, old) : delete globalThis[key]));
  }
}

function drawing(t, nodes = [], edges = []) {
  const calls = [];
  const ctx = new Proxy(
    {},
    {
      get(target, name) {
        if (name in target) return target[name];
        return (...args) => {
          calls.push([name, ...args]);
          if (name === "measureText") return { width: 10 };
          if (String(name).includes("Gradient")) return { addColorStop() {} };
        };
      },
    }
  );
  globals(t, {
    document: { documentElement: {}, createElement: () => ({ getContext: () => ctx }) },
    window: { devicePixelRatio: 1 },
    getComputedStyle: () => ({
      getPropertyValue: (name) =>
        ({
          "--map-glow-alpha": "0.2",
          "--map-dim": "0.1",
        })[name] ?? "#ffffff",
    }),
  });
  const canvas = { clientWidth: 100, clientHeight: 100, getContext: () => ctx };
  const sim = { nodes, edges, centers: new Map(), byId: new Map(nodes.map((n) => [n.id, n])) };
  const renderer = createRenderer(canvas, sim, new Map());
  const painted = () => calls.filter((c) => c[0] === "arc").map((c) => c[1]);
  return { renderer, sim, calls, painted };
}
const node = (id, x, depth = 0) => ({
  id,
  x,
  y: 50,
  idx: 0,
  degree: 1,
  kind: "skill",
  cluster: "a",
  orbitDepth: depth,
});

test("depth sorting observes mutations, stable ties and same-size graph replacements", (t) => {
  const a = node("a", 20, 0),
    b = node("b", 40, 1);
  const { renderer, sim, calls, painted } = drawing(t, [a, b]);
  renderer.setDrawOrder((a, b) => b.orbitDepth - a.orbitDepth);
  renderer.draw(0);
  assert.deepEqual(painted(), [40, 40, 20, 20]);
  calls.length = 0;
  a.orbitDepth = 1;
  renderer.draw(1);
  assert.deepEqual(painted(), [20, 20, 40, 40], "ties retain source order, not previous depth order");
  calls.length = 0;
  sim.nodes[0] = node("c", 60, 2);
  renderer.draw(2);
  assert.deepEqual(painted(), [60, 60, 40, 40], "in-place node replacement is observed");
  calls.length = 0;
  sim.nodes = [node("d", 80), node("e", 90)];
  renderer.draw(3);
  assert.deepEqual(painted(), [80, 80, 90, 90], "new same-length graph is observed");
  calls.length = 0;
  renderer.setDrawOrder(null);
  renderer.draw(4);
  renderer.setDrawOrder(() => 0);
  sim.nodes.reverse();
  calls.length = 0;
  renderer.draw(5);
  assert.deepEqual(painted(), [90, 90, 80, 80]);
});

test("culling retains the visible tail of a filtered salience halo", (t) => {
  const n = { ...node("hot", -61), kind: "memory", degree: 100, salience: 1 };
  const { renderer, calls } = drawing(t, [n]);
  renderer.setFilter(() => true);
  renderer.draw((Math.PI * 350) / 2);
  assert.ok(
    calls.some((c) => c[0] === "drawImage" && c[2] < 0 && c[2] + c[4] > 0),
    "the breathing sprite overlaps the viewport even though its node is outside"
  );
});

test("culling preserves crossing edges, hub-bent curves and offscreen overlays", (t) => {
  const a = { ...node("a", -5000), y: -250 };
  const b = { ...node("b", 5000), y: -250 };
  const { renderer, calls, sim } = drawing(t, [a, b], [{ s: a, t: b }]);
  renderer.setBendCenter({ x: 0, y: 1000 });
  let overlays = 0;
  renderer.setOverlay(() => overlays++);
  renderer.draw(0);
  assert.ok(
    calls.some((c) => c[0] === "quadraticCurveTo"),
    "curve bows into the viewport"
  );
  assert.equal(overlays, 1, "overlay runs even when source nodes are culled");
  calls.length = 0;
  renderer.setBendCenter(null);
  a.x = -300;
  a.y = 50;
  b.x = 300;
  b.y = 50;
  renderer.draw(1);
  assert.ok(
    calls.some((c) => c[0] === "lineTo"),
    "straight edge crosses viewport from offscreen endpoints"
  );
  calls.length = 0;
  a.x = -1000;
  b.x = -900;
  renderer.draw(2);
  assert.equal(calls.filter((c) => c[0] === "lineTo").length, 0, "fully offscreen edge is skipped");
  assert.equal(sim.nodes.length, 2);
});

test("hover, focus, filters and highlight remain full-rate live renderer states", (t) => {
  const n = node("a", 20);
  const { renderer } = drawing(t, [n]);
  assert.equal(renderer.hasLiveEffects(), false);
  for (const [set, active] of [
    [renderer.setHover, n],
    [renderer.setFocus, n],
    [renderer.setFilter, () => true],
    [renderer.setHighlight, () => true],
  ]) {
    set(active);
    assert.equal(renderer.hasLiveEffects(), true);
    set(null);
    assert.equal(renderer.hasLiveEffects(), false);
  }
  renderer.flashNode("a", "#fff");
  assert.equal(renderer.hasLiveEffects(), true);
});
