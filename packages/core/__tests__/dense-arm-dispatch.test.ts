/**
 * #305 — der dichte Arm muss ABGESENDET sein, bevor der lexikalische Arm den
 * Event Loop belegt.
 *
 * DER BEFUND. `abandonAfter(this.embeddings.search(...), deadline)` startet den
 * dichten Arm, aber es SENDET ihn nicht: Ein HTTP-Request verlässt den Prozess
 * erst, wenn der Loop das nächste Mal frei ist. `mini.search()` danach ist
 * synchron und hält ihn — bei langen Queries mehrere hundert Millisekunden.
 * Ohne einen Durchlauf dazwischen lief der Deadline-Timer ab, bevor der
 * Provider überhaupt gefragt wurde, und der Arm galt als „zu langsam".
 *
 * WARUM DIESE TESTS EINEN KINDPROZESS STARTEN. Ein Doppel, das im selben
 * Prozess antwortet, kann während der Blockade gar nicht antworten — die
 * Blockade hält es mit an. Ein Test ohne echten Fremdprozess hätte den Fix
 * bestätigt, den es nicht gibt (genau dieser Fehler steckte in der ersten
 * Messung zu diesem Befund).
 *
 * Der lexikalische Arm blockiert hier ECHT: 100 Memories, 400 eindeutige
 * Query-Terme, gemessen ~290 ms. Kein künstliches `while`, sondern derselbe
 * MiniSearch-Lauf, um den es geht.
 *
 * #466: Der Durchlauf sendet den Request nur auf einem SCHON OFFENEN Socket.
 * Die ersten Tests wärmen deshalb vor (warmer Socket, Arme laufen parallel);
 * der Kalt-Test darunter prüft den Produktionsfall der Prompt-Lane, in dem
 * der Arm erst nach BM25 gesendet wird und seine Frist ab dem `await` läuft.
 *
 * Runner: node --import tsx --test packages/core/__tests__/dense-arm-dispatch.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { Agent, get } from "node:http";
import { Vault } from "../src/vault.js";
import { SearchIndex } from "../src/search.js";

const DEADLINE_MS = 150;
/** Antwortet klar VOR der Deadline — wird sie trotzdem gerissen, lag es nicht
 *  am Provider, sondern daran, dass er nie gefragt wurde. */
const ANTWORT_NACH_MS = 40;
const MEMORIES = 100;
const QUERY_TERME = 400;

const WOERTER = Array.from({ length: 4000 }, (_, i) => `term${i}xyz`);
let seed = 42;
const zufall = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

function memoryDatei(id: string): string {
  const body = Array.from({ length: 60 }, () => WOERTER[Math.floor(zufall() * WOERTER.length)]).join(" ");
  return [
    "---", `id: ${id}`, `title: ${id}`, "type: lesson", `summary: ${id}`,
    "topic_path:", "  - test", "tags:", "  - test", "recall_when:", `  - ${id}`,
    "created: 2026-01-01", "updated: 2026-01-01", "---", "", body, "",
  ].join("\n");
}

/** Der Provider in einem EIGENEN Prozess — nur so trifft seine Antwort
 *  während der Blockade des Testprozesses ein. */
async function providerProzess(t: {
  after: (fn: () => unknown) => void;
}): Promise<{ port: number }> {
  const quelle = `
    const http = require("node:http");
    const s = http.createServer((req, res) => {
      const raw = new URL(req.url, "http://x").searchParams.get("ms") || "0";
      // "never": die Antwort kommt nie — der Socket bleibt offen, bis der
      // Prozess stirbt. Ein Arm, der WIRKLICH zu langsam ist, unabhängig davon,
      // wie lange der Testprozess vorher blockiert war.
      if (raw === "never") return;
      const ms = Number(raw);
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify([{ id: "m0", score: 0.9 }]));
      }, ms);
    });
    s.listen(0, "127.0.0.1", () => process.stdout.write(String(s.address().port) + "\\n"));
  `;
  const kind: ChildProcess = spawn(process.execPath, ["-e", quelle], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => void kind.kill());
  const port = await new Promise<number>((ok) => {
    let buf = "";
    kind.stdout!.on("data", (c) => {
      buf += String(c);
      if (buf.includes("\n")) ok(Number(buf.trim()));
    });
  });
  return { port };
}

/** Ein Embedding-Index-Doppel, das seine Treffer über echtes Netz-I/O holt.
 *  Ohne `agent` läuft es über Nodes globalen Agent, der seit Node 19 Keep-
 *  Alive hält — nach dem ersten Lauf ist der Socket also WARM. */
function embeddingsUeberNetz(port: number, antwortNachMs: number | "never", agent?: Agent) {
  return {
    size: () => 1,
    runtimeHealth: () => ({ errorCount: 0 }),
    search: () =>
      new Promise((resolve, reject) => {
        get({ host: "127.0.0.1", port, path: `/?ms=${antwortNachMs}`, ...(agent ? { agent } : {}) }, (res) => {
          let roh = "";
          res.on("data", (c) => (roh += c));
          res.on("end", () => resolve(JSON.parse(roh)));
        }).on("error", reject);
      }),
  } as never;
}

async function vaultMitVielenMemories(t: { after: (fn: () => unknown) => void }): Promise<SearchIndex> {
  const root = await mkdtemp(join(tmpdir(), "bastra-dispatch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "memories"), { recursive: true });
  for (let i = 0; i < MEMORIES; i++) {
    await writeFile(join(root, "memories", `m${i}.md`), memoryDatei(`m${i}`), "utf8");
  }
  const vault = new Vault(root);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  t.after(() => search.stop());
  return search;
}

/**
 * Eine Query, deren lexikalischer Arm den Loop wirklich lange hält.
 *
 * `versatz` verschiebt das Termfenster: Der Query-Cache schlüsselt auf den
 * Text, und zwei identische Läufe hintereinander würden den zweiten aus dem
 * Cache bedienen — dann liefe BM25 gar nicht, und der Test prüfte nichts.
 */
const teureQuery = (versatz = 0): string =>
  Array.from({ length: QUERY_TERME }, (_, i) => WOERTER[i + versatz]).join(" ");

async function laufMitTimeoutMarke(
  search: SearchIndex,
  antwortNachMs: number | "never",
  port: number,
  versatz = 0,
  agent?: Agent,
): Promise<{ timeout: boolean; bm25Ms: number }> {
  search.useEmbeddings(embeddingsUeberNetz(port, antwortNachMs, agent));
  let timeout = false;
  let bm25Ms = 0;
  await search.recallHybrid(teureQuery(versatz), {
    k: 5,
    vector_deadline_ms: DEADLINE_MS,
    onStage: ((s: { name: string; durationMs?: number; meta?: Record<string, unknown> }) => {
      if (s.name === "done" && s.meta?.degraded === "vector-arm-timeout") timeout = true;
      if (s.name === "bm25.search" && typeof s.durationMs === "number") bm25Ms = s.durationMs;
    }) as never,
  });
  return { timeout, bm25Ms };
}

test("der dichte Arm überlebt eine lange lexikalische Suche", async (t) => {
  const search = await vaultMitVielenMemories(t);
  const { port } = await providerProzess(t);

  // Drei Aufwärmläufe, und zwar aus einem benannten Grund: Die ersten Aufrufe
  // eines frischen Prozesses tragen den TCP-Erstverbindungsaufbau und die
  // JIT-Aufwärmung von MiniSearch mit. Gemessen kippen genau die ersten beiden
  // Läufe, danach keiner mehr. Das ist ein echter Effekt — der erste Recall
  // nach einem Daemon-Start kann seinen dichten Arm weiterhin verlieren —, aber
  // es ist nicht die Frage, die dieser Test stellt. Er prüft, ob der Arm im
  // eingeschwungenen Zustand abgesendet wird, bevor der lexikalische ihn
  // aussperrt.
  for (let i = 0; i < 3; i++) await laufMitTimeoutMarke(search, ANTWORT_NACH_MS, port, 100 + i);

  const ergebnisse: Array<{ timeout: boolean; bm25Ms: number }> = [];
  for (let i = 0; i < 5; i++) ergebnisse.push(await laufMitTimeoutMarke(search, ANTWORT_NACH_MS, port, i));

  // Die Voraussetzung des Tests: Der lexikalische Arm muss den Loop wirklich
  // über die Deadline hinaus halten. Tut er das nicht, prüft der Test nichts.
  const median = ergebnisse.map((e) => e.bm25Ms).sort((a, b) => a - b)[2];
  assert.ok(
    median > DEADLINE_MS,
    `der lexikalische Arm muss länger als die Deadline blockieren, war ${median} ms`,
  );

  const timeouts = ergebnisse.filter((e) => e.timeout).length;
  assert.equal(
    timeouts,
    0,
    `kein Lauf darf in den Timeout gehen — der Provider antwortet nach ${ANTWORT_NACH_MS} ms, ` +
      `also lange vor der ${DEADLINE_MS}-ms-Frist. ${timeouts} von 5 taten es trotzdem.`,
  );
});

test("#466: auf einem KALTEN Socket überlebt der dichte Arm die lexikalische Suche ebenfalls", async (t) => {
  const search = await vaultMitVielenMemories(t);
  const { port } = await providerProzess(t);

  // Der Produktionsfall der Prompt-Lane: Die Aufrufe liegen Minuten
  // auseinander, die Verbindung ist zu. Ein frischer TCP-Connect wird erst in
  // der Poll-Phase fertig — NACH der Blockade —, der Request geht also erst
  // dann raus, und der Arm läuft sequentiell hinter BM25. Mit einer Frist ab
  // dem Abfeuern war das 02.09. bei jeder langen Query ein Timeout (27 von 49).
  // Die Frist ab dem `await` gibt ihm sein Budget für die Zeit, in der er
  // wirklich wartet. `keepAlive: false` je Lauf erzwingt den kalten Socket.
  for (let i = 0; i < 3; i++) {
    await laufMitTimeoutMarke(search, ANTWORT_NACH_MS, port, 200 + i, new Agent({ keepAlive: false }));
  }

  const ergebnisse: Array<{ timeout: boolean; bm25Ms: number }> = [];
  for (let i = 0; i < 5; i++) {
    ergebnisse.push(
      await laufMitTimeoutMarke(search, ANTWORT_NACH_MS, port, 300 + i, new Agent({ keepAlive: false })),
    );
  }

  const median = ergebnisse.map((e) => e.bm25Ms).sort((a, b) => a - b)[2];
  assert.ok(
    median > DEADLINE_MS,
    `der lexikalische Arm muss länger als die Deadline blockieren, war ${median} ms`,
  );
  const timeouts = ergebnisse.filter((e) => e.timeout).length;
  assert.equal(
    timeouts,
    0,
    `kein Lauf darf in den Timeout gehen — der Provider antwortet ${ANTWORT_NACH_MS} ms nach dem Connect, ` +
      `also innerhalb der ${DEADLINE_MS}-ms-Frist ab dem Warten. ${timeouts} von 5 taten es trotzdem.`,
  );
});

test("ein wirklich zu langsamer Arm läuft weiterhin in seinen Timeout", async (t) => {
  const search = await vaultMitVielenMemories(t);
  const { port } = await providerProzess(t);

  // Die Frist läuft seit #466 ab dem Warten (nach BM25). Ein Provider mit
  // FESTER Verzögerung taugt hier nicht mehr als „zu langsam": Auf einem
  // langsamen CI-Runner dauert BM25 länger als die Verzögerung, die Antwort
  // liegt beim Blockende schon gepuffert und der Arm kommt durch — genau so
  // fiel der Test am 03.09. auf Node 22 und 24. Ein Provider, der NIE
  // antwortet, ist die einzige Verzögerung, die von der Maschine unabhängig ist.
  const { timeout } = await laufMitTimeoutMarke(search, "never", port, 7);
  assert.ok(timeout, "die Deadline muss weiterhin greifen, wenn der Arm sie wirklich reißt");
});

test("kurze Läufe zahlen keinen spürbaren Aufpreis", async (t) => {
  const search = await vaultMitVielenMemories(t);
  const { port } = await providerProzess(t);
  search.useEmbeddings(embeddingsUeberNetz(port, 0));

  // 20 billige Recalls. Der Durchlauf kostet einen Tick (gemessen ~0,3 ms);
  // die Schranke ist bewusst weit, sie soll eine Regression fangen, die pro
  // Aufruf zweistellig kostet, und nicht bei CI-Jitter flackern.
  const t0 = Date.now();
  for (let i = 0; i < 20; i++) {
    await search.recallHybrid(`term${i}xyz`, { k: 5, vector_deadline_ms: DEADLINE_MS });
  }
  const proAufruf = (Date.now() - t0) / 20;
  assert.ok(proAufruf < 50, `ein billiger Recall darf nicht spürbar teurer werden, war ${proAufruf.toFixed(1)} ms`);
});
