/**
 * #1727: the `recall` tool has two transports. REST runs `recallHandler`; the
 * stdio forwarder streams `/hook/recall` (`callRecallStreaming`). The same
 * arguments must have the same effect on both for `min_score`, `verbosity`
 * and near-duplicate `queries`. Conflict flags and Commons hits are not part
 * of this parity (see the issue); hook lanes keep their payload.
 *
 * A real daemon HTTP server over a temporary vault, BM25 only (no embedding
 * model), so scores are stable raw BM25 values on both paths.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex } from "@bastra-recall/core";
import { startHttpServer } from "../src/http.js";
import { Telemetry } from "../src/telemetry.js";
import { recallHandler } from "../src/recall-handler.js";

function memo(id: string, body: string, reflex = false): string {
  return [
    "---",
    `id: ${id}`,
    `title: Note ${id}`,
    "type: lesson",
    `summary: ${body}`,
    "topic_path:",
    "  - test",
    "tags:",
    "  - test",
    "scope: fixture",
    ...(reflex ? ["recall_mode: reflex"] : []),
    "created: 2026-01-01",
    "updated: 2026-01-02",
    "---",
    "",
    body,
    "",
  ].join("\n");
}

type Hit = { id: string; score: number } & Record<string, unknown>;
type Result = { hits: Hit[]; reflex_hits?: Hit[] } & Record<string, unknown>;

// The forwarder reads its daemon URL once at import, so all tests share one server.
let ctx: Awaited<ReturnType<typeof setup>>;
before(async () => {
  ctx = await setup();
});
after(async () => {
  await ctx.close();
});

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "bastra-fwd-parity-"));
  await writeFile(join(dir, "deploy-a.md"), memo("deploy-a", "deploy release branch smoke test tag deploy release"));
  await writeFile(join(dir, "deploy-b.md"), memo("deploy-b", "deploy release checklist"));
  await writeFile(join(dir, "deploy-c.md"), memo("deploy-c", "release rollback notes and many other words here"));
  // Wired but weakly matching: below the top-k cut, served as a pool reflex.
  await writeFile(join(dir, "reflex.md"), memo("reflex", "unrelated coffee words and one release", true));
  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  const telemetry = new Telemetry();
  const toolDeps = { vault, search, telemetry, vaultPath: dir };
  const handle = await startHttpServer({
    port: 0,
    vault,
    search,
    telemetry,
    version: "test",
    toolDeps,
    documentWriteEnabled: false,
    embedding: { on: false, providerId: null, source: "none" },
  });
  process.env.BASTRA_DAEMON_URL = `http://127.0.0.1:${handle.port}`;
  const { callRecallStreaming } = await import("../src/mcp-forwarder-calls.js");
  return {
    port: handle.port,
    close: async () => {
      search.stop();
      await vault.stop?.();
      await handle.close();
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
    rest: async (args: Record<string, unknown>) => (await recallHandler(toolDeps, args)) as unknown as Result,
    forwarder: async (args: Record<string, unknown>) =>
      (await callRecallStreaming(args, () => undefined)) as unknown as Result,
  };
}

const ids = (r: Result) => r.hits.map((h) => h.id);
const reflexIds = (r: Result) => (r.reflex_hits ?? []).map((h) => h.id);

test("#1727: min_score drops the same hits and reflexes on both transports", async () => {
  const { rest, forwarder } = ctx;
  const unfloored = await rest({ query: "deploy release", k: 2, min_score: 0 });
  assert.equal(unfloored.hits.length, 2, "fixture: two ranked hits");
  assert.deepEqual(reflexIds(unfloored), ["reflex"], "fixture: the wired memory rides as a pool reflex");
  // A floor between the two ranked hits: only the best one survives, and the
  // weak reflex below it goes too.
  const [best, second] = unfloored.hits.map((h) => h.score);
  const floor = (best! + second!) / 2;
  const args = { query: "deploy release", k: 2, min_score: floor };
  const viaRest = await rest(args);
  const viaForwarder = await forwarder(args);
  assert.deepEqual(ids(viaRest), [unfloored.hits[0]!.id]);
  assert.deepEqual(reflexIds(viaRest), []);
  assert.deepEqual(ids(viaForwarder), ids(viaRest), "ranked hits");
  assert.deepEqual(reflexIds(viaForwarder), reflexIds(viaRest), "pool reflexes");
  assert.deepEqual(
    ids(await forwarder({ query: "deploy release", k: 2, min_score: 0 })),
    ids(unfloored),
    "a zero floor keeps every hit on the forwarder too"
  );
});

test("#1727: verbosity selects the same projection on both transports", async () => {
  const { rest, forwarder } = ctx;
  const fullOnly = ["matched_terms", "mode", "topic_path"];
  // min_score 0: BM25 scores of this small vault sit below REST's default
  // floor of 30, and the default floor is not part of this parity.
  const args = { query: "deploy release", k: 2, min_score: 0 };
  for (const [label, result] of [
    ["rest", await rest({ ...args, verbosity: "full" })],
    ["forwarder", await forwarder({ ...args, verbosity: "full" })],
  ] as const) {
    assert.ok(result.hits.length > 0, `${label}: fixture must produce hits`);
    for (const hit of result.hits)
      for (const key of fullOnly) assert.ok(key in hit, `${label} full: ${hit.id} carries ${key}`);
    assert.equal(typeof result.stages, "object", `${label} full: stage timings`);
  }
  for (const [label, result] of [
    ["rest", await rest(args)],
    ["forwarder", await forwarder(args)],
  ] as const) {
    for (const hit of result.hits)
      for (const key of fullOnly) assert.equal(key in hit, false, `${label} lean: ${hit.id} without ${key}`);
    assert.equal("stages" in result, false, `${label} lean: no stage timings`);
  }
  // A batch keeps the projection per hit, as on REST.
  const batch = await forwarder({ queries: ["deploy release", "rollback notes"], verbosity: "full", min_score: 0 });
  for (const hit of batch.hits) assert.ok("matched_terms" in hit, `forwarder full batch: ${hit.id}`);
});

test("#1727: near-duplicate queries collapse before the forwarder fans out", async () => {
  const { rest, forwarder } = ctx;
  // The second phrasing remixes the first: same content tokens plus one.
  const args = {
    queries: ["deploy release branch", "release deploy branch smoke", "rollback notes"],
    k: 3,
    min_score: 0,
  };
  const viaRest = await rest(args);
  const viaForwarder = await forwarder(args);
  assert.equal(viaRest.queries_collapsed, 1, "fixture: REST collapses the remix");
  assert.equal(viaForwarder.queries_collapsed, viaRest.queries_collapsed);
  assert.equal(viaForwarder.note, viaRest.note);
  assert.equal(viaForwarder.query_count, viaRest.query_count, "the submitted count");
  assert.equal(
    (viaForwarder.recall_ids as string[]).length,
    (viaRest.recall_ids as string[]).length,
    "one sub-recall per kept query"
  );
  assert.equal(viaForwarder.query, viaRest.query, "the merged query names the kept phrasings");
  assert.deepEqual(ids(viaForwarder), ids(viaRest));
  // Distinct phrasings are not touched.
  const distinct = await forwarder({ queries: ["deploy release", "rollback notes"] });
  assert.equal("queries_collapsed" in distinct, false);
  assert.equal((distinct.recall_ids as string[]).length, 2);
});

test("#1727: hook lanes send neither field and keep their payload", async () => {
  const { port } = ctx;
  const lane = (await (
    await fetch(`http://127.0.0.1:${port}/hook/recall`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "deploy release", k: 2, hook_source: "prompt" }),
    })
  ).json()) as Result;
  assert.ok(lane.hits.length > 0);
  assert.equal("stages" in lane, false);
  for (const hit of lane.hits) assert.equal("matched_terms" in hit, false, hit.id);
});
