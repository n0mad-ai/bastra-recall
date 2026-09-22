/**
 * Tests für den Semantic-Layer der Vault-Map (#207):
 *   - buildSemanticLayout — PCA-Positionen, unwritten connections (kNN minus
 *     geschriebene Kanten), Notes ohne Vector übersprungen
 *   - GET /api/v1/graph/semantic — 200 mit Layout, 503 ohne Embedding-Index,
 *     private Notes nie im Ergebnis
 *
 * Runner: `tsx --test __tests__/http-semantic.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import {
  Vault,
  SearchIndex,
  buildSemanticLayout,
  type VaultGraph,
  type GraphNode,
} from "@bastra-recall/core";
import { startHttpServer } from "../src/http.js";
import { Telemetry } from "../src/telemetry.js";

const mkNode = (id: string): GraphNode => ({
  id,
  title: id,
  type: "reference",
  scope: "test",
  cluster: "c",
  group: "other",
  sub: "general",
  tags: [],
  summary: "",
  updated: "2026-01-01T00:00:00.000Z",
  degree: 0,
  kind: "memory",
});

const mkGraph = (nodeIds: string[], edges: Array<[string, string]>): VaultGraph => ({
  generated_at: "2026-01-01T00:00:00.000Z",
  vault_name: "test",
  vault_size: nodeIds.length,
  withheld: { private: 0 },
  clusters: [],
  groups: [],
  nodes: nodeIds.map(mkNode),
  edges: edges.map(([source, target]) => ({ source, target, via: "related" as const })),
  edge_counts: { related: edges.length, related_via: 0 },
});

const vec = (values: number[]) => new Float32Array(values);
const pair = (a: string, b: string) => (a < b ? `${a} ${b}` : `${b} ${a}`);

test("buildSemanticLayout: positions, unwritten edges, missing vectors skipped", () => {
  // two clean semantic clusters: n1/n2/n3 vs n4/n5; n6 has no vector
  const vectors = new Map<string, Float32Array>([
    ["n1", vec([1, 0.05, 0, 0])],
    ["n2", vec([1, -0.05, 0, 0])],
    ["n3", vec([1, 0, 0.05, 0])],
    ["n4", vec([0, 0, 1, 0.05])],
    ["n5", vec([0, 0.05, 1, 0])],
  ]);
  // n1–n2 is already written — it must NOT come back as a discovery
  const graph = mkGraph(["n1", "n2", "n3", "n4", "n5", "n6"], [["n1", "n2"]]);
  const layout = buildSemanticLayout(graph, vectors);

  assert.equal(layout.count, 5, "only embedded notes get a position");
  assert.equal(layout.dim, 4);
  assert.ok(layout.positions.every((p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1));
  assert.ok(!layout.positions.some((p) => p.id === "n6"));

  const pairs = new Set(layout.edges.map((e) => pair(e.source, e.target)));
  assert.ok(pairs.has(pair("n1", "n3")), "close + unlinked → unwritten connection");
  assert.ok(pairs.has(pair("n2", "n3")));
  assert.ok(pairs.has(pair("n4", "n5")));
  assert.ok(!pairs.has(pair("n1", "n2")), "written edges are not discoveries");
  assert.ok(!pairs.has(pair("n1", "n4")), "dissimilar pairs stay below the floor");
  assert.ok(layout.edges.every((e) => e.sim >= 0.6 && e.sim <= 1));

  // the projection keeps semantic clusters together
  const at = (id: string) => layout.positions.find((p) => p.id === id)!;
  const d = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.hypot(a.x - b.x, a.y - b.y);
  assert.ok(
    d(at("n1"), at("n2")) < d(at("n1"), at("n4")),
    "semantic siblings sit closer than strangers",
  );
});

test("buildSemanticLayout: empty and single-vector vaults don't blow up", () => {
  const empty = buildSemanticLayout(mkGraph([], []), new Map());
  assert.equal(empty.count, 0);
  assert.deepEqual(empty.positions, []);
  assert.deepEqual(empty.edges, []);

  const one = buildSemanticLayout(
    mkGraph(["solo"], []),
    new Map([["solo", vec([1, 0, 0, 0])]]),
  );
  assert.equal(one.count, 1);
  assert.deepEqual(one.positions, [{ id: "solo", x: 0.5, y: 0.5, z: 0.5 }]);
});

// ── HTTP endpoint ────────────────────────────────────────────────

function memoryMarkdown(id: string, opts: { related?: string[]; sensitivity?: string } = {}): string {
  const ts = new Date().toISOString();
  const related = (opts.related ?? []).map((r) => `  - ${r}`).join("\n");
  return [
    "---",
    `id: ${id}`,
    `title: Title of ${id}`,
    "type: reference",
    `summary: Summary of ${id}`,
    "topic_path:",
    "  - test",
    "tags:",
    "  - test",
    "scope: semantic-test",
    "recall_when:",
    `  - ${id}`,
    ...(opts.related?.length ? ["related:", related] : []),
    ...(opts.sensitivity ? [`sensitivity: ${opts.sensitivity}`] : []),
    `created: ${ts}`,
    `updated: ${ts}`,
    "---",
    "",
    `Body of ${id}.`,
    "",
  ].join("\n");
}

function httpGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path, method: "GET" }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("GET /api/v1/graph/semantic: layout with vectors, 503 without, private excluded", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-semantic-test-"));
  const folder = join(dir, "memories", "projects", "alpha");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "a1.md"), memoryMarkdown("a1", { related: ["a2"] }));
  await writeFile(join(folder, "a2.md"), memoryMarkdown("a2"));
  await writeFile(join(folder, "a3.md"), memoryMarkdown("a3"));
  await writeFile(join(folder, "secret.md"), memoryMarkdown("secret", { sensitivity: "private" }));
  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  const telemetry = new Telemetry();

  // a1/a2/a3 all similar: a1–a2 written, the a3 pairs are discoveries.
  // secret has a vector too — the graph's private filter must still win.
  let vectors: Map<string, Float32Array> | null = new Map([
    ["a1", vec([1, 0.05, 0, 0])],
    ["a2", vec([1, -0.05, 0, 0])],
    ["a3", vec([1, 0, 0.05, 0])],
    ["secret", vec([1, 0.02, 0.02, 0])],
  ]);
  const handle = await startHttpServer({
    port: 0,
    vault,
    search,
    telemetry,
    version: "test",
    toolDeps: { vault, search, telemetry, vaultPath: dir },
    documentWriteEnabled: false,
    embedding: { on: false, providerId: null, source: "none" },
    embeddingVectors: () => vectors,
  });
  try {
    const ok = await httpGet(handle.port!, "/api/v1/graph/semantic");
    assert.equal(ok.status, 200);
    const layout = JSON.parse(ok.body);
    assert.equal(layout.count, 3);
    const ids = layout.positions.map((p: { id: string }) => p.id).sort();
    assert.deepEqual(ids, ["a1", "a2", "a3"], "private note never gets a position");
    const pairs = new Set(
      layout.edges.map((e: { source: string; target: string }) => pair(e.source, e.target)),
    );
    assert.ok(pairs.has(pair("a1", "a3")) && pairs.has(pair("a2", "a3")));
    assert.ok(!pairs.has(pair("a1", "a2")), "written edge filtered");
    assert.ok(![...pairs].some((p) => (p as string).includes("secret")));
  } finally {
    await handle.close();
  }

  // no vectors → 503 (fresh server: the 60s cache must not mask the state)
  vectors = null;
  const handle2 = await startHttpServer({
    port: 0,
    vault,
    search,
    telemetry,
    version: "test",
    toolDeps: { vault, search, telemetry, vaultPath: dir },
    documentWriteEnabled: false,
    embedding: { on: false, providerId: null, source: "none" },
    embeddingVectors: () => vectors,
  });
  try {
    const gone = await httpGet(handle2.port!, "/api/v1/graph/semantic");
    assert.equal(gone.status, 503, "no embedding index → not ready");
  } finally {
    search.stop();
    await vault.stop?.();
    await handle2.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
