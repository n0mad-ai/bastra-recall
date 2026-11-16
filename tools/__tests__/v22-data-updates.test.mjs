import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

test("user area counts include memories and documents while synthetic nodes stay in the raw graph", async () => {
  const source = await readFile(new URL("../../packages/daemon/webui/v22/js/data.js", import.meta.url), "utf8");
  const nodes = [
    { id: "m", kind: "memory", cluster: "area" },
    { id: "d", kind: "doc", cluster: "area" },
    { id: "g", kind: "ghost", cluster: "area" },
    { id: "s", kind: "skill", cluster: "skills" },
  ];
  const ctx = vm.createContext({
    document: { title: "" },
    reportRows: () => [],
    fetch: async () => ({
      ok: true,
      json: async () => ({
        nodes,
        clusters: [
          { key: "area", count: 3 },
          { key: "skills", count: 1 },
        ],
        edges: [],
      }),
    }),
  });
  vm.runInContext(
    source.replace(/^import .*;\n/gm, "").replaceAll("export ", "") + ";globalThis.api = { loadGraph, data };",
    ctx
  );
  await ctx.api.loadGraph();
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.api.data.clusters)), [{ key: "area", count: 2 }]);
  assert.equal(ctx.api.data.graph.nodes.length, 4, "raw graph and engines keep synthetic references");
});

test("live graph refresh coalesces a batch, covers changes/deletes, skips reads and duplicate polls", async () => {
  const source = await readFile(new URL("../../packages/daemon/webui/v22/js/data.js", import.meta.url), "utf8");
  let graphCalls = 0,
    updateCalls = 0,
    seq = 1,
    updates = [],
    nodes = [{ id: "existing", title: "Old" }];
  const context = vm.createContext({
    document: { title: "" },
    reportRows: () => [],
    fetch: async (url) => ({
      ok: true,
      json: async () => {
        if (url === "/ui/graph") {
          graphCalls++;
          return { nodes: structuredClone(nodes), edges: [], clusters: [] };
        }
        updateCalls++;
        return { seq, updates };
      },
    }),
  });
  vm.runInContext(
    source.replace(/^import .*;\n/gm, "").replaceAll("export ", "") +
      ";globalThis.api = { loadGraph, pollUpdates, data };",
    context
  );
  const { loadGraph, pollUpdates, data } = context.api;
  await loadGraph();
  await pollUpdates();
  seq++;
  updates = [{ kind: "add" }, { kind: "add" }];
  nodes.push({ id: "added", title: "New" });
  await Promise.all([pollUpdates(), pollUpdates(), pollUpdates()]);
  assert.equal(graphCalls, 2);
  assert.equal(updateCalls, 2);
  assert.equal(data.graph.nodes.length, 2);
  seq++;
  updates = [{ kind: "change" }];
  nodes[0].title = "Changed";
  await pollUpdates();
  assert.equal(data.graph.nodes[0].title, "Changed");
  seq++;
  updates = [{ kind: "delete" }];
  nodes = nodes.slice(1);
  await pollUpdates();
  assert.equal(data.graph.nodes[0].id, "added");
  assert.equal(graphCalls, 4);
  seq++;
  updates = [{ kind: "read" }];
  await pollUpdates();
  await pollUpdates();
  assert.equal(graphCalls, 4);
  assert.equal(data.newSince, 5);
});

test("a mutation arriving during initial graph load fetches a fresh snapshot afterward", async () => {
  const source = await readFile(new URL("../../packages/daemon/webui/v22/js/data.js", import.meta.url), "utf8");
  let seq = 1,
    calls = 0,
    finishInitial;
  const ctx = vm.createContext({
    document: { title: "" },
    reportRows: () => [],
    fetch: async (url) => {
      if (url === "/ui/graph") {
        calls++;
        if (calls === 1)
          return new Promise((resolve) => {
            finishInitial = () => resolve({ ok: true, json: async () => ({ nodes: [{ id: "old" }] }) });
          });
        return { ok: true, json: async () => ({ nodes: [{ id: "new" }] }) };
      }
      return { ok: true, json: async () => ({ seq, updates: [{ kind: "add" }] }) };
    },
  });
  vm.runInContext(
    source.replace(/^import .*;\n/gm, "").replaceAll("export ", "") +
      ";globalThis.api = { loadGraph, pollUpdates, data };",
    ctx
  );
  const api = ctx.api;
  await api.pollUpdates();
  const initial = api.loadGraph();
  seq++;
  const update = api.pollUpdates();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  finishInitial();
  await Promise.all([initial, update]);
  assert.equal(calls, 2);
  assert.equal(api.data.graph.nodes[0].id, "new");
});
