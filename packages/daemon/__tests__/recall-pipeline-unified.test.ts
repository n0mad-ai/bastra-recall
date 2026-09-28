/**
 * #421 — eine Recall-Pipeline für Hook- und MCP-Aufrufer.
 *
 * Ein Client ohne Hooks (MCP-only) bekam bis hierher keinen Scope-Filter und
 * keine Reflex-Hits: Der Forwarder warf die `reflex_hits` der Hook-Pipeline in
 * seiner Projektion weg und schickte kein Projekt, und der `recallHandler`
 * (stdio-Server) kannte beides nicht. Geprüft wird:
 *
 *  1. `recallHandler` liefert Pool-Reflexe, die der top-k-Schnitt ausließ.
 *  2. `recallHandler` wendet mit Aufrufer-Projekt den Scope-Filter der
 *     Prompt-Lane an — `shadow` misst, `enforce` verwirft, ein expliziter
 *     `scope` schaltet ihn ab.
 *  3. `runHookRecall` mit `apply_scope_filter` (der Forwarder-Weg) filtert
 *     genauso; OHNE das Feld (die Hook-Lanes) bleibt die Antwort unverändert
 *     und die Telemetriezeile trägt keine neuen Felder.
 *  4. Die Forwarder-Projektion und der Batch-Merge reichen `reflex_hits` durch.
 *
 * Runner: node --import tsx --test packages/daemon/__tests__/recall-pipeline-unified.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex } from "@bastra-recall/core";
import { Telemetry } from "../src/telemetry.js";
import { recallHandler, type ToolDeps } from "../src/tool-handlers.js";
import { runHookRecall } from "../src/http-hook-routes.js";
import { mergeBatchResults, projectRecallResult } from "../src/recall-batch.js";
import { applyCallerScopeFilter, collectPoolReflexHits } from "../src/recall-pipeline.js";

function memo(o: { id: string; scope: string; body: string; reflex?: boolean }): string {
  return [
    "---",
    `id: ${o.id}`,
    `title: Regel ${o.id}`,
    "type: lesson",
    `summary: ${o.body}`,
    "topic_path:",
    "  - test",
    "tags:",
    "  - test",
    `scope: ${o.scope}`,
    ...(o.reflex ? ["recall_mode: reflex"] : []),
    "created: 2026-01-01",
    "updated: 2026-01-01",
    "---",
    "",
    o.body,
    "",
  ].join("\n");
}

const MEMORIES = [
  { id: "alpha-1", scope: "alpha", body: "deploy release branch smoke test tag deploy release" },
  { id: "alpha-2", scope: "alpha", body: "deploy release branch checklist deploy" },
  { id: "beta-1", scope: "beta", body: "deploy release branch smoke test tag deploy release branch" },
  // Verdrahtet, aber schwach passend: landet unter dem top-k-Schnitt.
  { id: "alpha-reflex", scope: "alpha", body: "unrelated words about coffee and one deploy", reflex: true },
];

async function makeDeps(t: { after: (fn: () => unknown) => void }): Promise<{ deps: ToolDeps; logDir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-421-vault-"));
  for (const m of MEMORIES) await writeFile(join(dir, `${m.id}.md`), memo(m), "utf8");
  const logDir = await mkdtemp(join(tmpdir(), "bastra-421-logs-"));
  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
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
  return { deps: { vault, search, telemetry, vaultPath: dir }, logDir };
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

function withScopeMode<T>(mode: "enforce" | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.BASTRA_SCOPE_FILTER_LANES;
  if (mode) process.env.BASTRA_SCOPE_FILTER_LANES = mode;
  else delete process.env.BASTRA_SCOPE_FILTER_LANES;
  return fn().finally(() => {
    if (prev === undefined) delete process.env.BASTRA_SCOPE_FILTER_LANES;
    else process.env.BASTRA_SCOPE_FILTER_LANES = prev;
  });
}

const ids = (xs: unknown): string[] => ((xs as Array<{ id: string }> | undefined) ?? []).map((h) => h.id);

// ── 1. Reflex-Hits für einen MCP-only-Client ─────────────────────

test("#421: recallHandler liefert verdrahtete Reflexe unter dem top-k-Schnitt", async (t) => {
  const { deps } = await makeDeps(t);
  const res = (await recallHandler(deps, { query: "deploy release branch", k: 1, min_score: 0 })) as unknown as Record<string, unknown>;
  assert.equal(ids(res.hits).length, 1);
  assert.ok(!ids(res.hits).includes("alpha-reflex"), "Fixture: der Reflex darf nicht im top-1 stehen");
  assert.deepEqual(ids(res.reflex_hits), ["alpha-reflex"]);
  const reflex = (res.reflex_hits as Array<Record<string, unknown>>)[0]!;
  assert.equal(reflex.recall_mode, "reflex");
});

test("#421: Reflexe passieren denselben Floor wie die gerankten Treffer", async (t) => {
  const { deps } = await makeDeps(t);
  const res = (await recallHandler(deps, { query: "deploy release branch", k: 1, min_score: 1e9 })) as unknown as Record<string, unknown>;
  assert.equal(res.reflex_hits, undefined, "unter dem Floor kein Reflex — und kein leeres Feld");
});

// ── 2. Scope-Filter für einen MCP-only-Client ────────────────────

test("#421: recallHandler mit Projekt — enforce verwirft fremde Scopes, shadow misst nur", async (t) => {
  const { deps, logDir } = await makeDeps(t);
  const args = { query: "deploy release branch", k: 5, min_score: 0 };

  const shadow = (await withScopeMode(undefined, () => recallHandler(deps, args, { project: "alpha" }))) as unknown as Record<string, unknown>;
  assert.ok(ids(shadow.hits).includes("beta-1"), "shadow verwirft nichts");

  const enforced = (await withScopeMode("enforce", () => recallHandler(deps, args, { project: "alpha" }))) as unknown as Record<string, unknown>;
  assert.ok(!ids(enforced.hits).includes("beta-1"), "enforce verwirft den fremden Scope");
  assert.ok(ids(enforced.hits).includes("alpha-1"), "der eigene Scope bleibt");

  const events = await readEvents(logDir, "recall");
  const shadowRow = events.find((e) => e.scope_filter_mode === "shadow");
  assert.ok(shadowRow, "die shadow-Zeile trägt ihre Filterstufe");
  assert.equal(shadowRow!.dropped_scope_count, 1);
  assert.deepEqual(shadowRow!.dropped_scopes, ["beta"]);
  assert.equal(shadowRow!.filter_project, "alpha");
});

test("#421: ein expliziter scope schaltet den Projektfilter ab", async (t) => {
  const { deps } = await makeDeps(t);
  const res = (await withScopeMode("enforce", () =>
    recallHandler(deps, { query: "deploy release branch", k: 5, min_score: 0, scope: "beta" }, { project: "alpha" }),
  )) as unknown as Record<string, unknown>;
  assert.ok(ids(res.hits).includes("beta-1"), "verlangt ist verlangt");
});

test("#421: ohne Transport-Projekt keine Filterfelder auf der recall-Zeile", async (t) => {
  const { deps, logDir } = await makeDeps(t);
  await recallHandler(deps, { query: "deploy release branch", k: 5, min_score: 0 });
  const [row] = await readEvents(logDir, "recall");
  assert.ok(row);
  assert.equal(row!.scope_filter_mode, undefined);
  assert.equal(row!.dropped_scope_count, undefined);
});

// ── 3. Derselbe Schritt auf der Hook-Pipeline ────────────────────

test("#421: runHookRecall mit apply_scope_filter (Forwarder) filtert wie recallHandler", async (t) => {
  const { deps, logDir } = await makeDeps(t);
  const hookDeps = { vault: deps.vault, search: deps.search, telemetry: deps.telemetry };
  const res = await withScopeMode("enforce", () =>
    runHookRecall(
      { query: "deploy release branch", k: 5, apply_scope_filter: true, project: "alpha", hook_source: "mcp" },
      "deploy release branch",
      Date.now(),
      hookDeps,
    ),
  );
  assert.ok(!ids(res.hits).includes("beta-1"));
  assert.ok(ids(res.hits).includes("alpha-1"));
  const [row] = await readEvents(logDir, "hook_recall");
  assert.equal(row!.scope_filter_mode, "enforce");
  assert.equal(row!.dropped_scope_count, 1);
});

test("#421: runHookRecall OHNE das Feld (Hook-Lanes) bleibt unverändert", async (t) => {
  const { deps, logDir } = await makeDeps(t);
  const hookDeps = { vault: deps.vault, search: deps.search, telemetry: deps.telemetry };
  const res = await withScopeMode("enforce", () =>
    runHookRecall({ query: "deploy release branch", k: 5, project: "alpha" }, "deploy release branch", Date.now(), hookDeps),
  );
  assert.ok(ids(res.hits).includes("beta-1"), "die Lanes filtern selbst — der Daemon tut es für sie nicht");
  const [row] = await readEvents(logDir, "hook_recall");
  assert.ok(row);
  for (const f of ["scope_filter_mode", "dropped_scope_count", "dropped_scopes", "filter_project", "scope_filter_skipped"]) {
    assert.equal(row![f], undefined, `${f} darf auf einer Hook-Zeile nicht auftauchen`);
  }
});

test("#421: runHookRecall liefert dieselben Pool-Reflexe wie recallHandler", async (t) => {
  const { deps } = await makeDeps(t);
  const hookDeps = { vault: deps.vault, search: deps.search, telemetry: deps.telemetry };
  const hook = await runHookRecall({ query: "deploy release branch", k: 1, expand_hops: 0 }, "deploy release branch", Date.now(), hookDeps);
  const mcp = (await recallHandler(deps, { query: "deploy release branch", k: 1, min_score: 0 })) as unknown as Record<string, unknown>;
  assert.deepEqual(ids(hook.reflex_hits), ["alpha-reflex"]);
  assert.deepEqual(ids(hook.reflex_hits), ids(mcp.reflex_hits));
});

// ── 4. Forwarder-Projektion und Batch ────────────────────────────

test("#421: projectRecallResult reicht reflex_hits durch, ein leeres Feld nicht", () => {
  const reflex = [{ id: "r", score: 50, recall_mode: "reflex" }];
  const withReflex = projectRecallResult("q", { hits: [], vault_size: 1, recall_id: "x", reflex_hits: reflex });
  assert.deepEqual(withReflex.reflex_hits, reflex);
  const without = projectRecallResult("q", { hits: [], vault_size: 1, recall_id: "x", reflex_hits: [] });
  assert.equal("reflex_hits" in without, false);
});

test("#421: der Batch-Merge vereinigt Reflexe und lässt gerankte Treffer weg", () => {
  const merged = mergeBatchResults(
    ["a", "b"],
    [
      { hits: [{ id: "h1", score: 90 }], score_kind: "rrf", reflex_hits: [{ id: "r1", score: 40 }, { id: "h1", score: 10 }] },
      { hits: [{ id: "h2", score: 80 }], score_kind: "rrf", reflex_hits: [{ id: "r1", score: 60 }] },
    ],
    5,
  );
  assert.deepEqual(merged.reflex_hits, [{ id: "r1", score: 60 }]);
});

// ── Die Bausteine selbst ─────────────────────────────────────────

test("#421: collectPoolReflexHits nimmt nur Verdrahtetes, nicht Serviertes", () => {
  const mems: Record<string, { fm: Record<string, unknown> }> = {
    r: { fm: { title: "R", type: "convention", scope: "alpha", summary: "s", recall_mode: "reflex" } },
    n: { fm: { title: "N", type: "convention", scope: "alpha", summary: "s" } },
  };
  const vault = { get: (id: string) => mems[id] } as unknown as Parameters<typeof collectPoolReflexHits>[2];
  const out = collectPoolReflexHits([{ id: "r", score: 5 }, { id: "n", score: 9 }], new Set(), vault);
  assert.deepEqual(out.map((h) => h.id), ["r"]);
  assert.deepEqual(collectPoolReflexHits([{ id: "r", score: 5 }], new Set(["r"]), vault), []);
  assert.deepEqual(collectPoolReflexHits([{ id: "r", score: 5 }], new Set(), vault, 6), []);
});

test("#421: applyCallerScopeFilter lässt verdrahtete Reflexe immer durch", () => {
  const mems: Record<string, { fm: Record<string, unknown> }> = {
    own: { fm: { scope: "alpha" } },
    foreignReflex: { fm: { scope: "beta", recall_mode: "reflex" } },
    foreign: { fm: { scope: "beta" } },
  };
  const vault = {
    get: (id: string) => mems[id],
    list: () => Object.values(mems),
  } as unknown as Parameters<typeof applyCallerScopeFilter>[1]["vault"];
  const hits = [
    { id: "own", scope: "alpha", score: 90 },
    { id: "foreignReflex", scope: "beta", score: 80 },
    { id: "foreign", scope: "beta", score: 70 },
  ];
  const r = applyCallerScopeFilter(hits, { project: "alpha", explicitScope: false, unfused: false, vault, mode: "enforce" });
  assert.deepEqual(r.hits.map((h) => h.id), ["own", "foreignReflex"]);
  assert.equal(r.telemetry.dropped_scope_count, 1);
});
