/**
 * #363: die Recall-Ebene trägt die echte Claude-Session-id.
 *
 * cf411ca (#356) hat die vier Hook-CLI-Lanes gefixt — prompt-lane,
 * bash-pre-lane, bash-fail-lane, Stop-Hook. Die daemon-seitigen
 * Recall-Emitter waren nicht in dem Set: `logHookRecall` deklarierte
 * `Omit<…, "session_id">`, der Typ VERBOT dem Caller also, eine Session
 * mitzugeben, und `this.sessionId` (eine UUID pro Daemon-Boot) gewann immer.
 * Messbare Folge im Log vom 22.08.: 194 hook_recall-Events über genau 4 ids —
 * dieselben 4 wie ollama_lifecycle, also 4 Daemon-Starts, keine 4 Sessions.
 * Eine echte Session war in fünf Event-Arten sichtbar und in der einen
 * unsichtbar, die die Retrieval-Stage-Timings trägt.
 *
 * Diese Datei testet die Leitung, nicht das Prädikat: kommt die session_id aus
 * dem /hook/recall-Body am Event an, bleibt ohne sie die Boot-UUID stehen, und
 * sagt ollama_lifecycle die Wahrheit über seine Kontextlosigkeit.
 *
 * Run: node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/telemetry-session-id.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";

import { Vault, SearchIndex } from "@bastra-recall/core";
import { Telemetry } from "../src/telemetry.js";
import { startHttpServer } from "../src/http.js";

function memoryMarkdown(id: string, title: string): string {
  const ts = new Date().toISOString();
  return [
    "---",
    `id: ${id}`,
    `title: ${title}`,
    "type: reference",
    `summary: ${title}`,
    "topic_path:",
    "  - test",
    "tags:",
    "  - test",
    "scope: session-id-test",
    "recall_when:",
    `  - ${title}`,
    `created: ${ts}`,
    `updated: ${ts}`,
    "---",
    "",
    `Body for ${title}.`,
    "",
  ].join("\n");
}

function httpPost(port: number, path: string, payload: unknown): Promise<{ status: number; body: string }> {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

interface Daemon {
  port: number;
  telemetry: Telemetry;
  logDir: string;
  close: () => Promise<void>;
}

async function makeDaemon(): Promise<Daemon> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-sid-vault-"));
  const logDir = await mkdtemp(join(tmpdir(), "bastra-sid-logs-"));
  await writeFile(join(dir, "alpha.md"), memoryMarkdown("alpha", "alpha bravo charlie"), "utf8");
  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();

  // Telemetry löst den Log-Pfad im Konstruktor auf — der Redirect muss davor
  // stehen und danach zurück, sonst erbt der Rest der Datei ihn.
  const prevLog = process.env.BASTRA_LOG_PATH;
  process.env.BASTRA_LOG_PATH = logDir;
  const telemetry = new Telemetry();
  if (prevLog === undefined) delete process.env.BASTRA_LOG_PATH;
  else process.env.BASTRA_LOG_PATH = prevLog;

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

  return {
    port: handle.port!,
    telemetry,
    logDir,
    close: async () => {
      search.stop();
      await vault.stop?.();
      await handle.close();
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      await rm(logDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

/** ALLE Zeilen der gesuchten Event-Art, in Schreibreihenfolge — für Prüfungen,
 *  die mehrere Ereignisse gegeneinander halten (Turn-Grenzen). Wartet, bis
 *  mindestens `mindestens` Zeilen da sind; write() ist fire-and-forget. */
async function readEventRows(
  logDir: string,
  kind: string,
  mindestens = 1,
): Promise<Record<string, unknown>[]> {
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 40));
    let files: string[];
    try {
      files = await readdir(logDir);
    } catch {
      continue;
    }
    const zeilen: Record<string, unknown>[] = [];
    for (const f of files.filter((n) => n.startsWith("events-")).sort()) {
      const raw = await readFile(join(logDir, f), "utf8");
      for (const l of raw.split("\n").filter((x) => x.includes(`"${kind}"`))) {
        zeilen.push(JSON.parse(l) as Record<string, unknown>);
      }
    }
    if (zeilen.length >= mindestens) return zeilen;
  }
  return [];
}

/** Pollt das Log-Dir auf die letzte Zeile der gesuchten Event-Art — write() ist fire-and-forget. */
async function readEventRow(logDir: string, kind: string): Promise<Record<string, unknown> | null> {
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 40));
    let files: string[];
    try {
      files = await readdir(logDir);
    } catch {
      continue;
    }
    for (const f of files.filter((n) => n.startsWith("events-"))) {
      const raw = await readFile(join(logDir, f), "utf8");
      const line = raw.split("\n").filter((l) => l.includes(`"${kind}"`)).pop();
      if (line) return JSON.parse(line) as Record<string, unknown>;
    }
  }
  return null;
}

test("#363: /hook/recall stempelt die Claude-Session-id aufs hook_recall-Event, nicht die Daemon-Boot-UUID", async () => {
  const d = await makeDaemon();
  try {
    const res = await httpPost(d.port, "/hook/recall", {
      query: "alpha bravo charlie",
      session_id: "claude-session-363",
      project: "bastra-recall",
    });
    assert.equal(res.status, 200);

    const row = await readEventRow(d.logDir, "hook_recall");
    assert.ok(row, "ein hook_recall-Event sollte geschrieben sein");
    assert.equal(
      row!.session_id,
      "claude-session-363",
      "ohne das ist keine Auswertung auf Recall-Ebene nach Session oder Turn gruppierbar (#305, #361)",
    );
    assert.notEqual(
      row!.session_id,
      d.telemetry.runId(),
      "die Boot-id darf nicht mehr gewinnen — sie war der ganze Bug",
    );
  } finally {
    await d.close();
  }
});

test("#363: ohne session_id im Payload bleibt die Boot-UUID stehen — kein undefined durch den Spread", async () => {
  // Der Hatch ist `& { session_id?: string }` und der Emitter spreadet den
  // Payload ÜBER den Default. Ein explizites `session_id: undefined` im Payload
  // würde die Boot-UUID also mit undefined überschreiben und das Feld ganz aus
  // dem JSONL entfernen — deshalb reicht die Route sie konditional durch
  // (`...(id ? { session_id: id } : {})`), wie logHookAct/logHookReflex.
  const d = await makeDaemon();
  try {
    const res = await httpPost(d.port, "/hook/recall", { query: "alpha bravo charlie" });
    assert.equal(res.status, 200);

    const row = await readEventRow(d.logDir, "hook_recall");
    assert.ok(row, "ein hook_recall-Event sollte geschrieben sein");
    assert.equal(
      row!.session_id,
      d.telemetry.runId(),
      "Fallback ist die Boot-id, nicht undefined — ein Event ohne session_id-Feld wäre schlechter als eins mit Fallback",
    );
  } finally {
    await d.close();
  }
});

test("#363: ollama_lifecycle sagt session_id: null und trägt die Boot-id als run_id", async () => {
  // Beide Emitter sind kontextlos: der prewarm läuft im Boot-Pfad
  // (index.ts:270), der unload auf einem 60-s-Timer (daemon-jobs.ts:167). Es
  // gibt keine Session, die man durchreichen könnte — die Boot-UUID hier zu
  // stempeln hat 4 Daemon-Starts wie 4 Sessions aussehen lassen. `null` ist die
  // ehrliche Aussage; die Boot-id bleibt als run_id erhalten, weil das
  // prewarm→unload-Pairing (#109) sie braucht.
  const logDir = await mkdtemp(join(tmpdir(), "bastra-sid-ollama-logs-"));
  const prevLog = process.env.BASTRA_LOG_PATH;
  process.env.BASTRA_LOG_PATH = logDir;
  const telemetry = new Telemetry();
  if (prevLog === undefined) delete process.env.BASTRA_LOG_PATH;
  else process.env.BASTRA_LOG_PATH = prevLog;
  try {
    await telemetry.logOllamaLifecycle({
      action: "prewarm",
      model: "nomic-embed-text",
      ok: true,
      last_embed_age_ms: null,
      embed_calls_since_boot: 0,
    });

    const row = await readEventRow(logDir, "ollama_lifecycle");
    assert.ok(row, "ein ollama_lifecycle-Event sollte geschrieben sein");
    assert.ok("session_id" in row!, "das Feld muss da sein — sonst ist der null-Wert nicht von einem alten Event zu unterscheiden");
    assert.equal(row!.session_id, null, "keine Session im Boot-/Timer-Pfad — null statt Boot-id-Lüge");
    assert.equal(row!.run_id, telemetry.runId(), "die Boot-id bleibt auswertbar, nur richtig beschriftet");
    assert.equal(row!.action, "prewarm");
  } finally {
    await rm(logDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("#305/#361: das hook_recall-Event trägt die Turn-Grenze, nicht nur die Session", async () => {
  const d = await makeDaemon();
  try {
    // Ein UserPromptSubmit rotiert den Turn — danach gehören alle Recalls
    // derselben Session zu diesem Turn.
    await httpPost(d.port, "/hook/recall", {
      query: "erster prompt",
      session_id: "claude-session-turn",
      tool_name: "UserPromptSubmit",
    });
    const ersterTurn = (await readEventRow(d.logDir, "hook_recall"))!.turn_id as string;
    assert.ok(ersterTurn, "ohne turn_id lässt sich nichts auf Turn-Ebene gruppieren (#305, #361)");

    // Ein Werkzeugaufruf im selben Turn: dieselbe Turn-id, kein neuer Turn.
    await httpPost(d.port, "/hook/recall", {
      query: "ein Edit im selben Turn",
      session_id: "claude-session-turn",
      tool_name: "Edit",
    });
    const zeilen = await readEventRows(d.logDir, "hook_recall", 2);
    assert.equal(zeilen.length, 2);
    assert.equal(
      zeilen[1].turn_id,
      ersterTurn,
      "derselbe Turn muss dieselbe id tragen, sonst zählt jede Auswertung Turns doppelt",
    );

    // Der nächste Prompt beginnt einen neuen Turn.
    await httpPost(d.port, "/hook/recall", {
      query: "zweiter prompt",
      session_id: "claude-session-turn",
      tool_name: "UserPromptSubmit",
    });
    const nachher = await readEventRows(d.logDir, "hook_recall", 3);
    assert.notEqual(
      nachher[2].turn_id,
      ersterTurn,
      "ein neuer UserPromptSubmit muss einen neuen Turn beginnen",
    );
    assert.equal(nachher[2].turn_source, "session", "die Zuordnung kommt aus der Session, nicht geraten");
  } finally {
    await d.close();
  }
});
