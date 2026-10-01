/**
 * Tests für die dritte Semantic-Achse (zzallirog-Idee): buildSemanticLayout
 * liefert pro Position eine z-Koordinate (dritte Hauptkomponente) im
 * Einheitswürfel — die 2D-Projektion (x/y) bleibt davon unberührt.
 *
 * Runner: `node --import tsx --test packages/core/__tests__/semantic-depth.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSemanticLayout } from "../src/graph-semantic.js";
import type { VaultGraph } from "../src/graph.js";

function graphOf(ids: string[]): VaultGraph {
  return {
    generated_at: new Date().toISOString(),
    vault_name: "test",
    nodes: ids.map((id) => ({
      id,
      title: id,
      type: "lesson",
      scope: "s",
      cluster: "c",
      group: "other",
      sub: "general",
      tags: [],
      summary: "",
      updated: "2026-07-18",
      degree: 0,
      kind: "memory" as const,
    })),
    edges: [],
    clusters: [],
    groups: [],
  } as unknown as VaultGraph;
}

test("semantic layout: positions carry x/y/z in the unit cube", async () => {
  // vier Punkte, die in drei orthogonalen Richtungen variieren
  const vectors = new Map<string, Float32Array>([
    ["a", Float32Array.from([1, 0, 0, 0])],
    ["b", Float32Array.from([-1, 0, 0, 0])],
    ["c", Float32Array.from([0, 1, 0.5, 0])],
    ["d", Float32Array.from([0, -1, -0.5, 0.3])],
  ]);
  const layout = await buildSemanticLayout(graphOf(["a", "b", "c", "d"]), vectors);
  assert.equal(layout.count, 4);
  for (const p of layout.positions) {
    for (const axis of ["x", "y", "z"] as const) {
      assert.equal(typeof p[axis], "number", `${p.id}.${axis} fehlt`);
      assert.ok(p[axis] >= 0 && p[axis] <= 1, `${p.id}.${axis} außerhalb [0,1]: ${p[axis]}`);
    }
  }
  // mindestens eine Achse muss echte Streuung tragen
  const zs = layout.positions.map((p) => p.z);
  const xs = layout.positions.map((p) => p.x);
  assert.ok(Math.max(...xs) - Math.min(...xs) > 0.5, "x-Achse trägt die Hauptvarianz");
  assert.ok(new Set(zs.map((z) => z.toFixed(3))).size >= 2, "z ist keine Konstante");
});

test("semantic layout: single vector centers at (0.5, 0.5, 0.5)", async () => {
  const layout = await buildSemanticLayout(
    graphOf(["solo"]),
    new Map([["solo", Float32Array.from([1, 2, 3])]]),
  );
  assert.deepEqual(layout.positions, [{ id: "solo", x: 0.5, y: 0.5, z: 0.5 }]);
});

test("semantic layout: the O(n²) neighbor scan yields to the event loop while it runs", async () => {
  // Ohne Yield läuft der ganze Scan in einem Stück: kein anderer Callback
  // (Hook-Lanes im Daemon) kommt dran, bis das Layout fertig ist.
  const ids = Array.from({ length: 80 }, (_, i) => `n${i}`);
  const vectors = new Map(ids.map((id, i) => [id, Float32Array.from([Math.cos(i), Math.sin(i), (i % 7) / 7, 1])]));
  let ticks = 0;
  let running = true;
  const tick = () => {
    ticks++;
    if (running) setImmediate(tick);
  };
  setImmediate(tick);
  const layout = await buildSemanticLayout(graphOf(ids), vectors);
  running = false;
  assert.equal(layout.count, 80);
  assert.ok(ticks >= 2, `the event loop ran ${ticks} time(s) during the scan`);
});
