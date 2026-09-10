/**
 * #484 — der Breaker aus #479 läuft im Schatten.
 *
 * Der reine Helfer ist in `hint-suppression.test.ts` geprüft. Hier geht es um
 * die einzige Stelle, an der er je gewirkt hat: `http-hook-routes.ts`. Was
 * gemessen werden muss, ist nicht die Zählung, sondern dass sie folgenlos
 * bleibt — im Schatten verlässt kein Treffer weniger die Route, und die im
 * Event stehende Liste ist genau die, die im Live-Modus entfernt worden wäre.
 *
 * Runner: node --import tsx --test packages/daemon/__tests__/hint-suppression-mode.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { Vault, SearchIndex } from "@bastra-recall/core";
import { Telemetry } from "../src/telemetry.js";
import { startHttpServer } from "../src/http.js";
import { hintRevision } from "../src/hint-suppression.js";
import { primeUsageShadowCache, resetUsageShadowCache } from "../src/trust-shadow.js";

function memo(id: string, title: string, trigger: string, body: string): string {
  return [
    "---", `id: ${id}`, `title: ${title}`, "type: lesson", `summary: ${title}`,
    "topic_path:", "  - test", "tags:", "  - test", "scope: suppression-test",
    "recall_when:", `  - ${trigger}`, "created: 2026-01-01", "updated: 2026-01-01",
    "---", "", body, "",
  ].join("\n");
}

function httpPost(port: number, path: string, payload: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(raw || "{}") }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

async function readHookRecall(logDir: string): Promise<Record<string, unknown>[]> {
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 40));
    let files: string[];
    try { files = await readdir(logDir); } catch { continue; }
    const out: Record<string, unknown>[] = [];
    for (const f of files.filter((n) => n.startsWith("events-"))) {
      const raw = await readFile(join(logDir, f), "utf8");
      for (const line of raw.split("\n")) {
        if (line.includes('"hook_recall"')) out.push(JSON.parse(line) as Record<string, unknown>);
      }
    }
    if (out.length > 0) return out;
  }
  return [];
}

/** Ein Vault mit einem Treffer, dessen Version achtmal eingeblendet und nie
 *  geladen wurde — genau der Fall, den der Breaker schneidet. */
async function daemon(t: { after: (fn: () => unknown) => void }, mode: string | undefined) {
  const dir = await mkdtemp(join(tmpdir(), "bastra-suppress-vault-"));
  const logDir = await mkdtemp(join(tmpdir(), "bastra-suppress-logs-"));
  await writeFile(join(dir, "a.md"), memo("a", "Deployment-Strategie", "wenn wir deployen", "Text über deployen."), "utf8");
  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();

  const prevLog = process.env.BASTRA_LOG_PATH;
  const prevMode = process.env.BASTRA_HINT_SUPPRESS;
  process.env.BASTRA_LOG_PATH = logDir;
  const telemetry = new Telemetry();
  if (prevLog === undefined) delete process.env.BASTRA_LOG_PATH;
  else process.env.BASTRA_LOG_PATH = prevLog;
  if (mode === undefined) delete process.env.BASTRA_HINT_SUPPRESS;
  else process.env.BASTRA_HINT_SUPPRESS = mode;

  resetUsageShadowCache();
  primeUsageShadowCache(dir, {
    a: {
      surfaced: 8, loaded: 0, acted_on: 0,
      revision: hintRevision(vault.get("a")),
      revision_surfaced: 8, revision_loaded: 0, revision_acted_on: 0,
    },
  });

  const handle = await startHttpServer({
    port: 0, vault, search, telemetry, version: "test",
    toolDeps: { vault, search, telemetry, vaultPath: dir },
    documentWriteEnabled: false,
    embedding: { on: false, providerId: null, source: "none" },
  });
  t.after(async () => {
    if (prevMode === undefined) delete process.env.BASTRA_HINT_SUPPRESS;
    else process.env.BASTRA_HINT_SUPPRESS = prevMode;
    resetUsageShadowCache();
    search.stop();
    await vault.stop?.();
    await handle.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    await rm(logDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return { port: handle.port!, logDir };
}

test("Voreinstellung: der Treffer bleibt in der Antwort, das Event zählt ihn als hätte-entfernt", async (t) => {
  const d = await daemon(t, undefined);
  const res = await httpPost(d.port, "/hook/recall", { query: "deployen", k: 5 });
  assert.equal(res.status, 200);
  assert.deepEqual((res.json.hits as { id: string }[]).map((h) => h.id), ["a"], "kein Treffer weniger");

  const [event] = await readHookRecall(d.logDir);
  const suppressed = event.usage_suppressed as { id: string; surfaced: number }[];
  assert.deepEqual(suppressed.map((s) => s.id), ["a"], "die Zählung läuft weiter");
  assert.equal(suppressed[0].surfaced, 8);
  assert.equal(event.usage_suppressed_mode, "shadow", "ein Report muss Schatten von Wirkbetrieb trennen können");
  assert.equal(typeof event.usage_suppressed_tokens_est, "number");
  assert.equal(event.hit_count, 1, "die gezählte Ausspielung ist die tatsächliche");
});

test("live: dieselbe Liste, aber der Treffer verlässt die Antwort", async (t) => {
  const d = await daemon(t, "live");
  const res = await httpPost(d.port, "/hook/recall", { query: "deployen", k: 5 });
  assert.deepEqual(res.json.hits, [], "im Wirkbetrieb wird geschnitten");
  const [event] = await readHookRecall(d.logDir);
  assert.deepEqual((event.usage_suppressed as { id: string }[]).map((s) => s.id), ["a"]);
  assert.equal(event.usage_suppressed_mode, "live");
});

test("off: der Durchlauf entfällt ganz, das Event trägt keine Liste", async (t) => {
  const d = await daemon(t, "off");
  const res = await httpPost(d.port, "/hook/recall", { query: "deployen", k: 5 });
  assert.deepEqual((res.json.hits as { id: string }[]).map((h) => h.id), ["a"]);
  const [event] = await readHookRecall(d.logDir);
  assert.equal(event.usage_suppressed, undefined);
  assert.equal(event.usage_suppressed_mode, undefined);
});
