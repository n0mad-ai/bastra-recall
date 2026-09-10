/**
 * #493 — die Messgüte VOR dem Fenster.
 *
 * Ein Gegenreview am 08.09.2026 hat gezeigt, dass drei der fünf Torbedingungen
 * aus #492 aus dem, was aufgezeichnet wurde, gar nicht beantwortbar waren, und
 * dass zwei Defekte die Stichproben aktiv verdarben. Dieser Test hält genau
 * die Stellen fest, an denen das entschieden wird:
 *
 *  1. Ein Providerfehler wird NIE zur Latenzstichprobe (und ist als solcher
 *     sichtbar).
 *  2. Jede Lane wird gegen IHRE Wanduhr geschattet, und die Zeile sagt, woher
 *     die Zahl kam.
 *  3. Residenz ist Grundwahrheit, wo es sie gibt — Warmup und Unload schreiben
 *     in denselben Zustand.
 *  4. Die Gruppierungs-ID verbindet das Sitzungsereignis mit seinen
 *     Teil-Recalls.
 *  5. Die Kennung des Hosts ist stabil und verrät den Host nicht.
 *
 * Der kalte Eimer, der nicht vom warmen borgt, und das 12-Sekunden-Settle
 * stehen in `latency-profile.test.ts`, wo das Profil selbst geprüft wird.
 *
 * Runner: node --import tsx --test packages/daemon/__tests__/measurement-integrity.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request } from "node:http";
import { Vault, SearchIndex } from "@bastra-recall/core";
import { Telemetry } from "../src/telemetry.js";
import { startHttpServer } from "../src/http.js";
import { runSessionLane } from "../src/session-lane.js";
import { createLatencyProfile, type DeadlineShadow } from "../src/latency-profile.js";
import { createEmbeddingWarmup, RESIDENT_WINDOW_MS } from "../src/embedding-warmup.js";
import { computeHostProfileId } from "../src/host-profile.js";
import { FORWARDER_HOOK_BUDGET_MS, REQUEST_TIMEOUT_MS } from "../src/forwarder-daemon-client.js";

const KEY = "ollama-embeddinggemma";

function memo(id: string): string {
  return [
    "---", `id: ${id}`, "title: Deployment-Strategie", "type: reference",
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

async function readEvents(logDir: string, kind: string, mindestens = 1): Promise<Record<string, unknown>[]> {
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
    if (out.length >= mindestens) return out;
  }
  return [];
}

/**
 * Ein dichter Arm, der nach `nachMs` mit dem gegebenen Ausgang antwortet —
 * genau die Unterscheidung, die `EmbeddingIndex.search()` vor #493 verschluckt
 * hat.
 */
function armMitAusgang(
  outcome: "hits" | "empty" | "error",
  nachMs: number,
  loadMs: number | null = null,
) {
  return {
    size: () => 1,
    runtimeHealth: () => ({ errorCount: 0 }),
    searchDetailed: () =>
      new Promise((resolve) =>
        setTimeout(
          () =>
            resolve({
              outcome,
              hits: outcome === "hits" ? [{ id: "a", score: 0.9 }] : [],
              providerLoadMs: loadMs,
              coldStartObserved: loadMs !== null && loadMs >= 200,
            }),
          nachMs,
        ),
      ),
  } as never;
}

async function daemonMit(
  t: { after: (fn: () => unknown) => void },
  arm: ReturnType<typeof armMitAusgang>,
  shadow: DeadlineShadow | undefined,
) {
  const dir = await mkdtemp(join(tmpdir(), "bastra-mi-vault-"));
  const logDir = await mkdtemp(join(tmpdir(), "bastra-mi-logs-"));
  await writeFile(join(dir, "a.md"), memo("a"), "utf8");
  const vault = new Vault(dir);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  search.useEmbeddings(arm);
  const prev = process.env.BASTRA_LOG_PATH;
  process.env.BASTRA_LOG_PATH = logDir;
  const telemetry = new Telemetry();
  if (prev === undefined) delete process.env.BASTRA_LOG_PATH;
  else process.env.BASTRA_LOG_PATH = prev;
  const handle = await startHttpServer({
    port: 0, vault, search, telemetry, version: "test",
    toolDeps: { vault, search, telemetry, vaultPath: dir, deadlineShadow: shadow },
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

function schattenMit(profil: ReturnType<typeof createLatencyProfile>): DeadlineShadow {
  return {
    key: () => KEY,
    residency: () => ({ state: "warm", source: "warm-up", estimated: false }),
    observeLoad: () => {},
    hostProfileId: () => "testhost00000000",
    profile: profil,
  };
}

// ── 1. Ein Providerfehler ist keine Latenz ─────────────────────

test("#493: ein Providerfehler wird NIE zur Latenzstichprobe — und die Zeile sagt es", async (t) => {
  const profil = createLatencyProfile({ path: join(await mkdtemp(join(tmpdir(), "bastra-mi-prof-")), "p.json") });
  // Genau der Fall aus dem Issue: Ollama antwortet nach 600 ms mit einem
  // Fehler. Vorher kam das als aufgelöste Promise mit `[]` zurück,
  // `abandonAfter` las darin ein `settled: true`, und 600 ms wurden als
  // „normaler dichter Arm" gelernt.
  const d = await daemonMit(t, armMitAusgang("error", 60), schattenMit(profil));
  await httpPost(d.port, "/hook/recall", { query: "deployen", k: 5, vector_deadline_ms: 2000 });

  const recalls = await readEvents(d.logDir, "hook_recall");
  const schatten = recalls[0].deadline_shadow as Record<string, unknown>;
  assert.equal(schatten.provider_outcome, "error", "der Ausgang steht in der Zeile");
  assert.equal(recalls[0].degraded_reason, "vector-arm-error");
  assert.equal(profil.sampleCount(KEY), 0, "und das Profil hat NICHTS daraus gelernt");
});

test("#493: ein leerer Arm ist ebenfalls keine Stichprobe, ein Arm mit Treffern schon", async (t) => {
  const profil = createLatencyProfile({ path: join(await mkdtemp(join(tmpdir(), "bastra-mi-prof-")), "p.json") });
  // `empty` heißt im häufigsten Fall „dieser Vault hat keine Vektoren" — dann
  // gab es gar keinen Providercall, und die Dauer ist keine Providerdauer.
  const leer = await daemonMit(t, armMitAusgang("empty", 30), schattenMit(profil));
  await httpPost(leer.port, "/hook/recall", { query: "deployen", k: 5, vector_deadline_ms: 2000 });
  const leerRecalls = await readEvents(leer.logDir, "hook_recall");
  assert.equal(
    (leerRecalls[0].deadline_shadow as Record<string, unknown>).provider_outcome,
    "empty",
  );
  assert.equal(profil.sampleCount(KEY), 0);

  // Und der Gegenbeweis: Ein Arm mit echten Treffern wird gelernt, sonst
  // prüfte der Test oben nur, dass nie etwas gelernt wird.
  const treffer = await daemonMit(t, armMitAusgang("hits", 30), schattenMit(profil));
  await httpPost(treffer.port, "/hook/recall", { query: "deployen", k: 5, vector_deadline_ms: 2000 });
  const trefferRecalls = await readEvents(treffer.logDir, "hook_recall");
  const zeile = trefferRecalls[0].deadline_shadow as Record<string, unknown>;
  assert.equal(zeile.provider_outcome, "hits");
  assert.equal(zeile.vector_hit_count, 1);
  assert.equal(typeof zeile.actual_settle_ms, "number");
  assert.equal(profil.sampleCount(KEY), 1, "genau diese eine Stichprobe");
});

test("#493: ein Kaltstart wird als Grundwahrheit aufgezeichnet, nicht geschätzt", async (t) => {
  const profil = createLatencyProfile({ path: join(await mkdtemp(join(tmpdir(), "bastra-mi-prof-")), "p.json") });
  const geladen: (number | null)[] = [];
  const shadow = { ...schattenMit(profil), observeLoad: (ms: number | null) => geladen.push(ms) };
  // Ollama meldet `load_duration` — der einzige Ort auf diesem Pfad, an dem
  // die Residenz berichtet und nicht erschlossen wird.
  const d = await daemonMit(t, armMitAusgang("hits", 30, 585), shadow);
  await httpPost(d.port, "/hook/recall", { query: "deployen", k: 5, vector_deadline_ms: 2000 });

  const recalls = await readEvents(d.logDir, "hook_recall");
  const zeile = recalls[0].deadline_shadow as Record<string, unknown>;
  assert.equal(zeile.cold_start_observed, true, "Tor 3 aus #492 zählt genau dieses Feld");
  assert.equal(zeile.provider_load_ms, 585, "roh, damit die Schwelle nachziehbar bleibt");
  assert.deepEqual(geladen, [585], "und der Lifecycle-Zustand erfährt davon");
});

// ── 2. Jede Lane an ihrer eigenen Wanduhr ──────────────────────

test("#493: die Wanduhr des Aufrufers gilt — und die Zeile sagt, woher sie kam", async (t) => {
  const profil = createLatencyProfile({ path: join(await mkdtemp(join(tmpdir(), "bastra-mi-prof-")), "p.json") });
  const eigen = await daemonMit(t, armMitAusgang("hits", 20), schattenMit(profil));
  // Die MCP-Lane schickt seit #493 ihr eigenes Budget mit.
  await httpPost(eigen.port, "/hook/recall", {
    query: "deployen", k: 5, vector_deadline_ms: 1500, hook_budget_ms: FORWARDER_HOOK_BUDGET_MS,
  });
  const mitBudget = (await readEvents(eigen.logDir, "hook_recall"))[0].deadline_shadow as Record<string, unknown>;
  assert.equal(mitBudget.lane_budget_ms, FORWARDER_HOOK_BUDGET_MS);
  assert.equal(mitBudget.budget_source, "caller");

  // Ohne mitgeschickte Zahl gilt weiterhin der Endpunkt-Default — aber die
  // Zeile behauptet nicht mehr, das sei die Wanduhr des Aufrufers.
  const ohne = await daemonMit(t, armMitAusgang("hits", 20), schattenMit(profil));
  await httpPost(ohne.port, "/hook/recall", { query: "deployen", k: 5, vector_deadline_ms: 1500 });
  const ohneBudget = (await readEvents(ohne.logDir, "hook_recall"))[0].deadline_shadow as Record<string, unknown>;
  assert.equal(ohneBudget.budget_source, "endpoint-default");
  assert.equal(ohneBudget.lane_budget_ms, 200, "die 200 der Prompt-Lane, als solche erkennbar");
});

test("#493: das Budget des Forwarders ist seine eigene Wanduhr, nicht die der Prompt-Lane", () => {
  // Der live belegte Defekt: `lane_budget_ms 200` bei `deadline_ms 1500`.
  assert.equal(FORWARDER_HOOK_BUDGET_MS, Math.min(REQUEST_TIMEOUT_MS, 10_000));
  assert.ok(FORWARDER_HOOK_BUDGET_MS > 200, "und damit über der Zahl, die er vorher erbte");
});

// ── 3. Residenz: Grundwahrheit vor Schätzung ───────────────────

function uhr(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, vor: (ms: number) => (t += ms) };
}

test("#493: Warmup und Unload schreiben in DENSELBEN Lifecycle-Zustand", async () => {
  const c = uhr();
  let lastOk: number | null = null;
  let warmCalls = 0;
  const warmup = createEmbeddingWarmup({
    denseArmAvailable: () => true,
    lastOkAt: () => lastOk,
    warm: async () => {
      warmCalls++;
    },
    now: c.now,
  });

  assert.equal(warmup.residency(), "unknown", "noch kein Beleg");

  // Der Defekt aus #493: Ein geglückter Warmup ging am Index vorbei, rührte
  // `lastOkAt` nicht an — und ein frisch gewärmtes Modell las `unknown`.
  assert.equal(warmup.ensureWarm(), "fired");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(warmCalls, 1);
  const nachWarmup = warmup.residencyDetail();
  assert.equal(nachWarmup.state, "warm");
  assert.equal(nachWarmup.source, "warm-up");
  assert.equal(nachWarmup.estimated, false, "beobachtet, nicht aus dem Fenster erschlossen");

  // Und der Gegenfall: Der Idle-Unload ist konfigurierbar und konnte dem
  // 8-Minuten-Fenster widersprechen. Jetzt schlägt er es.
  c.vor(1000);
  warmup.noteUnloaded();
  const nachUnload = warmup.residencyDetail();
  assert.equal(nachUnload.state, "cold");
  assert.equal(nachUnload.source, "unload-observed");
  assert.equal(nachUnload.estimated, false);

  // Ein Providercall danach beweist wieder das Gegenteil — die jüngere
  // Beobachtung gewinnt.
  c.vor(1000);
  warmup.noteLoaded(585);
  const nachLoad = warmup.residencyDetail();
  assert.equal(nachLoad.state, "warm");
  assert.equal(nachLoad.source, "provider-load");
  assert.equal(nachLoad.estimated, false);

  // Jenseits des Fensters steht die Antwort wieder auf der Schätzung — eine
  // alte Beobachtung belegt keine gegenwärtige Residenz.
  c.vor(RESIDENT_WINDOW_MS + 1);
  const spaeter = warmup.residencyDetail();
  assert.equal(spaeter.state, "cold");
  assert.equal(spaeter.estimated, true, "und die Zeile sagt, dass geschätzt wurde");
});

// ── 5. Die Kennung des Hosts ───────────────────────────────────

test("#493: der host_profile_id ist stabil, unterscheidet Hosts und nennt keinen", async (t) => {
  const dirA = await mkdtemp(join(tmpdir(), "bastra-host-a-"));
  const dirB = await mkdtemp(join(tmpdir(), "bastra-host-b-"));
  t.after(async () => {
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  });
  const pfadA = join(dirA, "host-profile.json");
  const pfadB = join(dirB, "host-profile.json");

  const a1 = computeHostProfileId(pfadA, "maschine-eins");
  const a2 = computeHostProfileId(pfadA, "maschine-eins");
  assert.equal(a1, a2, "derselbe Salt, derselbe Fingerabdruck: dieselbe Kennung");
  assert.match(a1, /^[0-9a-f]{16}$/);

  assert.notEqual(
    computeHostProfileId(pfadA, "maschine-zwei"),
    a1,
    "eine andere Maschine ist eine andere Kennung",
  );
  assert.notEqual(
    computeHostProfileId(pfadB, "maschine-eins"),
    a1,
    "und ohne den lokalen Salt lässt sie sich nicht nachrechnen",
  );

  // Datensparsam: Der Salt liegt lokal, in der Kennung steht nichts Lesbares.
  const datei = JSON.parse(await readFile(pfadA, "utf8")) as Record<string, unknown>;
  assert.equal(typeof datei.salt, "string");
  assert.ok(!a1.includes("maschine"), "der Fingerabdruck geht nur gehasht nach draußen");
});

// ── 4. Die Gruppierung eines Sitzungsstarts ────────────────────

test("#493: die Gruppierungs-ID verbindet das Sitzungsereignis mit JEDEM seiner Teil-Recalls", async (t) => {
  // Ein Sitzungsstart feuert mehrere korrelierte Recalls. Ohne Klammer ist
  // „20 Kaltstarts" (Tor 3 aus #492) nicht von „7 Kaltstarts × 3 Recalls" zu
  // unterscheiden, und die `session_id` leistet es nicht: Sie überlebt
  // compact/clear/resume und damit beliebig viele Starts.
  const profil = createLatencyProfile({ path: join(await mkdtemp(join(tmpdir(), "bastra-mi-prof-")), "p.json") });
  const d = await daemonMit(t, armMitAusgang("hits", 5), schattenMit(profil));
  const GRUPPE = "start-4711";

  await httpPost(d.port, "/hook/session-context", {
    project: "bastra-recall",
    session_id: "sess-493",
    cross_project: true,
    session_start_call_id: GRUPPE,
    vector_deadline_ms: 350,
    hook_budget_ms: 500,
  });

  const recalls = await readEvents(d.logDir, "hook_recall", 2);
  assert.ok(recalls.length >= 2, `ein Start feuert mehrere Recalls, waren ${recalls.length}`);
  for (const r of recalls) {
    assert.equal(r.session_start_call_id, GRUPPE, "jeder Teil-Recall trägt die Klammer");
    assert.equal(r.session_id, "sess-493", "die Session bleibt daneben stehen");
  }
  // Zählbar: EIN Start, egal wie viele Recalls er auslöst.
  assert.equal(new Set(recalls.map((r) => r.session_start_call_id)).size, 1);
});

test("#493: die Lane erzeugt die Klammer, schickt sie mit und schreibt sie auf ihre eigene Zeile", async (t) => {
  // Die andere Hälfte desselben Joins: Ohne den Wert AUF dem
  // `session_hook_call` wäre die Gruppe zwar in sich konsistent, aber nicht mit
  // dem Sitzungsereignis verbunden, das sie ausgelöst hat.
  const logDir = await mkdtemp(join(tmpdir(), "bastra-mi-lane-"));
  const koerper: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if ((req.url ?? "").split("?")[0] === "/hook/session-context" && raw) {
        koerper.push(JSON.parse(raw) as Record<string, unknown>);
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: { recalls: [] } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  t.after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await rm(logDir, { recursive: true, force: true });
  });

  const vorher = { tel: process.env.BASTRA_TELEMETRY, log: process.env.BASTRA_LOG_PATH };
  process.env.BASTRA_TELEMETRY = "on";
  process.env.BASTRA_LOG_PATH = logDir;
  try {
    await runSessionLane(
      { hook_event_name: "SessionStart", source: "startup", cwd: "/tmp", session_id: "sess-493-lane" },
      `http://127.0.0.1:${port}`,
    );
  } finally {
    if (vorher.tel === undefined) delete process.env.BASTRA_TELEMETRY;
    else process.env.BASTRA_TELEMETRY = vorher.tel;
    if (vorher.log === undefined) delete process.env.BASTRA_LOG_PATH;
    else process.env.BASTRA_LOG_PATH = vorher.log;
  }

  const zeile = (await readEvents(logDir, "session_hook_call"))[0];
  assert.ok(zeile, "die Lane schreibt ihre Zeile");
  assert.equal(typeof zeile.session_start_call_id, "string");
  assert.equal(koerper.length, 1);
  assert.equal(
    koerper[0].session_start_call_id,
    zeile.session_start_call_id,
    "dieselbe Klammer geht an den Assembler wie in die eigene Zeile",
  );
  assert.match(String(zeile.host_profile_id), /^[0-9a-f]{16}$/, "und die Hostkennung steht dabei");

  // Ein ZWEITER Start derselben Session bekommt eine eigene Klammer — genau
  // die Unterscheidung, die die `session_id` nicht leisten kann.
  const ersteGruppe = zeile.session_start_call_id;
  process.env.BASTRA_TELEMETRY = "on";
  process.env.BASTRA_LOG_PATH = logDir;
  try {
    await runSessionLane(
      { hook_event_name: "SessionStart", source: "compact", cwd: "/tmp", session_id: "sess-493-lane" },
      `http://127.0.0.1:${port}`,
    );
  } finally {
    if (vorher.tel === undefined) delete process.env.BASTRA_TELEMETRY;
    else process.env.BASTRA_TELEMETRY = vorher.tel;
    if (vorher.log === undefined) delete process.env.BASTRA_LOG_PATH;
    else process.env.BASTRA_LOG_PATH = vorher.log;
  }
  const beide = await readEvents(logDir, "session_hook_call", 2);
  assert.equal(beide.length, 2);
  assert.notEqual(beide[1].session_start_call_id, ersteGruppe);
});
