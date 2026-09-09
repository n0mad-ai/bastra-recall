/**
 * #487 — `max_tokens` als Kontextbudget EINES recall-Aufrufs.
 *
 * Geprüft wird, was das Issue zusagt:
 *
 *  1. OHNE den Parameter ändert sich nichts. Weder an der Antwort (keine
 *     Budgetfelder, gleicher Schlüsselsatz) noch am Weg dorthin — die
 *     Budgetfunktion baut das Ergebnis genau einmal, aus derselben Liste.
 *  2. MIT dem Parameter überschreitet das Payload das Budget nicht, und es
 *     bleibt bei der Toleranz EINES Treffers: der nächste hätte es gerissen.
 *  3. `k` bleibt die harte Obergrenze — das Budget kann nur streichen.
 *  4. Die Antwort sagt, dass sie gekürzt ist, und um wie viele Treffer.
 *  5. Die Telemetrie hält beides fest: angefordertes Budget und ausgeliefertes
 *     Payload (#457 muss die Ersparnis zuordnen können).
 *  6. Der Hook-Pfad (`/hook/recall`) kann dasselbe — das ist der Weg, den ein
 *     MCP-Client über den Forwarder wirklich geht.
 *
 * Runner: node --import tsx --test packages/daemon/__tests__/recall-max-tokens.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { Vault, SearchIndex } from "@bastra-recall/core";
import { Telemetry } from "../src/telemetry.js";
import { startHttpServer } from "../src/http.js";
import { recallHandler, type ToolDeps } from "../src/tool-handlers.js";
import { fitRecallToBudget, measurePayload } from "../src/recall-budget.js";

/** Lang genug, dass ein Treffer spürbar Budget kostet. */
const SUMMARY =
  "Deployment läuft über den Release-Branch, danach Smoke-Test und erst dann " +
  "der Tag — abgesprochen im Team, gilt für jedes Deployment dieses Projekts.";

function memo(id: string, n: number): string {
  return [
    "---",
    `id: ${id}`,
    `title: Deployment-Regel ${n}`,
    "type: lesson",
    `summary: ${SUMMARY}`,
    "topic_path:",
    "  - test",
    "tags:",
    "  - test",
    "scope: budget-test",
    "recall_when:",
    "  - wenn wir deployen",
    "created: 2026-01-01",
    "updated: 2026-01-01",
    "---",
    "",
    `Text über deployen, Nummer ${n}.`,
    "",
  ].join("\n");
}

async function vaultDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-budget-vault-"));
  for (let i = 1; i <= 8; i++) await writeFile(join(dir, `m${i}.md`), memo(`m${i}`, i), "utf8");
  return dir;
}

async function makeDeps(t: { after: (fn: () => unknown) => void }): Promise<{ deps: ToolDeps; logDir: string }> {
  const dir = await vaultDir();
  const logDir = await mkdtemp(join(tmpdir(), "bastra-budget-logs-"));
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

/** Alles, was zwischen zwei identischen Aufrufen verschieden sein DARF. */
function stable(res: Record<string, unknown>): Record<string, unknown> {
  const { recall_id, latency_ms, ...rest } = res;
  void recall_id;
  void latency_ms;
  return rest;
}

// ── 1. Ohne den Parameter ändert sich nichts ─────────────────────

test("#487: ohne max_tokens baut die Budgetfunktion genau einmal, aus derselben Liste", () => {
  const hits = [{ id: "a" }, { id: "b" }];
  let calls = 0;
  const { payload, dropped } = fitRecallToBudget(hits, undefined, (emitted, droppedByBudget) => {
    calls++;
    assert.equal(emitted, hits, "die Liste geht unverändert durch — keine Kopie, keine Kürzung");
    assert.equal(droppedByBudget, 0);
    return { hits: emitted };
  });
  assert.equal(calls, 1, "ohne Budget wird nichts gemessen und nichts neu gebaut");
  assert.equal(dropped, 0);
  assert.equal(payload.hits, hits);
});

test("#487: eine Antwort ohne max_tokens trägt keine Budgetfelder", async (t) => {
  const { deps } = await makeDeps(t);
  const res = (await recallHandler(deps, { query: "deployen", k: 5, min_score: 0 })) as unknown as Record<string, unknown>;
  assert.ok((res.hits as unknown[]).length > 1, "der Vault muss mehrere Treffer liefern");
  assert.equal(res.truncated_by_budget, undefined);
  assert.equal(res.dropped_by_budget, undefined);
  assert.ok(
    !JSON.stringify(res).includes("_by_budget"),
    "kein Budgetfeld irgendwo in der Antwort — auch nicht in einem Hit",
  );
});

test("#487: ein Budget, das reicht, liefert byte-gleich zur Antwort ohne Budget", async (t) => {
  const { deps } = await makeDeps(t);
  const ohne = (await recallHandler(deps, { query: "deployen", k: 5, min_score: 0 })) as unknown as Record<string, unknown>;
  const mit = (await recallHandler(deps, {
    query: "deployen",
    k: 5,
    min_score: 0,
    max_tokens: 100_000,
  })) as unknown as Record<string, unknown>;
  assert.equal(
    JSON.stringify(stable(mit), null, 2),
    JSON.stringify(stable(ohne), null, 2),
    "ein Budget, das nie greift, darf die Antwort nicht anfassen",
  );
});

// ── 2./3./4. Mit Budget: Grenze, Toleranz, Meldung ───────────────

test("#487: das Payload bleibt im Budget, um höchstens einen Treffer daneben", async (t) => {
  const { deps } = await makeDeps(t);
  const voll = (await recallHandler(deps, { query: "deployen", k: 8, min_score: 0 })) as unknown as Record<string, unknown>;
  const alle = (voll.hits as unknown[]).length;
  assert.ok(alle >= 4, `der Vault muss genug Treffer liefern, waren ${alle}`);
  // Ein Budget mitten zwischen „nichts" und „alles".
  const budget = Math.floor(measurePayload(voll).tokens / 2);
  const res = (await recallHandler(deps, {
    query: "deployen",
    k: 8,
    min_score: 0,
    max_tokens: budget,
  })) as unknown as Record<string, unknown>;
  const emitted = (res.hits as unknown[]).length;
  assert.ok(emitted > 0 && emitted < alle, `gekürzt, aber nicht leer — waren ${emitted} von ${alle}`);
  assert.ok(
    measurePayload(res).tokens <= budget,
    `das Payload (${measurePayload(res).tokens}) muss ins Budget (${budget}) passen`,
  );
  // Die Toleranz IST ein Treffer: der nächste hätte das Budget gerissen.
  const einerMehr = { ...res, hits: (voll.hits as unknown[]).slice(0, emitted + 1) };
  assert.ok(
    measurePayload(einerMehr).tokens > budget,
    "es wurde nicht mehr weggelassen als nötig",
  );
  assert.equal(res.truncated_by_budget, true);
  assert.equal(res.dropped_by_budget, alle - emitted);
});

test("#487: k bleibt die harte Obergrenze — ein großes Budget liefert nicht mehr", async (t) => {
  const { deps } = await makeDeps(t);
  const res = (await recallHandler(deps, {
    query: "deployen",
    k: 2,
    min_score: 0,
    max_tokens: 100_000,
  })) as unknown as Record<string, unknown>;
  assert.ok((res.hits as unknown[]).length <= 2, "das Budget hebt k nicht auf");
  assert.equal(res.truncated_by_budget, undefined, "k ist keine Budgetkürzung");
});

// ── 5. Telemetrie: angefordert gegen ausgeliefert ────────────────

test("#487: die Telemetrie hält Budget und ausgeliefertes Payload nebeneinander", async (t) => {
  const { deps, logDir } = await makeDeps(t);
  const voll = (await recallHandler(deps, { query: "deployen", k: 8, min_score: 0 })) as unknown as Record<string, unknown>;
  const budget = Math.floor(measurePayload(voll).tokens / 2);
  const res = (await recallHandler(deps, {
    query: "deployen",
    k: 8,
    min_score: 0,
    max_tokens: budget,
  })) as unknown as Record<string, unknown>;
  const events = (await readEvents(logDir, "recall")).filter((e) => e.max_tokens !== undefined);
  assert.equal(events.length, 1, "genau der Aufruf mit Budget trägt die Spalte");
  assert.equal(events[0].max_tokens, budget, "das ANGEFORDERTE Budget");
  assert.equal(
    events[0].payload_tokens_est,
    measurePayload(res).tokens,
    "das AUSGELIEFERTE Payload — ohne beide Zahlen ist keine Ersparnis zuzuordnen",
  );
  assert.equal(events[0].dropped_by_budget, res.dropped_by_budget);
});

// ── 6. Derselbe Parameter auf dem Hook-Pfad ──────────────────────

function httpPost(port: number, path: string, payload: unknown): Promise<Record<string, unknown>> {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => resolve(JSON.parse(raw || "{}") as Record<string, unknown>));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

test("#487: /hook/recall kürzt auf dasselbe Budget und meldet es", async (t) => {
  const dir = await vaultDir();
  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  const telemetry = new Telemetry();
  const handle = await startHttpServer({
    port: 0, vault, search, telemetry, version: "test",
    toolDeps: { vault, search, telemetry, vaultPath: dir },
    documentWriteEnabled: false,
    embedding: { on: false, providerId: "none", source: "none" },
  });
  t.after(async () => {
    search.stop();
    await vault.stop?.();
    await handle.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const port = handle.port!;
  const voll = await httpPost(port, "/hook/recall", { query: "deployen", k: 8, min_score: 0 });
  const alle = (voll.hits as unknown[]).length;
  assert.ok(alle >= 4, `der Hook-Pfad muss genug Treffer liefern, waren ${alle}`);
  assert.equal(voll.truncated_by_budget, undefined, "ohne Budget ändert sich am Hook-Pfad nichts");
  const budget = Math.floor(measurePayload(voll).tokens / 2);
  const res = await httpPost(port, "/hook/recall", { query: "deployen", k: 8, max_tokens: budget });
  assert.ok(measurePayload(res).tokens <= budget, "das Hook-Payload passt ins Budget");
  assert.ok((res.hits as unknown[]).length < alle, "es wurde wirklich gekürzt");
  assert.equal(res.truncated_by_budget, true);
  assert.equal(res.dropped_by_budget, alle - (res.hits as unknown[]).length);
});
