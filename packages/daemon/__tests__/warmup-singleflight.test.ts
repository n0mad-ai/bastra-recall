/**
 * #494 — der kalte Start feuert EINEN Embed, nicht fünf.
 *
 * Das Gegenreview vom 08.09.2026 hat drei Verhaltensdefekte gefunden, die
 * #490/#491 hinterlassen haben. Dieser Test hält die Korrekturen an genau den
 * Stellen fest, an denen sie still wieder zerfallen würden:
 *
 *  1. EINE Singleflight-Grenze am Provider, durch die JEDER Warmup läuft —
 *     Boot eingeschlossen. Der Boot ging vorher an ihr vorbei
 *     (`prewarmOllamaModel`, eigener HTTP-Call), also konnte ein frischer
 *     Daemon plus ein SessionStart bis zu fünf gleichzeitige Embeds auslösen:
 *     Boot-Warmup, koordinierter Warmup und drei dichte Arme.
 *  2. `lexical_only` auf dem Recall-Pfad: Der kalte SessionStart WÄHLT den
 *     dichten Arm ab, statt ihm eine 50-ms-Frist zu geben, die er sicher
 *     reißt. Ehrlich benannt, und ohne eine Latenzstichprobe zu erfinden.
 *  3. Unter der Mindestfrist gibt es keinen Arm — und die Telemetrie sagt es.
 *
 * Der Beleg zu 1 zählt die tatsächlichen PROVIDERCALLS (der Zähler aus #493
 * sitzt am Providerrand), nicht die Absicht. Das Gegenstück dazu steht im
 * selben Test: Auf einem warmen Modell laufen die dichten Arme sehr wohl —
 * sonst bewiese die Null nur, dass gar nichts gemessen wird.
 *
 * Runner: node --import tsx --test packages/daemon/__tests__/warmup-singleflight.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { Vault, SearchIndex, type EmbeddingProvider } from "@bastra-recall/core";
import { Telemetry } from "../src/telemetry.js";
import { startHttpServer } from "../src/http.js";
import { runSessionLane } from "../src/session-lane.js";
import { countingProvider, createLatencyProfile, type DeadlineShadow } from "../src/latency-profile.js";
import { createEmbeddingWarmup } from "../src/embedding-warmup.js";

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
      for (const line of (await readFile(join(logDir, f), "utf8")).split("\n")) {
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
 * Der Provider, an dem gezählt wird — dieselbe Naht wie im Daemon: der
 * Nebenläufigkeitszähler (#493) liegt am Providerrand, also kommt hier alles
 * durch, was Ollama wirklich beschäftigt (jeder dichte Arm UND jeder Warmup).
 */
function zaehlenderProvider(profil: ReturnType<typeof createLatencyProfile>) {
  const texte: string[][] = [];
  let freigeben: (() => void) | null = null;
  const roh: EmbeddingProvider = {
    id: KEY,
    dim: 3,
    embed: async (t: string[]) => {
      texte.push(t);
      // Hängt, bis der Test freigibt: So bleibt der erste Embed nachweislich
      // in Flug, während die Lane läuft — genau die Lage beim kalten Start.
      await new Promise<void>((r) => {
        freigeben = r;
      });
      return t.map(() => new Float32Array([1, 0, 0]));
    },
  };
  return {
    provider: countingProvider(roh, profil),
    calls: () => texte.length,
    texte: () => texte,
    freigeben: () => freigeben?.(),
  };
}

/** Der dichte Arm, wie ihn `SearchIndex` sieht — er embeddet die Query, also
 *  geht er durch dieselbe Grenze wie der Warmup. */
function armUeber(provider: EmbeddingProvider) {
  return {
    size: () => 1,
    runtimeHealth: () => ({ errorCount: 0 }),
    searchDetailed: async (q: string) => {
      await provider.embed([q]);
      return { outcome: "hits" as const, hits: [{ id: "a", score: 0.9 }], providerLoadMs: null, coldStartObserved: false };
    },
  } as never;
}

async function daemonMit(
  t: { after: (fn: () => unknown) => void },
  arm: ReturnType<typeof armUeber>,
  shadow?: DeadlineShadow,
) {
  const dir = await mkdtemp(join(tmpdir(), "bastra-sf-vault-"));
  const logDir = await mkdtemp(join(tmpdir(), "bastra-sf-logs-"));
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

// ── 1. Fünf Embeds werden einer ────────────────────────────────

test("#494: ein kalter SessionStart erzeugt GENAU EINEN Providercall", async (t) => {
  const profil = createLatencyProfile({ path: join(await mkdtemp(join(tmpdir(), "bastra-sf-prof-")), "p.json") });
  const p = zaehlenderProvider(profil);
  const d = await daemonMit(t, armUeber(p.provider));
  t.after(() => p.freigeben());

  const warmup = createEmbeddingWarmup({
    // Der Boot läuft VOR `embIdx.start()`: Der Vektorindex hängt noch nicht,
    // der Provider ist trotzdem ansprechbar. Genau diese Unterscheidung war
    // der Grund, warum der Boot bis #494 an der Grenze vorbeilief.
    denseArmAvailable: () => false,
    providerAvailable: () => true,
    lastOkAt: () => null,
    warm: async () => {
      await p.provider.embed(["warm"]);
    },
  });

  // Der Boot-Warmup — seit #494 durch dieselbe Grenze.
  assert.equal(warmup.ensureWarm("boot"), "fired");
  assert.equal(p.calls(), 1, "der Boot lädt das Modell");

  // Und jetzt der SessionStart, während dieser Ladevorgang noch läuft.
  const vorher = { tel: process.env.BASTRA_TELEMETRY, log: process.env.BASTRA_LOG_PATH };
  process.env.BASTRA_TELEMETRY = "on";
  process.env.BASTRA_LOG_PATH = d.logDir;
  try {
    await runSessionLane(
      { hook_event_name: "SessionStart", source: "startup", cwd: "/tmp", session_id: "sess-494" },
      `http://127.0.0.1:${d.port}`,
      warmup,
    );
  } finally {
    if (vorher.tel === undefined) delete process.env.BASTRA_TELEMETRY;
    else process.env.BASTRA_TELEMETRY = vorher.tel;
    if (vorher.log === undefined) delete process.env.BASTRA_LOG_PATH;
    else process.env.BASTRA_LOG_PATH = vorher.log;
  }

  assert.equal(
    p.calls(),
    1,
    `bis zu fünf Embeds beim kalten Start sind einer geworden — waren ${p.calls()}: ${JSON.stringify(p.texte())}`,
  );
  assert.deepEqual(p.texte(), [["warm"]], "und der eine ist der Warmup, nicht ein aufgegebener Arm");

  // Die Recalls sind wirklich gelaufen, nur eben lexikalisch — sonst bewiese
  // die Eins oben bloß, dass der SessionStart gescheitert ist.
  const recalls = await readEvents(d.logDir, "hook_recall", 2);
  assert.ok(recalls.length >= 2, `der Start feuert seine Recalls weiterhin, waren ${recalls.length}`);
  for (const r of recalls) {
    assert.equal(r.lexical_only, true, "als solcher erkennbar, sonst zählt #492 einen Kaltstart, den es nicht gab");
    assert.equal(r.deadline_shadow, undefined, "und er erfindet keine Latenzstichprobe");
  }
  assert.equal(profil.sampleCount(KEY), 0, "das Profil lernt aus einem Lauf ohne Arm nichts");
});

test("#494: auf WARMEM Modell laufen die dichten Arme sehr wohl — die Null oben misst etwas", async (t) => {
  const profil = createLatencyProfile({ path: join(await mkdtemp(join(tmpdir(), "bastra-sf-prof-")), "p.json") });
  const p = zaehlenderProvider(profil);
  const d = await daemonMit(t, armUeber(p.provider));
  t.after(() => p.freigeben());

  const jetzt = 5_000_000;
  const warmup = createEmbeddingWarmup({
    denseArmAvailable: () => true,
    // Letzter erfolgreicher Embed gerade eben: resident.
    lastOkAt: () => jetzt - 1_000,
    warm: async () => {
      await p.provider.embed(["warm"]);
    },
    now: () => jetzt,
  });
  assert.equal(warmup.residency(), "warm");

  const vorher = process.env.BASTRA_TELEMETRY;
  process.env.BASTRA_TELEMETRY = "off";
  try {
    await runSessionLane(
      { hook_event_name: "SessionStart", source: "startup", cwd: "/tmp", session_id: "sess-494-warm" },
      `http://127.0.0.1:${d.port}`,
      warmup,
    );
  } finally {
    if (vorher === undefined) delete process.env.BASTRA_TELEMETRY;
    else process.env.BASTRA_TELEMETRY = vorher;
  }

  assert.ok(p.calls() >= 2, `jeder Recall des Starts hat seinen dichten Arm, waren ${p.calls()}`);
  assert.ok(!p.texte().some((t) => t[0] === "warm"), "und ein residentes Modell braucht keinen Warmup");
});

// ── 2. Der Boot-Warmup läuft durch dieselbe Grenze ─────────────

test("#494: Boot, Turn und Session teilen sich EINE Singleflight-Grenze", async () => {
  let calls = 0;
  let freigeben: (() => void) | null = null;
  // Der Vektorindex hängt beim Boot noch nicht — das ist der ganze Unterschied
  // zwischen dem Boot und den beiden anderen Auslösern.
  let indexHaengt = false;
  const warmup = createEmbeddingWarmup({
    denseArmAvailable: () => indexHaengt,
    providerAvailable: () => true,
    lastOkAt: () => null,
    warm: () => {
      calls++;
      return new Promise<void>((r) => {
        freigeben = r;
      });
    },
    now: () => 1_000_000,
  });

  assert.equal(warmup.ensureWarm("boot"), "fired", "der Boot wartet nicht auf den Index");
  assert.equal(warmup.ensureWarm("boot"), "skipped-in-flight");
  // Solange der Index nicht hängt, gibt es für Turn und Session nichts zu
  // wärmen — ein Modell, das kein Recall benutzen kann, ist ein Embed für
  // nichts. Der Boot ist die Ausnahme, und nur er.
  assert.equal(warmup.ensureWarm("turn"), "skipped-no-provider");

  // Index da: Jetzt fragen alle dieselbe Frage — und finden denselben Flug.
  indexHaengt = true;
  assert.equal(warmup.onSessionContact(), "unknown");
  assert.equal(warmup.ensureWarm("turn"), "skipped-in-flight", "auch der Turn fällt auf den laufenden Flug");
  assert.equal(calls, 1, "ein Ladevorgang, drei Auslöser");

  // Der Boot ist der einzige Aufrufer, der auf seinen Flug warten darf — für
  // seine Lifecycle-Zeile, nicht für eine Antwort an einen Nutzer.
  const flug = warmup.warming();
  assert.ok(flug, "der laufende Flug ist beobachtbar");
  freigeben!();
  assert.equal(await flug, true);
  assert.equal(warmup.warming(), null, "danach ist nichts mehr in der Luft");
  assert.equal(warmup.residencyDetail().source, "warm-up", "und der Lifecycle-Zustand weiß davon");

  // Und ohne laufenden Flug wärmt der nächste Auslöser wieder — der
  // Singleflight blockiert nicht dauerhaft.
  warmup.noteUnloaded();
  assert.equal(warmup.ensureWarm("turn"), "fired");
  assert.equal(calls, 2);
});

// ── 3. `lexical_only` — kein Arm, und ehrlich benannt ──────────

test("#494: ein lexical_only-Recall startet keinen dichten Arm und sagt es ehrlich", async (t) => {
  const profil = createLatencyProfile({ path: join(await mkdtemp(join(tmpdir(), "bastra-sf-prof-")), "p.json") });
  const p = zaehlenderProvider(profil);
  const shadow: DeadlineShadow = {
    key: () => KEY,
    residency: () => ({ state: "cold", source: "unload-observed", estimated: false }),
    observeLoad: () => {},
    hostProfileId: () => "testhost00000000",
    profile: profil,
  };
  const d = await daemonMit(t, armUeber(p.provider), shadow);
  t.after(() => p.freigeben());

  const resp = await httpPost(d.port, "/hook/recall", { query: "deployen", k: 5, lexical_only: true });
  assert.equal(p.calls(), 0, "kein Embed — nicht einer mit kurzer Frist, keiner");
  assert.equal(resp.score_kind, "bm25", "die Zahlen liegen auf der rohen Skala");
  assert.equal(resp.unfused, true, "und die Antwort sagt das");
  assert.equal(resp.degraded, undefined, "aber KEIN Ausfall: es war kein Arm vorgesehen");

  const ev = (await readEvents(d.logDir, "hook_recall"))[0];
  assert.equal(ev.lexical_only, true);
  assert.equal(ev.degraded_reason, undefined);
  assert.equal(ev.deadline_shadow, undefined, "keine Prognose ohne Arm, keine Stichprobe ohne Messung");
  assert.equal(profil.sampleCount(KEY), 0);

  // Der Gegenbeweis: derselbe Endpunkt ohne das Flag fährt den dichten Arm.
  await httpPost(d.port, "/hook/recall", { query: "deployen", k: 5, vector_deadline_ms: 50 });
  assert.equal(p.calls(), 1, "ohne den Verzicht läuft der Arm wie immer");
});

// ── 4. Unter der Mindestfrist läuft kein Arm ───────────────────

test("#494: unter der Mindestfrist prognostiziert der Schatten KEINEN Arm — und sagt warum", async (t) => {
  const profil = createLatencyProfile({ path: join(await mkdtemp(join(tmpdir(), "bastra-sf-prof-")), "p.json") });
  const shadow: DeadlineShadow = {
    key: () => KEY,
    residency: () => ({ state: "cold", source: "unload-observed", estimated: false }),
    observeLoad: () => {},
    hostProfileId: () => "testhost00000000",
    profile: profil,
  };
  const arm = {
    size: () => 1,
    runtimeHealth: () => ({ errorCount: 0 }),
    searchDetailed: async () => ({
      outcome: "hits" as const, hits: [{ id: "a", score: 0.9 }], providerLoadMs: null, coldStartObserved: false,
    }),
  } as never;
  const d = await daemonMit(t, arm, shadow);

  // Eine Lane mit 1 ms Wanduhr: Was auch immer das Profil wollte, unter 50 ms
  // Rest nimmt der Endpunkt gar keine Frist mehr an.
  await httpPost(d.port, "/hook/recall", { query: "deployen", k: 5, vector_deadline_ms: 2000, hook_budget_ms: 1 });
  const zeile = (await readEvents(d.logDir, "hook_recall"))[0].deadline_shadow as Record<string, unknown>;
  assert.equal(zeile.predicted_deadline_ms, 0, "kein Arm ist die Antwort, nicht eine kürzere Frist");
  assert.equal(zeile.cap_reason, "lane-too-short", "und der Grund steht in der Zeile");
  assert.equal(zeile.lane_budget_ms, 1);
});
