// #1715: after "Is a skill" the reloaded graph names the node a skill; the map on screen adopts it
// without a rebuild (js/views/engine-kinds.js, wired in engine-host.js).
import { test } from "node:test";
import assert from "node:assert/strict";

const { adoptKinds } = (await import(new URL("../webui/app/js/views/engine-kinds.js", import.meta.url).href)) as {
  adoptKinds: (
    byId: Map<string, { kind?: string; x?: number }>,
    nodes: unknown,
    radius?: (n: object) => number
  ) => number;
};

test("a ghost on the map becomes a skill in place, keeping its position", () => {
  const ghost = { kind: "ghost", x: 12 },
    memory = { kind: "memory", x: 3 };
  const byId = new Map([
    ["g", ghost],
    ["m", memory],
  ]);
  const changed = adoptKinds(byId, [
    { id: "g", kind: "skill" },
    { id: "m", kind: "memory" },
  ]);
  assert.equal(changed, 1);
  assert.equal(byId.get("g"), ghost, "the same node object, so the simulation keeps it");
  assert.deepEqual(ghost, { kind: "skill", x: 12 });
  assert.equal(memory.kind, "memory");
});

test("unknown, malformed or new nodes change nothing", () => {
  const byId = new Map([["g", { kind: "ghost" }]]);
  assert.equal(adoptKinds(byId, [null, { id: "x", kind: "skill" }, { id: "g" }, { id: 4, kind: "skill" }]), 0);
  assert.equal(adoptKinds(byId, undefined), 0);
  assert.equal(byId.get("g")?.kind, "ghost");
});

test("#1730: the node takes the skill's collision radius at once, in place and at its position", async () => {
  const { createSimulation, collisionRadius } = (await import(
    new URL("../webui/js/simulation.js", import.meta.url).href
  )) as {
    collisionRadius: (n: object) => number;
    createSimulation: (
      g: object,
      w: number,
      h: number
    ) => { byId: Map<string, { kind?: string; cr?: number; x?: number; y?: number }> };
  };
  const node = (id: string, kind: string, bridge = false) => ({ id, kind, bridge, degree: 4, cluster: "c" });
  const graph = {
    clusters: [{ key: "c", count: 2 }],
    nodes: [node("g", "ghost"), node("b", "ghost", true)],
    edges: [],
  };
  const sim = createSimulation(graph, 800, 600);
  const ghost = sim.byId.get("g")!,
    bridge = sim.byId.get("b")!;
  const at = { x: ghost.x, y: ghost.y },
    ghostCr = ghost.cr;
  assert.equal(
    adoptKinds(
      sim.byId,
      [
        { id: "g", kind: "skill" },
        { id: "b", kind: "skill" },
      ],
      collisionRadius
    ),
    2
  );
  assert.equal(sim.byId.get("g"), ghost, "the same node object");
  assert.deepEqual({ x: ghost.x, y: ghost.y }, at, "the node keeps its position");
  const fresh = createSimulation({ ...graph, nodes: [node("g", "skill"), node("b", "skill", true)] }, 800, 600);
  assert.equal(ghost.cr, fresh.byId.get("g")!.cr, "the radius a rebuilt view would give a skill");
  assert.equal(bridge.cr, fresh.byId.get("b")!.cr, "a bridge keeps its halo");
  assert.ok(ghost.cr! < ghostCr!, "smaller than the ghost's: no new overlap, nothing has to move");
});
