/**
 * Die Auswertungsdimensionen des Ereignisstroms (#263, §17.4/§17.5, §21.1, §23).
 *
 * Drei Zusagen, die sich nachträglich nicht reparieren lassen, weil sie schon
 * geschriebene Ereignisse betreffen:
 *
 *  1. §23: „Pseudonyme Experiment-Session-IDs enthalten keinen Query- oder
 *     Vault-Inhalt." Der Daemon bekommt die Session-id von außen und kann nicht
 *     erzwingen, was dort steht — also muss die Spalte den Inhalt strukturell
 *     loswerden, nicht auf Wohlverhalten hoffen.
 *  2. §17.4: „Eine Session verbleibt für alle zugehörigen Ereignisse im selben
 *     Arm." Eine Zuweisung, die zweimal verschieden ausfällt, macht jeden
 *     Armvergleich wertlos.
 *  3. `client` und `hook_source` kommen aus einem Loopback-Body, den jeder
 *     lokale Prozess absetzen kann. Ein durchgereichter String wäre ein
 *     Freitextfeld im Log.
 *
 * Runner: node --import tsx --test packages/daemon/__tests__/telemetry-dimensions.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeClient,
  normalizeHookSource,
  pseudonymousSession,
  assignArm,
  dimensionsFrom,
  UNASSIGNED_ARM,
  TELEMETRY_CLIENTS,
  HOOK_SOURCES,
} from "../src/telemetry-dimensions.js";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { Vault, SearchIndex } from "@bastra-recall/core";
import { Telemetry } from "../src/telemetry.js";
import { startHttpServer } from "../src/http.js";

// ── Allowlisten ─────────────────────────────────────────────────

test("bekannte Clients kommen durch, alles andere wird unknown", () => {
  for (const c of TELEMETRY_CLIENTS) assert.equal(normalizeClient(c), c);
  assert.equal(normalizeClient("claude-code"), "claude-code");
  assert.equal(normalizeClient("irgendwas"), "unknown");
  assert.equal(normalizeClient(undefined), "unknown");
  assert.equal(normalizeClient(42), "unknown");
  assert.equal(normalizeClient({ toString: () => "claude-code" }), "unknown");
});

test("dasselbe für die Hook-Quelle, inklusive mcp", () => {
  for (const s of HOOK_SOURCES) assert.equal(normalizeHookSource(s), s);
  assert.equal(normalizeHookSource("mcp"), "mcp", "der Forwarder proxyt über denselben Endpunkt");
  assert.equal(normalizeHookSource("bash-pre"), "bash-pre");
  assert.equal(normalizeHookSource("erfunden"), "unknown");
});

test("ein Freitext aus dem Request landet nie im Log", () => {
  const d = dimensionsFrom({
    client: "SELECT * FROM memories -- was der Nutzer gefragt hat",
    hook_source: "<script>alert(1)</script>",
    session_id: "s-1",
  });
  assert.equal(d.client, "unknown");
  assert.equal(d.hook_source, "unknown");
  assert.ok(!JSON.stringify(d).includes("SELECT"), "kein Fremdtext in der Spalte");
});

// ── §23: das Session-Pseudonym ──────────────────────────────────

test("die Session-id wird gehasht und trägt keinen Inhalt mehr", () => {
  const roh = "session-mit-dem-inhalt-Hausratversicherung-Allianz";
  const pseudo = pseudonymousSession(roh);
  assert.ok(pseudo, "es entsteht ein Pseudonym");
  assert.ok(!pseudo!.includes("Hausrat"), "§23: kein Inhalt in der Spalte");
  assert.ok(!pseudo!.includes(roh));
  assert.match(pseudo!, /^[0-9a-f]{16}$/, "16 Hex-Stellen, im Log lesbar");
});

test("dasselbe Pseudonym für dieselbe Session, ein anderes für eine andere", () => {
  assert.equal(pseudonymousSession("a"), pseudonymousSession("a"));
  assert.notEqual(pseudonymousSession("a"), pseudonymousSession("b"));
});

test("keine Session heißt kein Pseudonym — nicht ein erfundenes", () => {
  assert.equal(pseudonymousSession(null), null);
  assert.equal(pseudonymousSession(undefined), null);
  assert.equal(pseudonymousSession(""), null);
});

// ── §17.4: die Armzuweisung ─────────────────────────────────────

const experiment = { experiment: "hook-wording", arms: ["a", "b"] };

test("ohne registrierte Konfiguration trägt jedes Ereignis unassigned", () => {
  const d = dimensionsFrom({ client: "claude-code", session_id: "s-1" });
  assert.equal(d.arm, UNASSIGNED_ARM, "die Spalte existiert, behauptet aber kein Experiment");
});

test("eine Session bleibt über alle ihre Ereignisse im selben Arm", () => {
  const pseudo = pseudonymousSession("s-42");
  const erste = assignArm(pseudo, experiment);
  for (let i = 0; i < 50; i++) {
    assert.equal(assignArm(pseudo, experiment), erste, "§17.4: session-stabil");
  }
});

test("ohne Session gibt es keinen Arm", () => {
  assert.equal(assignArm(null, experiment), UNASSIGNED_ARM);
});

test("die Zuweisung verteilt über die Arme, statt alle in einen zu kippen", () => {
  const counts = new Map<string, number>();
  for (let i = 0; i < 400; i++) {
    const arm = assignArm(pseudonymousSession(`session-${i}`), experiment);
    counts.set(arm, (counts.get(arm) ?? 0) + 1);
  }
  assert.equal(counts.size, 2, "beide Arme kommen vor");
  for (const [arm, n] of counts) {
    assert.ok(n > 120, `Arm ${arm} bekam nur ${n} von 400 — das ist keine Aufteilung`);
  }
});

test("mehr Arme werden alle bedient", () => {
  const drei = { experiment: "x", arms: ["a", "b", "c"] };
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) seen.add(assignArm(pseudonymousSession(`s${i}`), drei));
  assert.equal(seen.size, 3);
});

// ── Die vier Spalten zusammen ───────────────────────────────────

test("dimensionsFrom füllt alle vier Spalten", () => {
  const d = dimensionsFrom(
    { client: "claude-code", hook_source: "bash-pre", session_id: "s-1" },
    experiment,
  );
  assert.equal(d.client, "claude-code");
  assert.equal(d.hook_source, "bash-pre");
  assert.equal(d.experiment_session, pseudonymousSession("s-1"));
  assert.ok(experiment.arms.includes(d.arm));
  assert.deepEqual(Object.keys(d).sort(), ["arm", "client", "experiment_session", "hook_source"]);
});

test("ein Aufruf ohne jede Angabe ergibt vier gültige Werte, keine Lücken", () => {
  const d = dimensionsFrom({});
  assert.deepEqual(d, {
    client: "unknown",
    hook_source: "unknown",
    experiment_session: null,
    arm: UNASSIGNED_ARM,
  });
});

// ── Die Leitung: kommt die Spalte am geschriebenen Ereignis an? ──

/**
 * Die Normalisierung oben ist eine reine Funktion; sie beweist nicht, dass die
 * Spalte den Weg vom Request-Body bis ins JSONL findet. Genau dort sitzt der
 * Fehler, den man später nicht sieht: Ein Ereignis ohne Dimensionen sieht aus
 * wie ein Ereignis von vor #263.
 */

function memoryMarkdown(id: string, title: string): string {
  return [
    "---", `id: ${id}`, `title: ${title}`, "type: reference", `summary: ${title}`,
    "topic_path:", "  - test", "tags:", "  - test", "scope: dim-test",
    "recall_when:", `  - ${title}`, "created: 2026-01-01", "updated: 2026-01-01",
    "---", "", `Body for ${title}.`, "",
  ].join("\n");
}

function httpPost(port: number, path: string, payload: unknown): Promise<number> {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
      (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); },
    );
    req.on("error", reject);
    req.end(body);
  });
}

async function readEventRow(logDir: string, kind: string): Promise<Record<string, unknown> | null> {
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 40));
    let files: string[];
    try { files = await readdir(logDir); } catch { continue; }
    for (const f of files.filter((n) => n.startsWith("events-"))) {
      const raw = await readFile(join(logDir, f), "utf8");
      const line = raw.split("\n").filter((l) => l.includes(`"${kind}"`)).pop();
      if (line) return JSON.parse(line) as Record<string, unknown>;
    }
  }
  return null;
}

async function makeDaemon() {
  const dir = await mkdtemp(join(tmpdir(), "bastra-dim-vault-"));
  const logDir = await mkdtemp(join(tmpdir(), "bastra-dim-logs-"));
  await writeFile(join(dir, "alpha.md"), memoryMarkdown("alpha", "alpha bravo charlie"), "utf8");
  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  const prevLog = process.env.BASTRA_LOG_PATH;
  process.env.BASTRA_LOG_PATH = logDir;
  const telemetry = new Telemetry();
  if (prevLog === undefined) delete process.env.BASTRA_LOG_PATH;
  else process.env.BASTRA_LOG_PATH = prevLog;
  const handle = await startHttpServer({
    port: 0, vault, search, telemetry, version: "test",
    toolDeps: { vault, search, telemetry, vaultPath: dir },
    documentWriteEnabled: false,
    embedding: { on: false, providerId: null, source: "none" },
  });
  return {
    port: handle.port!, logDir,
    close: async () => {
      search.stop();
      await vault.stop?.();
      await handle.close();
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      await rm(logDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

test("/hook/recall schreibt die vier Spalten ans Ereignis", async () => {
  const d = await makeDaemon();
  try {
    assert.equal(
      await httpPost(d.port, "/hook/recall", {
        query: "alpha bravo charlie",
        session_id: "claude-session-263",
        client: "claude-code",
        hook_source: "bash-pre",
      }),
      200,
    );
    const row = await readEventRow(d.logDir, "hook_recall");
    assert.ok(row, "ein hook_recall-Event sollte geschrieben sein");
    const dims = row!.dimensions as Record<string, unknown>;
    assert.ok(dims, "die Spalten müssen am Ereignis hängen");
    assert.equal(dims.client, "claude-code");
    assert.equal(dims.hook_source, "bash-pre");
    assert.equal(dims.experiment_session, pseudonymousSession("claude-session-263"));
    assert.notEqual(dims.experiment_session, "claude-session-263", "§23: nie die rohe id");
    assert.equal(dims.arm, UNASSIGNED_ARM, "ohne registrierte Konfiguration kein Arm");
  } finally {
    await d.close();
  }
});

test("ein erfundener client aus dem Body wird zu unknown, nicht ins Log gereicht", async () => {
  const d = await makeDaemon();
  try {
    await httpPost(d.port, "/hook/recall", {
      query: "alpha bravo charlie",
      client: "beliebiger Freitext mit Nutzerinhalt",
      hook_source: "auch erfunden",
    });
    const row = await readEventRow(d.logDir, "hook_recall");
    const dims = row!.dimensions as Record<string, unknown>;
    assert.equal(dims.client, "unknown");
    assert.equal(dims.hook_source, "unknown");
    assert.ok(!JSON.stringify(row).includes("Nutzerinhalt"), "kein Freitext im Log");
  } finally {
    await d.close();
  }
});

test("die Hop-Herkunft steht an den Hits des Ereignisses", async () => {
  const d = await makeDaemon();
  try {
    await httpPost(d.port, "/hook/recall", { query: "alpha bravo charlie", client: "claude-code" });
    const row = await readEventRow(d.logDir, "hook_recall");
    const hits = row!.hits as { id: string; hop?: string }[];
    assert.ok(hits.length > 0, "der Recall sollte treffen");
    assert.equal(hits[0].hop, "direct", "§18.2 braucht die Herkunft je Hit");
  } finally {
    await d.close();
  }
});
