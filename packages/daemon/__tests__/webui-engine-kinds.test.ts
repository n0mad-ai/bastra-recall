// #1715: after "Is a skill" the reloaded graph names the node a skill; the map on screen adopts it
// without a rebuild (js/views/engine-kinds.js, wired in engine-host.js).
import { test } from "node:test";
import assert from "node:assert/strict";

const { adoptKinds } = (await import(new URL("../webui/app/js/views/engine-kinds.js", import.meta.url).href)) as {
  adoptKinds: (byId: Map<string, { kind?: string; x?: number }>, nodes: unknown) => number;
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
