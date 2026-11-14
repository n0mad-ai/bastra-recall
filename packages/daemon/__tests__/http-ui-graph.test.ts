import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex, buildGraph } from "@bastra-recall/core";
import { startHttpServer } from "../src/http.js";
import { Telemetry } from "../src/telemetry.js";
import { readSettings, mutateSettings, settingsFilePath } from "../src/settings-file.js";

function memory(id: string, sensitivity: string, type = "reference", related: string[] = []): string {
  return `---\nid: ${id}\ntitle: Fixture ${id}\ntype: ${type}\nsummary: Fixture summary\ntopic_path: [test]\ntags: [test]\nscope: graph-fixture\nrecall_when: [fixture]\nrelated: ${JSON.stringify(related)}\nrelated_via: ${JSON.stringify(related.map(id => ({ id, reason: "fixture-link-reason", score: 0.8 })))}\nsensitivity: ${sensitivity}\ncreated: 2026-11-14\nupdated: 2026-11-14\n---\nBody fixture ${id}.\n`;
}
function get(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any; raw: string; cacheControl?: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path, headers }, res => {
      let raw = ""; res.on("data", b => raw += b);
      res.on("end", () => resolve({ status: res.statusCode!, raw, body: JSON.parse(raw), cacheControl: res.headers["cache-control"] }));
    }); req.on("error", reject); req.end();
  });
}
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "ui-graph-private-"));
  await writeFile(join(dir, "public.md"), memory("public", "public", "reference", ["secret", "missing"]));
  await writeFile(join(dir, "secret.md"), memory("secret", "private", "reference", ["public", "private-doc"]));
  await writeFile(join(dir, "doc.md"), memory("private-doc", "private", "doc"));
  const vault = new Vault(dir); await vault.init();
  const search = new SearchIndex(vault); search.start();
  const telemetry = new Telemetry(), original = await readSettings();
  await mutateSettings(settingsFilePath(), s => ({ ...s, ui: { ...s.ui, enabled: true }, api: { ...s.api, token: "fixture-ui-graph-token" } }));
  const owner = (await stat(dir)).uid;
  const vectors = new Map(["public", "secret", "private-doc"].map((id, i) => [id, new Float32Array([1, i / 100, 0, 0])]));
  const handles: Array<Awaited<ReturnType<typeof startHttpServer>>> = [];
  const start = async (peer = owner, platform: NodeJS.Platform = "darwin") => {
    const handle = await startHttpServer({ port: 0, vault, search, telemetry, version: "test", toolDeps: { vault, search, telemetry, vaultPath: dir }, documentWriteEnabled: false,
      embedding: { on: false, providerId: null, source: "none" }, embeddingVectors: () => vectors,
      localAccount: { platform, euid: () => owner, lookup: async () => peer },
    }); handles.push(handle); return handle.port!;
  };
  return { vault, start, async close() { for (const h of handles) await h.close(); search.stop(); await vault.stop(); await mutateSettings(settingsFilePath(), () => original); await rm(dir, { recursive: true, force: true }); } };
}

test("UI graph includes private memories/docs and links; API and query opt-ins remain filtered", async () => {
  const f = await fixture();
  try {
    const projected = buildGraph(f.vault, [{ id: "declared-skill" }], { includePrivate: true });
    assert.equal(projected.withheld.private, 0);
    assert.ok(projected.nodes.every(n => Object.hasOwn(n, "sensitivity")));
    assert.equal(projected.nodes.find(n => n.id === "secret")!.sensitivity, "private");
    assert.equal(projected.nodes.find(n => n.id === "private-doc")!.sensitivity, "private");
    assert.equal(projected.nodes.find(n => n.id === "missing")!.sensitivity, null);
    assert.equal(projected.nodes.find(n => n.id === "declared-skill")!.sensitivity, null);
    for (const graph of [projected, buildGraph(f.vault)]) assert.equal(graph.vault_size - graph.withheld.private, graph.nodes.filter(n => n.kind === "memory" || n.kind === "doc").length);
    const port = await f.start();
    const ui = await get(port, "/ui/graph"); assert.equal(ui.status, 200);
    assert.equal(ui.cacheControl, "no-store");
    assert.equal(ui.body.withheld.private, 0);
    assert.ok(ui.body.nodes.some((n: any) => n.id === "secret" && n.sensitivity === "private"));
    assert.ok(ui.body.edges.some((e: any) => e.source === "public" && e.target === "secret"));
    const node = await get(port, "/ui/graph/node?id=secret"); assert.equal(node.status, 200);
    assert.equal(node.cacheControl, "no-store");
    assert.equal(node.body.sensitivity, "private"); assert.match(node.body.body, /Body fixture secret/);
    assert.deepEqual(node.body.related, ["public", "private-doc"]);
    const publicUi = await get(port, "/ui/graph/node?id=public");
    assert.ok(publicUi.body.related_via.some((l: any) => l.id === "secret"));
    for (const suffix of ["", "?include_private=true", "?includePrivate=true"]) {
      const api = await get(port, "/api/v1/graph" + suffix); assert.equal(api.status, 200);
      assert.equal(api.body.withheld.private, 2); assert.ok(!api.raw.includes('"secret"'));
    }
    assert.equal((await get(port, "/api/v1/graph/node?id=secret&include_private=true")).status, 404);
    const publicApi = await get(port, "/api/v1/graph/node?id=public");
    assert.deepEqual(publicApi.body.related, ["missing"]);
    assert.deepEqual(publicApi.body.related_via.map((l: any) => l.id), ["missing"]);
  } finally { await f.close(); }
});

test("UI graph access requires enabled UI, owner account, valid Host and forwarding auth", async () => {
  const f = await fixture();
  try {
    const owner = await f.start(), other = await f.start((await stat(f.vault.root)).uid + 1);
    for (const suffix of ["", "/node?id=secret", "/semantic"]) {
      assert.equal((await get(other, "/ui/graph" + suffix)).status, 403);
      assert.equal((await get(owner, "/ui/graph" + suffix, { Host: "foreign.invalid" })).status, 403);
      assert.equal((await get(owner, "/ui/graph" + suffix, { "X-Forwarded-For": "203.0.113.1" })).status, 401);
    }
    assert.equal((await get(owner, "/ui/graph", { "X-Forwarded-For": "203.0.113.1", Authorization: "Bearer fixture-ui-graph-token" })).status, 200);
    // The deliberately different existing API contract is not silently expanded.
    assert.equal((await get(other, "/api/v1/graph")).status, 200);
    await mutateSettings(settingsFilePath(), s => ({ ...s, ui: { ...s.ui, enabled: false } }));
    for (const suffix of ["", "/node?id=secret", "/semantic"]) assert.equal((await get(owner, "/ui/graph" + suffix)).status, 404);
  } finally { await f.close(); }
});

test("UI/API semantic caches and in-flight builds never cross visibility boundaries", async () => {
  const f = await fixture();
  try {
    const port = await f.start();
    let builds = 0; const list = f.vault.list.bind(f.vault); f.vault.list = () => { builds++; return list(); };
    const first = await Promise.all([get(port, "/ui/graph/semantic"), get(port, "/api/v1/graph/semantic"), get(port, "/ui/graph/semantic")]);
    assert.deepEqual(first.map(r => r.status), [200, 200, 200]);
    assert.deepEqual(first.map(r => r.body.count), [3, 1, 3]);
    assert.equal(first[0].cacheControl, "no-store");
    assert.equal(first[2].cacheControl, "no-store");
    assert.equal(builds, 2, "one in-flight build per visibility mode");
    assert.ok(first[0].body.positions.some((p: any) => p.id === "secret"));
    assert.ok(first[0].body.edges.some((e: any) => e.source === "private-doc" || e.target === "private-doc"));
    assert.ok(!first[1].raw.includes("secret"));
    for (const [path, count] of [["/api/v1/graph/semantic?include_private=true", 1], ["/ui/graph/semantic", 3], ["/api/v1/graph/semantic", 1]] as const) assert.equal((await get(port, path)).body.count, count);
    assert.equal(builds, 2, "both caches are reused without leaking either direction");
  } finally { await f.close(); }
});

test("UI graph fails closed where the peer account cannot be proven", async () => {
  const f = await fixture();
  try {
    const port = await f.start(undefined, "linux");
    const ui = await get(port, "/ui/graph"); assert.equal(ui.status, 200);
    assert.equal(ui.body.withheld.private, 2); assert.ok(!ui.raw.includes('"secret"'));
    assert.equal((await get(port, "/ui/graph/node?id=secret")).status, 404);
  } finally { await f.close(); }
});
