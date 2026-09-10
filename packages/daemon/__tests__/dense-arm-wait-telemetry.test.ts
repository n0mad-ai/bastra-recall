/**
 * #489 — die beiden neuen Zahlen des dichten Arms müssen bis in die Telemetrie
 * durchkommen, nicht nur bis an die Stage.
 *
 * `vector_search_ms` war die einzige Zahl des Arms, und sie taugte als
 * Messgrundlage nicht: Sie überlappt BM25 (`overlapped: true`, seit #370
 * Absicht) und wird beim Timeout an der Deadline abgeschnitten. Was #491 zum
 * Lernen einer Frist braucht, ist die WARTEZEIT des Aufrufers und das ECHTE
 * Settle des aufgegebenen Arms.
 *
 * Dieser Test fährt den echten HTTP-Pfad und liest die geschriebenen Zeilen:
 *
 *  - `hook_recall.recall_stages.vector_wait_ms` — was der Aufrufer zahlte.
 *  - `vector_late_settle` — eigene Zeile, weil der Wert eintrifft, nachdem der
 *    Recall beantwortet und sein Event geschrieben ist. Join über `recall_id`.
 *
 * Runner: node --import tsx --test packages/daemon/__tests__/dense-arm-wait-telemetry.test.ts
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

const DEADLINE_MS = 50;
/** Deutlich hinter der Frist — der Arm wird aufgegeben und läuft weiter. */
const ANTWORT_NACH_MS = 300;

function memo(id: string): string {
  return [
    "---", `id: ${id}`, `title: Deployment-Strategie`, "type: reference",
    "summary: Deployment-Strategie", "topic_path:", "  - test", "tags:", "  - test",
    "recall_when:", "  - wenn wir deployen", "created: 2026-01-01", "updated: 2026-01-01",
    "---", "", "Text über deployen.", "",
  ].join("\n");
}

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

/** Ein dichter Arm, der die Frist sicher reißt und danach doch noch liefert. */
function spaeterArm() {
  return {
    size: () => 1,
    runtimeHealth: () => ({ errorCount: 0 }),
    // #493: der strukturierte Ausgang des Arms.
    searchDetailed: () =>
      new Promise((resolve) =>
        setTimeout(
          () =>
            resolve({
              outcome: "hits",
              hits: [{ id: "a", score: 0.9 }],
              providerLoadMs: null,
              coldStartObserved: false,
            }),
          ANTWORT_NACH_MS,
        ),
      ),
  } as never;
}

async function daemon(t: { after: (fn: () => unknown) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "bastra-wait-vault-"));
  const logDir = await mkdtemp(join(tmpdir(), "bastra-wait-logs-"));
  await writeFile(join(dir, "a.md"), memo("a"), "utf8");
  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  search.useEmbeddings(spaeterArm());
  const prev = process.env.BASTRA_LOG_PATH;
  process.env.BASTRA_LOG_PATH = logDir;
  const telemetry = new Telemetry();
  if (prev === undefined) delete process.env.BASTRA_LOG_PATH;
  else process.env.BASTRA_LOG_PATH = prev;
  const handle = await startHttpServer({
    port: 0, vault, search, telemetry, version: "test",
    toolDeps: { vault, search, telemetry, vaultPath: dir },
    documentWriteEnabled: false,
    embedding: { on: true, providerId: "test", source: "none" },
  });
  t.after(async () => {
    search.stop();
    await vault.stop?.();
    await handle.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    await rm(logDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return { port: handle.port!, logDir };
}

test("#489: ein aufgegebener Arm schreibt die Wartezeit und, später, sein echtes Settle", async (t) => {
  const d = await daemon(t);
  await httpPost(d.port, "/hook/recall", { query: "deployen", k: 5, vector_deadline_ms: DEADLINE_MS });

  const recalls = await readEvents(d.logDir, "hook_recall");
  assert.equal(recalls.length, 1, "genau ein hook_recall");
  const stages = recalls[0].recall_stages as Record<string, number>;
  assert.equal(typeof stages.vector_wait_ms, "number", "`vector_wait_ms` muss in `recall_stages` ankommen");
  assert.ok(
    stages.vector_wait_ms >= DEADLINE_MS && stages.vector_wait_ms < ANTWORT_NACH_MS,
    `die Wartezeit liegt auf der Deadline, war ${stages.vector_wait_ms} ms`,
  );
  // Die alte Serie behält ihre Bedeutung: Spanne ab dem Abfeuern, überlappend.
  assert.equal(typeof stages.vector_search_ms, "number", "`vector_search_ms` bleibt erhalten");
  assert.equal(recalls[0].degraded_reason, "vector-arm-timeout");

  const spaet = await readEvents(d.logDir, "vector_late_settle");
  assert.equal(spaet.length, 1, "die späte Stichprobe wird geschrieben");
  assert.equal(spaet[0].recall_id, recalls[0].recall_id, "sie ist über `recall_id` joinbar");
  assert.equal(spaet[0].late, true, "sie ist als späte Stichprobe markiert — niemand hat sie gewartet");
  assert.equal(spaet[0].settled, true, "der Arm lieferte am Ende doch");
  assert.equal(spaet[0].deadline_ms, DEADLINE_MS);
  assert.ok(
    (spaet[0].settle_ms as number) >= ANTWORT_NACH_MS - 40,
    `das echte Settle meldet die volle Dauer, nicht die Frist — war ${spaet[0].settle_ms} ms`,
  );
});
