/**
 * #362 — der Query-Router auf der Hook-Pipeline: Schatten zuerst.
 *
 *  - `shadow` (Default): der dichte Arm läuft wie bisher, die Antwort ist
 *    unverändert; die `hook_recall`-Zeile trägt `query_route` mit der Zeit,
 *    die ein BM25-only-Lauf gespart hätte.
 *  - `live`: eine geroutete Anfrage fragt den dichten Arm gar nicht, und die
 *    Antwort sagt ehrlich, dass sie einarmig ist — ohne `degraded`.
 *  - `off`: nichts wird gerechnet.
 *  - Eine gewöhnliche Anfrage und ein `lexical_only`-Aufrufer bekommen keine
 *    Routerzeile.
 *
 * Runner: node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/query-router-shadow.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex } from "@bastra-recall/core";
import { Telemetry } from "../src/telemetry.js";
import { runHookRecall, queryRouterMode } from "../src/http-hook-routes.js";

function memo(id: string, body: string): string {
  return [
    "---", `id: ${id}`, `title: Regel ${id}`, "type: lesson", `summary: ${body}`,
    "topic_path:", "  - test", "tags:", "  - test", "recall_when:", "  - wenn wir deployen",
    "created: 2026-01-01", "updated: 2026-01-01", "---", "", body, "",
  ].join("\n");
}

async function readEvents(logDir: string, kind: string): Promise<Record<string, unknown>[]> {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 40));
    let files: string[];
    try { files = await readdir(logDir); } catch { continue; }
    const out: Record<string, unknown>[] = [];
    for (const f of files.filter((n) => n.startsWith("events-"))) {
      const raw = await readFile(join(logDir, f), "utf8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        const ev = JSON.parse(line) as Record<string, unknown>;
        if (ev.kind === kind) out.push(ev);
      }
    }
    if (out.length > 0) return out;
  }
  return [];
}

async function setup(t: { after: (fn: () => unknown) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "bastra-router-vault-"));
  const logDir = await mkdtemp(join(tmpdir(), "bastra-router-logs-"));
  await writeFile(join(dir, "a.md"), memo("a", "deployen über den Release-Branch mit Smoke-Test"), "utf8");
  await writeFile(join(dir, "b.md"), memo("b", "deployen erst nach dem Tag und der Freigabe"), "utf8");
  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  let denseCalls = 0;
  search.useEmbeddings({
    size: () => 2,
    runtimeHealth: () => ({ errorCount: 0 }),
    searchDetailed: async () => {
      denseCalls++;
      return { outcome: "hits", hits: [{ id: "a", score: 0.9 }, { id: "b", score: 0.8 }], providerLoadMs: null, coldStartObserved: false };
    },
  } as never);
  const prev = process.env.BASTRA_LOG_PATH;
  process.env.BASTRA_LOG_PATH = logDir;
  const telemetry = new Telemetry();
  if (prev === undefined) delete process.env.BASTRA_LOG_PATH;
  else process.env.BASTRA_LOG_PATH = prev;
  t.after(async () => {
    search.stop();
    await vault.stop?.();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    await rm(logDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return { deps: { vault, search, telemetry }, logDir, denseCalls: () => denseCalls };
}

async function withRouter<T>(mode: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.BASTRA_QUERY_ROUTER;
  if (mode === undefined) delete process.env.BASTRA_QUERY_ROUTER;
  else process.env.BASTRA_QUERY_ROUTER = mode;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.BASTRA_QUERY_ROUTER;
    else process.env.BASTRA_QUERY_ROUTER = prev;
  }
}

test("#362: der Default ist shadow, unbekannte Werte auch", async () => {
  await withRouter(undefined, async () => assert.equal(queryRouterMode(), "shadow"));
  await withRouter("LIVE", async () => assert.equal(queryRouterMode(), "shadow"));
  await withRouter("live", async () => assert.equal(queryRouterMode(), "live"));
  await withRouter("off", async () => assert.equal(queryRouterMode(), "off"));
});

test("#362: shadow — der dichte Arm läuft, die Zeile trägt die Messuhr", async (t) => {
  const s = await setup(t);
  const res = await withRouter(undefined, () => runHookRecall({ query: "deployen" }, "deployen", Date.now(), s.deps));
  assert.equal(s.denseCalls(), 1, "im Schatten ändert sich am Arm nichts");
  assert.equal(res.score_kind, "rrf");
  const [row] = await readEvents(s.logDir, "hook_recall");
  const route = row!.query_route as Record<string, unknown>;
  assert.equal(route.mode, "shadow");
  assert.equal(route.applied, false);
  assert.equal(route.reason, "short");
  assert.equal(typeof route.would_save_ms, "number");
});

test("#362: live — eine geroutete Anfrage fragt den dichten Arm nicht, ehrlich einarmig", async (t) => {
  const s = await setup(t);
  const res = await withRouter("live", () => runHookRecall({ query: "deployen" }, "deployen", Date.now(), s.deps));
  assert.equal(s.denseCalls(), 0);
  assert.equal(res.score_kind, "bm25");
  assert.equal(res.unfused, true);
  assert.equal(res.degraded, undefined, "abgewählt ist nicht ausgefallen");
  const [row] = await readEvents(s.logDir, "hook_recall");
  const route = row!.query_route as Record<string, unknown>;
  assert.equal(route.applied, true);
  assert.equal(route.would_save_ms, undefined);
  assert.equal(row!.lexical_only, undefined, "lexical_only bleibt die Aussage des Aufrufers");
});

test("#362: live — eine gewöhnliche Anfrage bleibt hybrid und ohne Routerzeile", async (t) => {
  const s = await setup(t);
  const q = "wie deployen wir das nach dem Tag";
  const res = await withRouter("live", () => runHookRecall({ query: q }, q, Date.now(), s.deps));
  assert.equal(s.denseCalls(), 1);
  assert.equal(res.score_kind, "rrf");
  const [row] = await readEvents(s.logDir, "hook_recall");
  assert.equal(row!.query_route, undefined);
});

test("#362: off und lexical_only — keine Routerzeile", async (t) => {
  const s = await setup(t);
  await withRouter("off", () => runHookRecall({ query: "deployen" }, "deployen", Date.now(), s.deps));
  await withRouter(undefined, () =>
    runHookRecall({ query: "deployen", lexical_only: true }, "deployen", Date.now(), s.deps),
  );
  let all = await readEvents(s.logDir, "hook_recall");
  // Die zweite Zeile kann einen Tick nach der ersten landen.
  for (let i = 0; i < 20 && all.length < 2; i++) all = await readEvents(s.logDir, "hook_recall");
  assert.equal(all.length, 2);
  for (const row of all) assert.equal(row.query_route, undefined);
});
