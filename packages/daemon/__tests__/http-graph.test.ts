/**
 * Tests für den Vault-Map-Datenpfad (#207):
 *   - GET /api/v1/graph — Nodes/Edges/Clusters/Ghosts/Bridges, private gefiltert
 *   - GET /api/v1/graph/node — voller Body, private → 404
 *   - /ui static serving — ui.enabled-Gate, index-Auslieferung, Traversal-Guard
 *
 * Runner: `tsx --test __tests__/http-graph.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request, createServer } from "node:http";
import { Vault, SearchIndex, buildGraph } from "@bastra-recall/core";
import { startHttpServer } from "../src/http.js";
import { Telemetry } from "../src/telemetry.js";
import { recordUsage } from "../src/usage-sidecar.js";
import { handleWebUi, handleUiAnnotate, handleUiAnnotations, parseCareFile, CARE_FILE } from "../src/webui.js";

function memoryMarkdown(
  id: string,
  opts: { related?: string[]; sensitivity?: string; salience?: number; emotion?: string; created?: string } = {},
): string {
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
    "scope: graph-test",
    "recall_when:",
    `  - ${id}`,
    ...(opts.related?.length ? ["related:", related] : []),
    ...(opts.sensitivity ? [`sensitivity: ${opts.sensitivity}`] : []),
    ...(opts.salience != null ? [`salience: ${opts.salience}`] : []),
    ...(opts.emotion ? [`emotion: ${opts.emotion}`] : []),
    `created: ${opts.created ?? ts}`,
    `updated: ${ts}`,
    "---",
    "",
    `Body of ${id} with a [[wikilink-in-body]] reference.`,
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

async function buildTestVault(): Promise<{ dir: string; vault: Vault }> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-graph-test-"));
  const alpha = join(dir, "memories", "projects", "alpha");
  const people = join(dir, "memories", "people");
  const beta = join(dir, "memories", "projects", "beta");
  await mkdir(alpha, { recursive: true });
  await mkdir(people, { recursive: true });
  await mkdir(beta, { recursive: true });
  // a1/a2 → ghost-x (majority cluster), p1 → ghost-x (second cluster)
  await writeFile(
    join(alpha, "a1.md"),
    memoryMarkdown("a1", { related: ["a2", "ghost-x"], salience: 0.9, emotion: "frustration", created: "2026-03-04" }),
  );
  await writeFile(join(alpha, "a2.md"), memoryMarkdown("a2", { related: ["ghost-x"], created: "sometime-in-march" }));
  await writeFile(join(people, "p1.md"), memoryMarkdown("p1", { related: ["ghost-x"] }));
  // b1 bridges alpha + people (two foreign clusters)
  await writeFile(join(beta, "b1.md"), memoryMarkdown("b1", { related: ["a1", "p1"] }));
  await writeFile(join(people, "secret.md"), memoryMarkdown("secret", { sensitivity: "private" }));
  const vault = new Vault(dir);
  await vault.init();
  return { dir, vault };
}

test("buildGraph: clusters, ghosts, bridges, private filter", async () => {
  const { dir, vault } = await buildTestVault();
  try {
    const g = buildGraph(vault);

    const ids = g.nodes.map((n) => n.id);
    assert.ok(ids.includes("a1") && ids.includes("p1") && ids.includes("b1"));
    assert.ok(!ids.includes("secret"), "private memories must not appear");

    // #332: der Abstand zwischen vault_size und den gezeichneten Nodes muss
    // erklärt sein, nicht bloß klein. Die Invariante ist die Erklärung.
    const drawn = g.nodes.filter((n) => n.kind === "memory" || n.kind === "doc").length;
    assert.equal(g.withheld.private, 1, "the one private fixture is the only exclusion");
    assert.equal(
      g.vault_size - g.withheld.private,
      drawn,
      `vault_size ${g.vault_size} − withheld ${g.withheld.private} must equal the ${drawn} memory/doc nodes`,
    );

    const a1 = g.nodes.find((n) => n.id === "a1")!;
    assert.equal(a1.cluster, "alpha", "projects/<scope> is its own cluster");
    const p1 = g.nodes.find((n) => n.id === "p1")!;
    assert.equal(p1.cluster, "people");

    // #217 Valenz: salience/emotion reach the node; absent stays absent
    assert.equal(a1.salience, 0.9);
    assert.equal(a1.emotion, "frustration");
    const a2 = g.nodes.find((n) => n.id === "a2")!;
    assert.equal(a2.salience, undefined);
    assert.equal(a2.emotion, undefined);

    // created reaches the node only as a valid ISO date
    assert.equal(a1.created, "2026-03-04");
    assert.equal(a2.created, undefined, "a non-ISO created is left out");
    assert.ok(Number.isFinite(Date.parse(p1.created ?? "")), "a full ISO timestamp is kept");

    // ghost-x exists only as a link target → ghost node with both linkers
    const ghost = g.nodes.find((n) => n.id === "ghost-x")!;
    assert.equal(ghost.kind, "ghost");
    assert.deepEqual(ghost.linked_by, ["a1", "a2", "p1"]);
    assert.equal(ghost.cluster, "alpha", "majority linker cluster wins");

    // b1 links into alpha AND people → bridge
    const b1 = g.nodes.find((n) => n.id === "b1")!;
    assert.deepEqual(b1.bridge, ["alpha", "people"]);

    // body wikilinks count as edges too (merged into related at save; here
    // the body link was NOT in frontmatter related → not an edge). The three
    // frontmatter edges from a1/p1/b1 must all be present.
    const edgeKeys = g.edges.map((e) => `${e.source}→${e.target}`).sort();
    assert.deepEqual(edgeKeys, ["a1→a2", "a1→ghost-x", "a2→ghost-x", "b1→a1", "b1→p1", "p1→ghost-x"]);

    const clusterKeys = g.clusters.map((c) => c.key);
    assert.ok(clusterKeys.includes("alpha") && clusterKeys.includes("people") && clusterKeys.includes("beta"));

    assert.ok(g.vault_name.startsWith("bastra-graph-test-"), "vault_name is the root folder's name");

    // building blocks: projects/* → "projects", people → "people"; the
    // coarse layer ships alongside the fine clusters
    assert.equal(a1.group, "projects");
    assert.equal(p1.group, "people");
    assert.equal(a1.sub, "general", "no sub-area folder → general");
    assert.equal(ghost.group, "projects", "ghost inherits a linker's group");
    const groupKeys = g.groups.map((x) => x.key);
    assert.ok(groupKeys.includes("projects") && groupKeys.includes("people"));
  } finally {
    await vault.stop?.();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("GET /api/v1/graph + /api/v1/graph/node over loopback", async () => {
  const { dir, vault } = await buildTestVault();
  // #217 Phase 3: Usage-Heat — a1 wurde geladen + angewandt, a2 nie.
  await recordUsage(dir, [
    { id: "a1", kind: "loaded", ts: new Date().toISOString() },
    { id: "a1", kind: "acted_on", ts: new Date().toISOString() },
  ]);
  const search = new SearchIndex(vault);
  search.start();
  const telemetry = new Telemetry();
  const handle = await startHttpServer({
    port: 0,
    vault,
    search,
    telemetry,
    version: "test",
    toolDeps: { vault, search, telemetry, vaultPath: dir },
    documentWriteEnabled: false,
    embedding: { on: false, providerId: null, source: "none" },
  });
  try {
    const g = await httpGet(handle.port!, "/api/v1/graph");
    assert.equal(g.status, 200);
    const graph = JSON.parse(g.body);
    assert.ok(Array.isArray(graph.nodes) && Array.isArray(graph.edges));
    assert.ok(graph.nodes.some((n: { kind: string }) => n.kind === "ghost"));

    // Heat erreicht den genutzten Node (einziger Nutzer → normiert auf 1),
    // ungenutzte Nodes tragen explizit 0 (#217: heat ist IMMER präsent, damit
    // ein kalter Node nicht byte-identisch zu „Feature fehlt" aussieht).
    const nodes = graph.nodes as { id: string; heat?: number }[];
    assert.equal(nodes.find((n) => n.id === "a1")?.heat, 1);
    assert.equal(nodes.find((n) => n.id === "a2")?.heat, 0);
    assert.equal((nodes.find((n) => n.id === "a1") as { created?: string })?.created, "2026-03-04");

    const node = await httpGet(handle.port!, "/api/v1/graph/node?id=a1");
    assert.equal(node.status, 200);
    const full = JSON.parse(node.body);
    assert.match(full.body, /Body of a1/);
    // memory browser reader: triggers, file relative to the vault, 30-day loads
    assert.deepEqual(full.recall_when, ["a1"]);
    assert.ok(typeof full.file === "string" && full.file.endsWith(".md") && !full.file.startsWith("/"), full.file);
    assert.ok(Array.isArray(full.recall_days) && Array.isArray(full.related_via));
    assert.ok(nodes.every((n) => Array.isArray((n as { recall_days?: unknown }).recall_days)), "recall_days is always stamped");

    const priv = await httpGet(handle.port!, "/api/v1/graph/node?id=secret");
    assert.equal(priv.status, 404, "private memory must 404");

    const missing = await httpGet(handle.port!, "/api/v1/graph/node?id=nope");
    assert.equal(missing.status, 404);
  } finally {
    search.stop();
    await vault.stop?.();
    await handle.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("graph node reference metadata excludes private targets but retains missing references", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-graph-private-links-"));
  const via = [
    { id: "public-target", reason: "Shared public topic", score: 0.8 },
    { id: "private-target", reason: "private-link-reason-marker", score: 0.9 },
    { id: "missing-target", reason: "Unwritten topic", score: 0.5 },
  ];
  await writeFile(join(dir, "parent.md"), memoryMarkdown("parent", {
    related: ["public-target", "private-target", "missing-target"],
  }).replace("created:", `related_via: ${JSON.stringify(via)}\ncreated:`));
  await writeFile(join(dir, "public.md"), memoryMarkdown("public-target"));
  await writeFile(join(dir, "private.md"), memoryMarkdown("private-target", { sensitivity: "private" }));
  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault); search.start();
  const telemetry = new Telemetry();
  const handle = await startHttpServer({
    port: 0, vault, search, telemetry, version: "test",
    toolDeps: { vault, search, telemetry, vaultPath: dir }, documentWriteEnabled: false,
    embedding: { on: false, providerId: null, source: "none" },
  });
  try {
    const node = await httpGet(handle.port!, "/api/v1/graph/node?id=parent");
    assert.equal(node.status, 200);
    const detail = JSON.parse(node.body);
    assert.deepEqual(detail.related_via, [via[0], via[2]], "typed links must suppress private IDs and their derived reasons");
    assert.deepEqual(detail.related, ["public-target", "missing-target"], "explicit links follow the same privacy boundary, preserving ghosts");
    assert.ok(!node.body.includes("private-target"));
    assert.ok(!node.body.includes("private-link-reason-marker"));
    assert.equal((await httpGet(handle.port!, "/api/v1/graph/node?id=private-target")).status, 404);
    const graph = JSON.parse((await httpGet(handle.port!, "/api/v1/graph")).body);
    assert.ok(!graph.nodes.some((n: { id: string }) => n.id === "private-target"));
    assert.ok(!graph.edges.some((e: { target: string }) => e.target === "private-target"));
  } finally {
    search.stop(); await vault.stop?.(); await handle.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("/ui: gated on ui.enabled, serves index, blocks traversal", async () => {
  const assetDir = await mkdtemp(join(tmpdir(), "bastra-webui-assets-"));
  const settingsDir = await mkdtemp(join(tmpdir(), "bastra-webui-settings-"));
  const settingsPath = join(settingsDir, "cli-settings.json");
  await writeFile(join(assetDir, "index.html"), "<!doctype html><title>map</title>");
  await writeFile(join(settingsDir, "outside.txt"), "secret");

  const server = createServer((req, res) => {
    void handleWebUi(req, res, req.url ?? "", assetDir, settingsPath);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;

  try {
    // disabled (no settings file) → 404 with the enable hint
    const off = await httpGet(port, "/ui/");
    assert.equal(off.status, 404);
    assert.match(off.body, /ui\.enabled/);

    await writeFile(settingsPath, JSON.stringify({ update: { mode: "notify" }, ui: { enabled: true } }));

    const redirect = await new Promise<number>((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port, path: "/ui", method: "GET" }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(redirect, 302, "/ui redirects to /ui/");

    const index = await httpGet(port, "/ui/");
    assert.equal(index.status, 200);
    assert.match(index.body, /<title>map<\/title>/);

    const traversal = await httpGet(port, "/ui/..%2F..%2Foutside.txt");
    assert.ok(traversal.status === 403 || traversal.status === 404, "traversal must not serve files");
    assert.ok(!traversal.body.includes("secret"));

    const unknownType = await httpGet(port, "/ui/evil.sh");
    assert.equal(unknownType.status, 404);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await rm(assetDir, { recursive: true, force: true });
    await rm(settingsDir, { recursive: true, force: true });
  }
});

test("vault care: annotate appends to vault-care.md, annotations parses it back", async () => {
  const vaultDir = await mkdtemp(join(tmpdir(), "bastra-care-vault-"));
  const settingsDir = await mkdtemp(join(tmpdir(), "bastra-care-settings-"));
  const settingsPath = join(settingsDir, "cli-settings.json");
  await writeFile(settingsPath, JSON.stringify({ update: { mode: "notify" }, ui: { enabled: true } }));

  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/ui/annotate") {
      void handleUiAnnotate(req, res, vaultDir, settingsPath);
    } else {
      void handleUiAnnotations(res, vaultDir, settingsPath);
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;

  const post = (payload: unknown): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
      const body = JSON.stringify(payload);
      const req = request(
        { hostname: "127.0.0.1", port, path: "/ui/annotate", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body).toString() } },
        (res) => {
          let b = "";
          res.on("data", (c) => (b += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
        },
      );
      req.on("error", reject);
      req.end(body);
    });

  try {
    // flag one memory for deletion, one ghost for writing
    assert.equal((await post({ id: "old-note", kind: "delete", note: "superseded by v2" })).status, 200);
    assert.equal((await post({ id: "ghost-x", kind: "write", note: "worth writing\nwith newline" })).status, 200);
    // invalid kind rejected
    assert.equal((await post({ id: "a", kind: "explode" })).status, 400);

    const list = await httpGet(port, "/ui/annotations");
    assert.equal(list.status, 200);
    const { annotations } = JSON.parse(list.body);
    assert.equal(annotations.length, 2);
    assert.deepEqual(
      annotations.map((a: { id: string; kind: string; done: boolean }) => [a.id, a.kind, a.done]),
      [["old-note", "delete", false], ["ghost-x", "write", false]],
    );
    assert.ok(!annotations[1].note.includes("\n"), "newlines are flattened");

    // the file itself is the open format: checkbox lines with wikilinks,
    // and ticking [x] by hand (Obsidian / AI session) marks it done
    const raw = await readFile(join(vaultDir, CARE_FILE), "utf8");
    assert.match(raw, /- \[ \] \d{4}-\d{2}-\d{2} · delete · \[\[old-note\]\] — superseded by v2/);
    const ticked = raw.replace("- [ ] ", "- [x] ");
    assert.equal(parseCareFile(ticked).filter((a) => a.done).length, 1);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await rm(vaultDir, { recursive: true, force: true });
    await rm(settingsDir, { recursive: true, force: true });
  }
});
