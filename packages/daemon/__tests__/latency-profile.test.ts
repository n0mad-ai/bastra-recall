/**
 * Das gelernte Latenzprofil (#491) — im SCHATTEN.
 *
 * Fünf Zusagen, jede einzeln still zu brechen:
 *
 *  1. Ein Profil bildet sich und ÜBERLEBT EINEN NEUSTART. Ein Profil, das mit
 *     dem Daemon stirbt, lernt bei jedem Boot dieselbe Woche neu.
 *  2. Ein MODELLWECHSEL startet frisch. Die 585 ms eines großen Modells als
 *     Frist für ein kleines wären genau der Fehler, den #491 abstellt.
 *  3. Die Ableitung wird von der WANDUHR DER LANE gedeckelt und sagt warum.
 *     Die Wanduhr ist ein Vertrag (SessionStart 500 ms, Prompt-Lane 200 ms),
 *     keine Schätzung.
 *  4. Ein LEERES Profil führt zu GENAU EINER lexikalischen Antwort. Der
 *     aufgegebene Embed läuft weiter und liefert die erste Stichprobe — der
 *     Kaltstart finanziert seine eigene Kalibrierung.
 *  5. Die ALTERUNG wirkt. Eine Woche alte Zahlen beschreiben eine Maschine,
 *     die es so nicht mehr gibt.
 *
 * Dazu die Durchreiche: Die Schattenspalte muss in der Telemetrie ankommen,
 * sonst ist am 13.09.2026 (#492) nichts auszuwerten.
 *
 * Hermetisch: injizierte Uhr, injizierter Pfad, kein echter Provider.
 *
 * Runner: node --import tsx --test packages/daemon/__tests__/latency-profile.test.ts
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
import {
  createLatencyProfile,
  MAX_DEADLINE_MS,
  MIN_DEADLINE_MS,
  SAMPLE_MAX_AGE_MS,
  SAMPLE_MAX_MS,
  type DeadlineShadow,
} from "../src/latency-profile.js";

const KEY = "ollama-embeddinggemma";
/** Ein anderes Modell hinter demselben Provider — der Fall aus #491. */
const ANDERES_MODELL = "ollama-qwen3-embedding";

/** Eine steuerbare Uhr; sonst hinge die Alterung an der Wanduhr des Testlaufs. */
function uhr(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, vor: (ms: number) => (t += ms) };
}

async function profilPfad(t: { after: (fn: () => unknown) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-latency-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return join(dir, "latency-profile.json");
}

/** Eine warme Session-Lane-Stichprobe: kurze Query, ein Arm in Flug. */
function stichprobe(totalMs: number) {
  return {
    key: KEY,
    residency: "warm" as const,
    queryChars: 40,
    concurrency: 1,
    totalMs,
  };
}

function ableitung(overlapMs = 0, laneRemainingMs = Infinity) {
  return {
    key: KEY,
    residency: "warm" as const,
    queryChars: 40,
    concurrency: 1,
    overlapMs,
    laneRemainingMs,
  };
}

// ── 1. Das Profil bildet sich und überlebt einen Neustart ──────

test("#491: das Profil bildet sich aus echten Gesamtzeiten und überlebt einen Neustart", async (t) => {
  const path = await profilPfad(t);
  const c = uhr();
  const profil = createLatencyProfile({ path, now: c.now });
  await profil.load();

  // Zwanzig warme Embeds, wie sie am 08.09.2026 gemessen wurden (33-54 ms),
  // plus ein langsamer Ausreißer, den ein p95 sehen muss.
  for (const ms of [33, 35, 38, 41, 44, 47, 50, 54, 36, 39, 42, 45, 48, 52, 34, 37, 40, 43, 46, 120]) {
    profil.record(stichprobe(ms));
  }
  assert.equal(profil.sampleCount(KEY), 20);

  const vorher = profil.derive(ableitung());
  assert.equal(vorher.basis, "bucket", "genug Stichproben für den genauen Eimer");
  assert.equal(vorher.cap_reason, "none");
  // Nearest-rank: ceil(0.95 · 20) = 19, also der 19. der 20 sortierten Werte.
  // Der eine Ausreißer (120) fällt damit heraus — das ist der Sinn eines p95:
  // die Frist deckt den Normalfall, nicht den schlimmsten Einzelfall.
  assert.equal(vorher.expected_total_ms, 54);
  assert.equal(vorher.predicted_deadline_ms, 54, "ohne Überlapp ist die Frist die erwartete Gesamtzeit");

  await profil.flush();

  // Der Neustart: neue Instanz, derselbe Pfad, dieselbe Uhr.
  const nachNeustart = createLatencyProfile({ path, now: c.now });
  await nachNeustart.load();
  assert.equal(nachNeustart.sampleCount(KEY), 20, "die Stichproben sind wieder da");
  assert.deepEqual(
    nachNeustart.derive(ableitung()),
    vorher,
    "und die abgeleitete Frist ist dieselbe — nicht neu zu lernen ist der ganze Sinn der Datei",
  );
});

test("#491: eine kaputte Profildatei ist ein leeres Profil, kein Bootfehler", async (t) => {
  const path = await profilPfad(t);
  await writeFile(path, "{ das ist kein JSON", "utf8");
  const profil = createLatencyProfile({ path });
  await profil.load();
  assert.equal(profil.sampleCount(KEY), 0);
  assert.equal(profil.derive(ableitung()).cap_reason, "profile-empty");
});

// ── 2. Modellwechsel ───────────────────────────────────────────

test("#491: ein Modellwechsel startet ein frisches Profil und erbt nichts", async (t) => {
  const path = await profilPfad(t);
  const c = uhr();
  const profil = createLatencyProfile({ path, now: c.now });
  // Ein großes, langsames Modell hat sich hier eingerichtet.
  for (let i = 0; i < 20; i++) profil.record({ ...stichprobe(580 + i), key: KEY });
  assert.ok(profil.derive(ableitung()).predicted_deadline_ms > 500);

  const nachWechsel = profil.derive({ ...ableitung(), key: ANDERES_MODELL });
  assert.equal(nachWechsel.cap_reason, "profile-empty", "das neue Modell erbt die alten 580 ms NICHT");
  assert.equal(nachWechsel.samples, 0);
  assert.equal(nachWechsel.predicted_deadline_ms, MIN_DEADLINE_MS);

  // Und das alte Profil bleibt daneben stehen: Wer zurückwechselt, findet es.
  assert.ok(profil.derive(ableitung()).predicted_deadline_ms > 500);
});

// ── 3. Die Wanduhr der Lane deckelt ────────────────────────────

test("#491: die Ableitung rechnet nach BM25 und wird von der Wanduhr der Lane gedeckelt", async (t) => {
  const path = await profilPfad(t);
  const profil = createLatencyProfile({ path, now: uhr().now });
  // Ein kaltes Modell: 585 ms gemessen am 08.09.2026.
  for (let i = 0; i < 20; i++) profil.record(stichprobe(580 + i));

  // Der Überlapp mit BM25 wird abgezogen — das Warten beginnt erst danach.
  const mitUeberlapp = profil.derive(ableitung(200));
  assert.equal(mitUeberlapp.expected_total_ms, 598, "nearest-rank p95 über 580…599");
  assert.equal(mitUeberlapp.predicted_deadline_ms, 398, "598 erwartet minus 200 schon verbraucht");
  assert.equal(mitUeberlapp.cap_reason, "none");

  // Die Prompt-Lane: 200 ms Budget, davon 150 vor Beginn des Wartens weg.
  const promptLane = profil.derive(ableitung(150, 50));
  assert.equal(promptLane.predicted_deadline_ms, 50);
  assert.equal(promptLane.cap_reason, "lane-wall-clock", "und sie sagt, WARUM sie so kurz ist");

  // Die SessionStart-Lane: 500 ms Wanduhr, BM25 kostet dort nur 10 ms.
  const sessionLane = profil.derive(ableitung(10, 490));
  assert.equal(sessionLane.predicted_deadline_ms, 490);
  assert.equal(sessionLane.cap_reason, "lane-wall-clock");

  // #494: UMGEDREHT. Diese Zusicherung stand hier andersherum — 5 ms Restbudget
  // ergaben eine Frist von 50 —, und sie war falsch: Eine Deadline, die
  // zehnmal so lang ist wie die Wanduhr, die sie decken soll, ist keine
  // Deadline. Solange das Profil nur im Schatten rechnet, ist das folgenlos;
  // ab #492 entscheidet es, und dann wäre es ein Vertragsbruch. Unter der
  // Mindestfrist ist die Antwort deshalb KEIN dichter Arm, und der Grund steht
  // in der Telemetriezeile.
  const fastNichts = profil.derive(ableitung(10, 5));
  assert.equal(fastNichts.predicted_deadline_ms, 0, "kein Arm, keine Frist");
  assert.equal(fastNichts.cap_reason, "lane-too-short");

  // Genau AUF der Mindestfrist läuft er noch — die Grenze ist die Zahl, die
  // `http-hook-routes.ts` gerade noch annimmt.
  const genauAufDerGrenze = profil.derive(ableitung(10, MIN_DEADLINE_MS));
  assert.equal(genauAufDerGrenze.predicted_deadline_ms, MIN_DEADLINE_MS);
  assert.equal(genauAufDerGrenze.cap_reason, "lane-wall-clock");

  // Ein Profil, das weniger will als die Untergrenze, sagt das ebenfalls.
  const schnell = createLatencyProfile({ path: `${path}.2`, now: uhr().now });
  for (let i = 0; i < 20; i++) schnell.record(stichprobe(20));
  const boden = schnell.derive(ableitung());
  assert.equal(boden.predicted_deadline_ms, MIN_DEADLINE_MS);
  assert.equal(boden.cap_reason, "floor");
});

// ── 4. Leeres Profil: genau einmal lexikalisch ─────────────────

test("#491: ein leeres Profil antwortet GENAU EINMAL lexikalisch — der aufgegebene Arm zahlt die Kalibrierung", async (t) => {
  const path = await profilPfad(t);
  const c = uhr();
  const profil = createLatencyProfile({ path, now: c.now });

  const erste = profil.derive(ableitung());
  assert.equal(erste.cap_reason, "profile-empty");
  assert.equal(erste.basis, "empty");
  assert.equal(
    erste.predicted_deadline_ms,
    MIN_DEADLINE_MS,
    "so kurz wie der Endpunkt zulässt: nicht warten, lexikalisch antworten",
  );

  // Genau das, was danach passiert: `abandonAfter` bricht NICHT ab, der Embed
  // läuft weiter und meldet sein echtes Settle (#489, `vector_late_settle`).
  c.vor(585);
  profil.record(stichprobe(585));

  const zweite = profil.derive(ableitung());
  assert.notEqual(zweite.cap_reason, "profile-empty", "ab jetzt gibt es eine Zahl");
  assert.equal(zweite.samples, 1);
  assert.equal(zweite.predicted_deadline_ms, 585, "und es ist die, die der Kaltstart bezahlt hat");
});

test("#491/#493: ein dünner Eimer fällt gröber zurück — aber nur INNERHALB seiner Residenz", async (t) => {
  const path = await profilPfad(t);
  const profil = createLatencyProfile({ path, now: uhr().now });
  for (let i = 0; i < 20; i++) profil.record(stichprobe(100));

  // Dieselbe Maschine, dieselbe Residenz — nur eine lange Query, wie sie die
  // Prompt-Lane schickt (p50 3671 Zeichen). Dieser Eimer ist leer.
  const langeQuery = profil.derive({ ...ableitung(), queryChars: 3671 });
  assert.equal(langeQuery.basis, "residency-wide", "gröber, aber es gibt überhaupt eine Zahl");
  assert.equal(langeQuery.samples, 20);
  assert.equal(langeQuery.bucket, "warm|m|1", "und der Eimer, in dem der Aufruf lag, steht trotzdem da");
});

test("#493: ein KALTER Eimer borgt nicht vom warmen — ein leerer Eimer ist ehrlicher als ein geborgter", async (t) => {
  const path = await profilPfad(t);
  const profil = createLatencyProfile({ path, now: uhr().now });
  // Ein volles warmes Profil über alle drei Dimensionen, wie es nach ein paar
  // Stunden Betrieb aussieht: 33-54 ms, gemessen 08.09.2026.
  for (const chars of [40, 512, 2000, 5000]) {
    for (const nebenlaeufig of [1, 2, 5]) {
      for (let i = 0; i < 10; i++) {
        profil.record({ ...stichprobe(70), queryChars: chars, concurrency: nebenlaeufig });
      }
    }
  }
  assert.ok(profil.sampleCount(KEY) >= 100);

  // Der erste kalte Arm dieser Maschine. Vor #493 erbte er das warme
  // ~70-ms-Profil und sah damit aus wie eine Antwort — bei einem gemessenen
  // Kaltstart von 585 ms.
  const kalt = profil.derive({ ...ableitung(), residency: "cold" });
  assert.equal(kalt.basis, "empty", "nichts geborgt");
  assert.equal(kalt.cap_reason, "profile-empty");
  assert.equal(kalt.samples, 0);
  assert.equal(kalt.expected_total_ms, null);

  // Und `unknown` ist eine eigene Residenz, also ebenfalls kein Erbe.
  assert.equal(profil.derive({ ...ableitung(), residency: "unknown" }).basis, "empty");

  // Sobald es kalte Stichproben gibt, spricht der kalte Eimer für sich — und
  // zwar mit SEINEN Zahlen, nicht mit den warmen.
  for (let i = 0; i < 6; i++) profil.record({ ...stichprobe(585), residency: "cold" });
  const jetzt = profil.derive({ ...ableitung(), residency: "cold" });
  assert.equal(jetzt.basis, "bucket");
  assert.equal(jetzt.predicted_deadline_ms, 585);
});

test("#493: die Verwurfsgrenze ist keine Latenzobergrenze mehr — ein 12-Sekunden-Settle bleibt erhalten", async (t) => {
  const path = await profilPfad(t);
  const profil = createLatencyProfile({ path, now: uhr().now });
  // Genau der Fall aus #493: schwache Hardware, echter Kaltlauf über 10 s. Er
  // wurde vorher verworfen, weil dieselbe Zahl Speichergrenze UND größte
  // anwendbare Frist war.
  for (let i = 0; i < 6; i++) profil.record({ ...stichprobe(12_000), residency: "cold" });
  assert.equal(profil.sampleCount(KEY), 6, "die Messung ist im Datensatz");

  const abgeleitet = profil.derive({ ...ableitung(), residency: "cold" });
  assert.equal(abgeleitet.expected_total_ms, 12_000, "und das Profil kennt sie");
  assert.equal(
    abgeleitet.predicted_deadline_ms,
    MAX_DEADLINE_MS,
    "anwenden lässt sie sich nicht — der Endpunkt nimmt höchstens 10 s",
  );
  assert.equal(abgeleitet.cap_reason, "max-deadline", "und die Zeile sagt, dass gedeckelt wurde");

  // Ein hängender Provider ist weiterhin keine Messung.
  profil.record({ ...stichprobe(SAMPLE_MAX_MS + 1), residency: "cold" });
  assert.equal(profil.sampleCount(KEY), 6);
});

// ── 5. Die Alterung ────────────────────────────────────────────

test("#491: die Alterung wirkt — eine Woche alte Zahlen zählen nicht mehr", async (t) => {
  const path = await profilPfad(t);
  const c = uhr();
  const profil = createLatencyProfile({ path, now: c.now });

  // Eine langsame Woche.
  for (let i = 0; i < 20; i++) profil.record(stichprobe(600));
  assert.equal(profil.derive(ableitung()).predicted_deadline_ms, 600);

  // Die Maschine wird schneller (schnelleres Modell, weniger Last) — die alten
  // Zahlen altern raus, die neuen bleiben.
  c.vor(SAMPLE_MAX_AGE_MS + 1);
  assert.equal(profil.sampleCount(KEY), 0, "alles Alte zählt nicht mehr mit");
  assert.equal(
    profil.derive(ableitung()).cap_reason,
    "profile-empty",
    "und ein Profil aus lauter veralteten Zahlen ist ein leeres Profil, keine Prognose",
  );

  for (let i = 0; i < 20; i++) profil.record(stichprobe(80));
  assert.equal(profil.derive(ableitung()).predicted_deadline_ms, 80, "die Prognose folgt der Gegenwart");

  // Und beim Neustart sind die veralteten Zahlen auch von Platte weg.
  await profil.flush();
  const neu = createLatencyProfile({ path, now: c.now });
  await neu.load();
  assert.equal(neu.sampleCount(KEY), 20);
});

test("#491: das gleitende Fenster verdrängt die ältesten Stichproben", async (t) => {
  const path = await profilPfad(t);
  const c = uhr();
  const profil = createLatencyProfile({ path, now: c.now });
  for (let i = 0; i < 40; i++) {
    profil.record(stichprobe(600));
    c.vor(1000);
  }
  // 40 langsame, dann 40 schnelle: Das Fenster hält 32, also ist danach keine
  // langsame mehr dabei.
  for (let i = 0; i < 40; i++) {
    profil.record(stichprobe(70));
    c.vor(1000);
  }
  assert.equal(profil.sampleCount(KEY), 32);
  assert.equal(profil.derive(ableitung()).predicted_deadline_ms, 70);
});

// ── Die Durchreiche in die Telemetrie ──────────────────────────

const DEADLINE_MS = 50;
/** Deutlich hinter der Frist — der Arm wird aufgegeben und läuft weiter. */
const ANTWORT_NACH_MS = 300;

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

/** Ein dichter Arm, der die Frist sicher reißt und danach doch noch liefert. */
function spaeterArm() {
  return {
    size: () => 1,
    runtimeHealth: () => ({ errorCount: 0 }),
    // #493: der strukturierte Ausgang — nur ein Arm mit echten Treffern ist
    // eine Latenzstichprobe.
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

test("#491: die Schattenspalte kommt in der Telemetrie an — Prognose, Wirklichkeit und Grund", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-shadow-vault-"));
  const logDir = await mkdtemp(join(tmpdir(), "bastra-shadow-logs-"));
  const path = await profilPfad(t);
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

  const profil = createLatencyProfile({ path });
  const deadlineShadow: DeadlineShadow = {
    key: () => KEY,
    // Der Fall, um den sich der ganze Entwurf dreht (#490/#492 Kriterium 3).
    residency: () => ({ state: "cold", source: "unload-observed", estimated: false }),
    observeLoad: () => {},
    hostProfileId: () => "testhost00000000",
    profile: profil,
  };
  const handle = await startHttpServer({
    port: 0, vault, search, telemetry, version: "test",
    toolDeps: { vault, search, telemetry, vaultPath: dir, deadlineShadow },
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

  await httpPost(handle.port!, "/hook/recall", {
    query: "deployen", k: 5, vector_deadline_ms: DEADLINE_MS, hook_budget_ms: 500,
  });

  const recalls = await readEvents(logDir, "hook_recall");
  const schatten = recalls[0].deadline_shadow as Record<string, unknown>;
  assert.ok(schatten, "`deadline_shadow` muss am hook_recall hängen");
  assert.equal(schatten.profile_key, KEY);
  assert.equal(schatten.deadline_ms, DEADLINE_MS, "die Zahl, die TATSÄCHLICH galt, steht daneben");
  assert.equal(schatten.cap_reason, "profile-empty", "erster Aufruf: noch kein Profil");
  assert.equal(schatten.predicted_deadline_ms, MIN_DEADLINE_MS);
  assert.equal(schatten.residency, "cold");
  assert.equal(schatten.timed_out, true);
  assert.equal(schatten.actual_settle_ms, undefined, "die Wirklichkeit steht beim Timeout in der späten Zeile");
  assert.equal(typeof schatten.overlap_ms, "number");
  assert.equal(schatten.lane_budget_ms, 500);
  assert.equal(schatten.bucket, "cold|xs|1");

  const spaet = await readEvents(logDir, "vector_late_settle");
  assert.equal(spaet[0].recall_id, recalls[0].recall_id);
  assert.equal(spaet[0].predicted_deadline_ms, MIN_DEADLINE_MS, "die Prognose reist mit, kein Join nötig");
  assert.equal(spaet[0].residency, "cold");
  assert.equal(spaet[0].shadow_timeout, true, "auch die gelernte Frist wäre gerissen — genau die Quote aus #492");

  // Und die späte Stichprobe ist im Profil gelandet: der Kaltstart hat seine
  // eigene Kalibrierung bezahlt.
  assert.equal(profil.sampleCount(KEY), 1, "genau eine Stichprobe, aus dem aufgegebenen Arm");
  const zweite = profil.derive({
    key: KEY, residency: "cold", queryChars: 8, concurrency: 1,
    overlapMs: 0, laneRemainingMs: Infinity,
  });
  assert.notEqual(zweite.cap_reason, "profile-empty");
  assert.ok(
    zweite.predicted_deadline_ms >= ANTWORT_NACH_MS - 60,
    `die gelernte Frist kennt jetzt die echte Dauer, war ${zweite.predicted_deadline_ms} ms`,
  );

  // Und an der Antwort hat der Schatten nichts geändert: Die Frist, die galt,
  // ist immer noch die mitgeschickte.
  assert.equal(recalls[0].degraded_reason, "vector-arm-timeout");
});

test("#491: ohne Schattenprofil bleibt die Telemetrie unverändert", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-shadow-off-vault-"));
  const logDir = await mkdtemp(join(tmpdir(), "bastra-shadow-off-logs-"));
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

  await httpPost(handle.port!, "/hook/recall", { query: "deployen", k: 5, vector_deadline_ms: DEADLINE_MS });
  const recalls = await readEvents(logDir, "hook_recall");
  assert.equal(recalls[0].deadline_shadow, undefined, "kein Profil, keine Spalte");
  assert.equal(recalls[0].degraded_reason, "vector-arm-timeout", "und alles andere wie gehabt");
});
