/**
 * Zwei Wahrheiten, die der Schatten des dichten Arms schuldet (#499).
 *
 * Beide Befunde stammen aus der ERSTEN Messnacht (09.09.2026), nicht aus einer
 * Diff-Lektüre, und beide Tests sind an genau diesen Livezeilen gebaut:
 *
 *  1. FEHLENDES RESTBUDGET IST KEIN UNGESTARTETER ARM. Drei Prompt-Zeilen
 *     trugen `predicted 0 / cap_reason lane-too-short / settle 279, 208,
 *     320 ms / timed_out false`. Der Schatten meldete dafür
 *     `shadow_would_run: false` und ließ `shadow_timeout` weg — 3 von 21
 *     Zeilen fielen damit aus Kriterium 4 aus #492 heraus. Der Arm wird aber
 *     VOR BM25 abgefeuert; wenn die Prognose entsteht, ist er in Flug. `0`
 *     heißt „nicht weiter warten", und alle drei fusionierten unter der festen
 *     Zahl (zusätzliche Wartezeit rekonstruiert 6, 2 und 5 ms).
 *
 *  2. DIE STICHPROBE GEHÖRT UNTER DIE GRUNDWAHRHEIT. Eine Zeile trug
 *     `residency: cold, residency_source: last-ok, residency_estimated: true`
 *     bei `provider_load_ms: 0.800791` und wurde als `cold|xs|2-3` mit 85 ms
 *     abgelegt. `cold|xs|2-3 = [85]` war der EINZIGE kalte Eintrag im ganzen
 *     Profil — die kalte Trainingsmenge bestand zu 100 % aus einem warmen
 *     Call.
 *
 * Hermetisch: injizierte Uhr, injizierter Pfad, kein echter Provider. Geprüft
 * wird gegen die PERSISTIERTE Datei, weil erst dort der Eimerschlüssel steht,
 * um den es geht.
 *
 * Runner: node --import tsx --test packages/daemon/__tests__/deadline-shadow-truth.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  observeDeadlineShadow,
  recordLateSettleSample,
  sampleResidency,
} from "../src/deadline-shadow-row.js";
import { createLatencyProfile, type DeadlineShadow } from "../src/latency-profile.js";
import type { ResidencyReading } from "../src/embedding-warmup.js";

const KEY = "ollama-embeddinggemma";

function uhr(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, vor: (ms: number) => (t += ms) };
}

/**
 * Die Vorab-Lesung der drei Livezeilen: geschätzt kalt aus dem
 * 8-Minuten-Fenster, während der Provider hinterher warm belegt.
 */
const GESCHAETZT_KALT: ResidencyReading = {
  state: "cold",
  source: "last-ok",
  estimated: true,
};

async function schatten(now: () => number): Promise<{
  shadow: DeadlineShadow;
  path: string;
  /** Die Eimer des Profils, so wie sie auf Platte stehen. */
  eimer: () => Promise<Record<string, [number, number][]>>;
  aufraeumen: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "shadow-truth-"));
  const path = join(dir, "latency-profile.json");
  const profile = createLatencyProfile({ path, now });
  return {
    path,
    aufraeumen: () => rm(dir, { recursive: true, force: true }),
    eimer: async () => {
      await profile.flush();
      const raw = JSON.parse(await readFile(path, "utf8"));
      return raw.profiles?.[KEY]?.buckets ?? {};
    },
    shadow: {
      key: () => KEY,
      residency: () => GESCHAETZT_KALT,
      observeLoad: () => {},
      hostProfileId: () => "host-test",
      profile,
    },
  };
}

// ── 1. Kein Restbudget heißt „nicht weiter warten" ─────────────

test("#499: eine Zeile ohne Restbudget ist von einer ohne Arm unterscheidbar", async () => {
  const c = uhr();
  const s = await schatten(c.now);
  try {
    // Die Prompt-Lane hat 200 ms Wanduhr, BM25 hat sie längst überzogen. Die
    // Livegestalt: Prognose 0, `lane-too-short`, Settle 279 ms bei 6 ms
    // zusätzlicher Wartezeit, kein Timeout an der festen Zahl.
    const ohneRestbudget = observeDeadlineShadow({
      shadow: s.shadow,
      key: KEY,
      residency: GESCHAETZT_KALT,
      concurrency: 2,
      queryChars: 3671,
      vectorMs: 279,
      waitMs: 6,
      spentBeforeRecallMs: 0,
      budgetMs: 200,
      budgetSource: "caller",
      deadlineMs: 150,
      timedOut: false,
      report: {
        outcome: "hits",
        hit_count: 12,
        provider_load_ms: 0.800791,
        cold_start_observed: false,
      },
    });

    assert.equal(ohneRestbudget.cap_reason, "lane-too-short");
    assert.equal(ohneRestbudget.predicted_deadline_ms, 0);
    assert.equal(
      ohneRestbudget.shadow_would_run,
      true,
      "der Arm lief — er wurde vor BM25 abgefeuert und war hier in Flug",
    );
    assert.equal(
      ohneRestbudget.shadow_would_wait,
      false,
      "gewartet hätte die gelernte Politik nicht mehr",
    );
    assert.equal(
      ohneRestbudget.shadow_timeout,
      true,
      "6 ms Wartezeit gegen „nicht weiter warten“ — diese Fusion wäre verloren",
    );
    assert.equal(
      ohneRestbudget.actual_settle_ms,
      279,
      "die Wirklichkeit trägt die Zeile weiter für Kriterium 4",
    );
  } finally {
    await s.aufraeumen();
  }
});

test("#499: mit Restbudget bleibt der Vergleich der normale", async () => {
  const c = uhr();
  const s = await schatten(c.now);
  try {
    for (let i = 0; i < 10; i++) {
      s.shadow.profile.record({
        key: KEY,
        residency: "cold",
        queryChars: 3671,
        concurrency: 2,
        totalMs: 300,
      });
    }
    const mitRestbudget = observeDeadlineShadow({
      shadow: s.shadow,
      key: KEY,
      residency: GESCHAETZT_KALT,
      concurrency: 2,
      queryChars: 3671,
      vectorMs: 279,
      waitMs: 6,
      spentBeforeRecallMs: 0,
      budgetMs: 2000,
      budgetSource: "caller",
      deadlineMs: 150,
      timedOut: false,
      report: {
        outcome: "hits",
        hit_count: 12,
        provider_load_ms: 0.800791,
        cold_start_observed: false,
      },
    });

    assert.notEqual(mitRestbudget.cap_reason, "lane-too-short");
    assert.equal(mitRestbudget.shadow_would_wait, true);
    assert.equal(
      mitRestbudget.shadow_timeout,
      false,
      "6 ms Wartezeit gegen eine Frist um 300 ms",
    );
  } finally {
    await s.aufraeumen();
  }
});

// ── 2. Die Stichprobe landet unter der Grundwahrheit ───────────

test("#499: ein warm belegter Call landet nie im kalten Eimer", async () => {
  const c = uhr();
  const s = await schatten(c.now);
  try {
    // Die Livezeile: Vorab-Lesung geschätzt kalt, Provider meldet 0,800791 ms
    // Ladezeit. 0,8 ms lädt kein Modell, das nicht schon im Speicher liegt.
    const row = observeDeadlineShadow({
      shadow: s.shadow,
      key: KEY,
      residency: GESCHAETZT_KALT,
      concurrency: 2,
      queryChars: 40,
      vectorMs: 85,
      waitMs: 85,
      spentBeforeRecallMs: 0,
      budgetMs: 500,
      budgetSource: "caller",
      deadlineMs: 350,
      timedOut: false,
      report: {
        outcome: "hits",
        hit_count: 4,
        provider_load_ms: 0.800791,
        cold_start_observed: false,
      },
    });

    // Prognose und Telemetrie stehen weiter auf der Vorab-Lesung — auf ihr
    // wurde entschieden.
    assert.equal(row.residency, "cold");
    assert.equal(row.residency_estimated, true);
    assert.equal(row.bucket, "cold|xs|2-3", "die Prognose lag im kalten Eimer");

    const eimer = await s.eimer();
    assert.deepEqual(
      Object.keys(eimer),
      ["warm|xs|2-3"],
      "die Stichprobe gehört unter die Grundwahrheit des Providers",
    );
    assert.equal(eimer["warm|xs|2-3"][0][1], 85);
  } finally {
    await s.aufraeumen();
  }
});

test("#499: auch der Late-Settle-Pfad klassifiziert aus dem Providerergebnis", async () => {
  const c = uhr();
  const s = await schatten(c.now);
  try {
    // Der aufgegebene Arm — die einzigen Zeilen, die den kalten Schwanz sehen.
    // Genau hier entscheidet sich, ob der kalte Eimer je echte kalte Daten
    // bekommt.
    const row = observeDeadlineShadow({
      shadow: s.shadow,
      key: KEY,
      residency: GESCHAETZT_KALT,
      concurrency: 1,
      queryChars: 40,
      vectorMs: 350,
      waitMs: 350,
      spentBeforeRecallMs: 0,
      budgetMs: 500,
      budgetSource: "caller",
      deadlineMs: 350,
      timedOut: true,
      report: null,
    });

    // Warm belegt, obwohl die Vorab-Lesung kalt schätzte.
    recordLateSettleSample(s.shadow, KEY, GESCHAETZT_KALT, row, {
      settle_ms: 60,
      settled: true,
      outcome: "hits",
      provider_load_ms: 1.4,
      cold_start_observed: false,
    });
    // Und der echte Kaltstart, gemessen 08.09.2026 mit 524,709 ms Ladezeit.
    recordLateSettleSample(s.shadow, KEY, GESCHAETZT_KALT, row, {
      settle_ms: 525,
      settled: true,
      outcome: "hits",
      provider_load_ms: 524.709,
      cold_start_observed: true,
    });

    const eimer = await s.eimer();
    assert.deepEqual(Object.keys(eimer).sort(), ["cold|xs|1", "warm|xs|1"]);
    assert.equal(eimer["warm|xs|1"][0][1], 60, "warm belegt → warmer Eimer");
    assert.equal(
      eimer["cold|xs|1"][0][1],
      525 + row.overlap_ms,
      "ein echter Kaltstart bleibt kalt — Gesamtzeit aus Überlapp und Settle",
    );
  } finally {
    await s.aufraeumen();
  }
});

test("#499: ohne gemeldete Ladezeit bleibt es bei der Vorab-Lesung", () => {
  // Keine Grundwahrheit, keine Umbuchung — und `hosted` kennt gar kein Modell,
  // das laden könnte.
  assert.equal(sampleResidency(GESCHAETZT_KALT, null), "cold");
  assert.equal(sampleResidency(GESCHAETZT_KALT, undefined), "cold");
  assert.equal(
    sampleResidency({ state: "hosted", source: "hosted", estimated: false }, 400),
    "hosted",
  );
  // Die Schwelle ist dieselbe wie bei `cold_start_observed` (200 ms).
  assert.equal(sampleResidency(GESCHAETZT_KALT, 199), "warm");
  assert.equal(
    sampleResidency({ state: "warm", source: "last-ok", estimated: true }, 200),
    "cold",
  );
});

// ── 3. Der vergiftete Alteintrag überlebt den Versionssprung nicht ──

test("#499: das Profil der ersten Nacht wird beim Laden verworfen", async () => {
  const c = uhr();
  const s = await schatten(c.now);
  try {
    // Exakt die Datei, die live stand: Version 2, und `cold|xs|2-3 = [85]` als
    // einziger kalter Eintrag — ein warmer Call unter kalter Etikette.
    await writeFile(
      s.path,
      JSON.stringify({
        version: 2,
        profiles: {
          [KEY]: {
            updated_at: c.now(),
            buckets: { "cold|xs|2-3": [[c.now(), 85]], "warm|l|1": [[c.now(), 336]] },
          },
        },
      }) + "\n",
      "utf8",
    );

    await s.shadow.profile.load();
    assert.equal(
      s.shadow.profile.sampleCount(KEY),
      0,
      "Version 2 hieß: Stichprobe unter der Schätzung abgelegt — nichts davon zählt weiter",
    );
  } finally {
    await s.aufraeumen();
  }
});
