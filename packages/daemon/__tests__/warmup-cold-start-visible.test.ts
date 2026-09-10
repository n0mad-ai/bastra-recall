/**
 * Der Kaltstart, den seit #494 der WARMUP bezahlt (#495).
 *
 * #494 hat den kalten SessionStart lexikalisch gemacht — richtig fürs
 * Verhalten, aber damit wandert der Ladevorgang aus dem dichten Arm (der ihn
 * seit #493 sauber meldet) in den Warmup, und der zeichnete ihn nicht auf:
 * `embed()` statt `embedWithMeta()`, also Ollamas `load_duration` weggeworfen,
 * `noteLoaded(null)` als Meldung, keine eigene Zeile. Isoliert nachgemessen
 * (08.09.2026, zweites Ollama auf 11435, Modell nachweislich nicht resident):
 * ein 524,709-ms-Kaltstart, und in der Telemetrie nirgends ein
 * `provider_load_ms`. Tor 3 aus #492 zählt genau diese Kaltstarts — die
 * Optimierung und ihr Messkriterium hoben sich gegenseitig auf.
 *
 * Vier Zusagen, jede einzeln still zu brechen:
 *
 *  1. Ein Warmup auf kaltem Modell erzeugt ein Settle MIT Ladezeit und
 *     `coldStartObserved: true`, samt Auslöser und der Klammer des
 *     Sitzungsstarts, der ihn ausgelöst hat.
 *  2. Das Profil verwirft Stichproben aus der Semantik vor #493 (Dateiversion).
 *  3. Der Schatten trennt „hätte gewartet" von „hätte nicht weiter gewartet".
 *     #495 stand hier „ein Skip ist kein Riss"; #499 hat an Livezeilen
 *     gemessen, dass es den Skip auf diesem Pfad gar nicht gibt — der Arm
 *     läuft vor BM25 los. Die Zusage lautet seither: eine Prognose von 0
 *     nimmt der Zeile ihren Timeout-Vergleich NICHT.
 *  4. Auch ein WARMER Ladewert landet im Lifecycle-Zustand und macht die
 *     Residenz gemessen statt geschätzt.
 *
 * Hermetisch: injizierte Uhr, injizierter Pfad, kein echter Provider.
 *
 * Runner: node --import tsx --test packages/daemon/__tests__/warmup-cold-start-visible.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmbeddingWarmup, type WarmupSettle } from "../src/embedding-warmup.js";
import { createLatencyProfile } from "../src/latency-profile.js";
import { observeDeadlineShadow } from "../src/deadline-shadow-row.js";
import type { DeadlineShadow } from "../src/latency-profile.js";

const KEY = "ollama-embeddinggemma";

/** Eine steuerbare Uhr; sonst hinge die Residenz an der Wanduhr des Testlaufs. */
function uhr(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, vor: (ms: number) => (t += ms) };
}

// ── 1. Der Kaltstart landet in der Telemetrie ──────────────────

test("#495: ein Warmup auf kaltem Modell meldet seine Ladezeit und den Kaltstart", async () => {
  const settles: WarmupSettle[] = [];
  const c = uhr();
  const warmup = createEmbeddingWarmup({
    denseArmAvailable: () => true,
    lastOkAt: () => null, // noch kein erfolgreicher Embed → `unknown`, zählt wie kalt
    warm: async () => {
      c.vor(525);
      // Die Zahl aus dem isolierten Realtest vom 08.09.2026.
      return { loadMs: 524.709 };
    },
    now: c.now,
    onSettle: (s) => settles.push(s),
  });

  const residency = warmup.onSessionContact("sess-start-1");
  assert.equal(residency, "unknown", "ohne Beleg gilt das Modell als nicht resident");
  await warmup.warming();

  assert.equal(settles.length, 1, "genau ein Settle für den einen Warmup");
  const s = settles[0]!;
  assert.equal(s.ok, true);
  assert.equal(s.trigger, "session");
  assert.equal(s.providerLoadMs, 524.709, "Ollamas load_duration überlebt den Weg");
  assert.equal(s.coldStartObserved, true, "das ist die Größe, die Tor 3 zählt");
  assert.equal(s.residencyBefore, "unknown", "der Anlass des Warmups");
  assert.equal(
    s.sessionStartCallId,
    "sess-start-1",
    "die #493-Klammer reist mit — sonst ist der Kaltstart keinem Start zuzuordnen",
  );

  // Und der Ladevorgang ist danach GRUNDWAHRHEIT, keine Schätzung.
  const nachher = warmup.residencyDetail();
  assert.equal(nachher.state, "warm");
  assert.equal(nachher.source, "provider-load");
  assert.equal(nachher.estimated, false);
});

test("#495: ein gescheiterter Warmup meldet sich trotzdem, als Fehlschlag", async () => {
  const settles: WarmupSettle[] = [];
  const warmup = createEmbeddingWarmup({
    denseArmAvailable: () => true,
    lastOkAt: () => null,
    warm: () => Promise.reject(new Error("ollama down")),
    now: uhr().now,
    onSettle: (s) => settles.push(s),
  });

  warmup.ensureWarm("boot");
  await warmup.warming();

  assert.equal(settles.length, 1);
  assert.equal(settles[0]!.ok, false);
  assert.equal(settles[0]!.providerLoadMs, null, "ein Fehlschlag hat keine Ladezeit");
  assert.equal(settles[0]!.coldStartObserved, false);
});

test("#495: ein Provider ohne Ladeangabe meldet `null` — nicht `0`", async () => {
  const settles: WarmupSettle[] = [];
  const warmup = createEmbeddingWarmup({
    denseArmAvailable: () => true,
    lastOkAt: () => null,
    // Ein Provider ohne `embedWithMeta` (gehostete API): Der Warmup lief, aber
    // er kann NICHTS über einen Ladevorgang sagen.
    warm: async () => {},
    now: uhr().now,
    onSettle: (s) => settles.push(s),
  });

  warmup.ensureWarm("turn");
  await warmup.warming();

  assert.equal(settles[0]!.ok, true);
  assert.equal(
    settles[0]!.providerLoadMs,
    null,
    "keine Angabe ist nicht dasselbe wie kein Ladevorgang",
  );
  assert.equal(settles[0]!.coldStartObserved, false);
});

// ── 2. Das Profil lernt nicht aus der alten Semantik ───────────

test("#495: das Profil verwirft Stichproben aus der Zeit vor #493", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-latency-495-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const path = join(dir, "latency-profile.json");
  const c = uhr();

  // Eine Datei aus der alten Welt: Version 1, volle, brandaktuelle Eimer. Am
  // Livegerät waren es 36 von 40 Stichproben aus der Fehler-, Residenz- und
  // Nebenläufigkeitssemantik, die #493 ersetzt hat — nicht alt genug, um von
  // der Alterung erwischt zu werden, und in dünnen Eimern bis zum 13.09.
  // wirksam.
  const alt = Array.from({ length: 30 }, () => [c.now(), 600]);
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      profiles: { [KEY]: { updated_at: c.now(), buckets: { "warm|xs|1": alt } } },
    }) + "\n",
    "utf8",
  );

  const profile = createLatencyProfile({ path, now: c.now });
  await profile.load();

  const derived = profile.derive({
    key: KEY,
    residency: "warm",
    queryChars: 40,
    concurrency: 1,
    overlapMs: 0,
    laneRemainingMs: Infinity,
  });
  assert.equal(derived.samples, 0, "keine einzige Stichprobe aus der alten Semantik");
  assert.equal(derived.basis, "empty");
  assert.equal(
    derived.cap_reason,
    "profile-empty",
    "ein leerer Eimer ist ehrlicher als ein aus der alten Welt geerbter",
  );
});

test("#495: eine Datei der AKTUELLEN Version wird weiterhin geladen", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-latency-495b-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const path = join(dir, "latency-profile.json");
  const c = uhr();

  // Der Gegentest zum obigen: Der Versionssprung darf nicht bedeuten, dass die
  // Persistenz überhaupt nicht mehr trägt (#491, Zusage 1).
  const schreiber = createLatencyProfile({ path, now: c.now });
  for (let i = 0; i < 10; i++) {
    schreiber.record({ key: KEY, residency: "warm", queryChars: 40, concurrency: 1, totalMs: 70 });
  }
  await schreiber.flush();

  const leser = createLatencyProfile({ path, now: c.now });
  await leser.load();
  const derived = leser.derive({
    key: KEY,
    residency: "warm",
    queryChars: 40,
    concurrency: 1,
    overlapMs: 0,
    laneRemainingMs: Infinity,
  });
  assert.equal(derived.samples, 10, "ein Neustart erbt sein eigenes Profil");
});

// ── 3./4. Der Schatten: kein Timeout ohne Arm, jeder Ladewert zählt ──

/** Ein Schatten mit echtem Profil und mitschreibendem Lifecycle-Zustand. */
function schatten(now: () => number): {
  shadow: DeadlineShadow;
  loads: (number | null)[];
} {
  const loads: (number | null)[] = [];
  return {
    loads,
    shadow: {
      key: () => KEY,
      residency: () => ({ state: "warm", source: "last-ok", estimated: true }),
      observeLoad: (ms) => loads.push(ms),
      hostProfileId: () => "host-test",
      profile: createLatencyProfile({ path: join(tmpdir(), "nie-geschrieben.json"), now }),
    },
  };
}

test("#499: ohne Restbudget wird nicht weiter gewartet — aber der Arm lief", () => {
  const c = uhr();
  const { shadow } = schatten(c.now);

  // Die Lane hat weniger übrig als die Mindestfrist: Die Prognose ist 0.
  // #495 las das als „kein dichter Arm"; #499 hat gemessen, dass es das nicht
  // sein kann — der Arm wird VOR BM25 abgefeuert und ist hier längst in Flug.
  // 0 heißt deshalb „nicht weiter warten", und der Timeout-Vergleich bleibt
  // gültig statt zu fehlen.
  const row = observeDeadlineShadow({
    shadow,
    key: KEY,
    residency: shadow.residency(),
    concurrency: 1,
    queryChars: 40,
    vectorMs: 12,
    waitMs: 12,
    spentBeforeRecallMs: 495,
    budgetMs: 500,
    budgetSource: "caller",
    deadlineMs: 50,
    timedOut: false,
    report: { outcome: "hits", hit_count: 3, provider_load_ms: null, cold_start_observed: false },
  });

  assert.equal(row.cap_reason, "lane-too-short");
  assert.equal(row.predicted_deadline_ms, 0);
  assert.equal(row.shadow_would_run, true, "der Arm lief — er wurde vor BM25 abgefeuert");
  assert.equal(row.shadow_would_wait, false, "gewartet hätte die gelernte Politik nicht mehr");
  assert.equal(row.shadow_timeout, true, "12 ms Wartezeit gegen „nicht weiter warten“");
  assert.equal(row.actual_settle_ms, 12, "die Wirklichkeit bleibt trotzdem in der Zeile");
});

test("#495: ein gestarteter Arm behält seinen Timeout-Vergleich", () => {
  const c = uhr();
  const { shadow } = schatten(c.now);
  for (let i = 0; i < 10; i++) {
    shadow.profile.record({
      key: KEY,
      residency: "warm",
      queryChars: 40,
      concurrency: 1,
      totalMs: 70,
    });
  }

  const row = observeDeadlineShadow({
    shadow,
    key: KEY,
    residency: shadow.residency(),
    concurrency: 1,
    queryChars: 40,
    vectorMs: 400,
    waitMs: 400,
    spentBeforeRecallMs: 0,
    budgetMs: 500,
    budgetSource: "caller",
    deadlineMs: 350,
    timedOut: false,
    report: { outcome: "hits", hit_count: 3, provider_load_ms: null, cold_start_observed: false },
  });

  assert.equal(row.shadow_would_run, true);
  assert.equal(row.shadow_would_wait, true, "mit Restbudget hätte die Politik gewartet");
  assert.equal(row.shadow_timeout, true, "400 ms Wartezeit gegen eine Frist um 70 ms");
});

test("#495: auch ein WARMER Ladewert geht in den Lifecycle-Zustand", () => {
  const c = uhr();
  const { shadow, loads } = schatten(c.now);

  // Ollama meldet `load_duration` auch auf einem längst residenten Modell
  // (warm gemessen 0,7–2,9 ms). Die Bedingung auf `cold_start_observed` warf
  // genau diese vorhandene Grundwahrheit weg, weshalb live weiterhin
  // `residency_source: last-ok, estimated: true` stand.
  observeDeadlineShadow({
    shadow,
    key: KEY,
    residency: shadow.residency(),
    concurrency: 1,
    queryChars: 40,
    vectorMs: 45,
    waitMs: 45,
    spentBeforeRecallMs: 0,
    budgetMs: 500,
    budgetSource: "caller",
    deadlineMs: 350,
    timedOut: false,
    report: { outcome: "hits", hit_count: 3, provider_load_ms: 2.9, cold_start_observed: false },
  });

  assert.deepEqual(loads, [2.9], "der warme Ladewert wird gemeldet, nicht verworfen");
});

test("#495: ein warmer Ladewert macht die Residenz gemessen statt geschätzt", () => {
  const c = uhr();
  // Der Koordinator ist der Zustand, in den `observeLoad` schreibt. Ohne einen
  // Warmup und ohne `lastOkAt` gilt das Modell als unbekannt.
  const warmup = createEmbeddingWarmup({
    denseArmAvailable: () => true,
    lastOkAt: () => null,
    warm: async () => {},
    now: c.now,
  });
  assert.equal(warmup.residencyDetail().state, "unknown");

  warmup.noteLoaded(2.9);

  const reading = warmup.residencyDetail();
  assert.equal(reading.state, "warm");
  assert.equal(reading.source, "provider-load", "der Provider hat gerade geladen — Messung");
  assert.equal(reading.estimated, false, "Tor 3 darf auf geschätzten Zeilen nicht zählen");
});

test("#495: ein Arm OHNE Ladeangabe meldet nichts — `null` ist keine Beobachtung", () => {
  const c = uhr();
  const { shadow, loads } = schatten(c.now);

  observeDeadlineShadow({
    shadow,
    key: KEY,
    residency: shadow.residency(),
    concurrency: 1,
    queryChars: 40,
    vectorMs: 45,
    waitMs: 45,
    spentBeforeRecallMs: 0,
    budgetMs: 500,
    budgetSource: "caller",
    deadlineMs: 350,
    timedOut: false,
    report: { outcome: "hits", hit_count: 3, provider_load_ms: null, cold_start_observed: false },
  });

  assert.deepEqual(loads, [], "ein Provider ohne Ladeangabe belegt gar nichts");
});
