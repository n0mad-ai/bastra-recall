/**
 * Der gemeinsame Warmup (#490) — Koordinator und Sitzungsstart-Lane.
 *
 * Drei Zusagen, jede einzeln still zu brechen:
 *
 *  1. EIN Warmup, egal wie viele Sitzungen gleichzeitig starten. Ohne das
 *     bekommt eine kalte Maschine einen Embed-Sturm genau dann, wenn sie am
 *     langsamsten ist.
 *  2. Ein SessionStart auf kaltem Modell antwortet SOFORT lexikalisch — seit
 *     #494 OHNE dichten Arm (`lexical_only`) statt mit einer 50-ms-Frist —,
 *     sagt das im Block ehrlich („not in memory", nicht „semantic search is
 *     off") und lässt den Ladevorgang daneben laufen.
 *  3. Ein gehosteter Provider feuert gar nichts.
 *
 * Hermetisch: injizierte Uhr, kein Provider, kein Schlaf (Muster aus
 * embedding-prewarm.test.ts). Die Lane läuft gegen einen Fake-Daemon, der die
 * Request-Bodies mitschreibt.
 *
 * Runner: node --import tsx --test packages/daemon/__tests__/embedding-warmup.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmbeddingWarmup, RESIDENT_WINDOW_MS } from "../src/embedding-warmup.js";
import { runSessionLane } from "../src/session-lane.js";

// ── Der Koordinator, ohne alles ────────────────────────────────

/** Ein Warmup, dessen Embed hängt, bis der Test ihn auflöst. */
function pendingWarm(): { warm: () => Promise<void>; calls: () => number; finish: () => void } {
  let calls = 0;
  let resolve: (() => void) | null = null;
  return {
    warm: () => {
      calls++;
      return new Promise<void>((r) => {
        resolve = r;
      });
    },
    calls: () => calls,
    finish: () => resolve?.(),
  };
}

test("#490: fünf gleichzeitig startende Sitzungen teilen sich EINEN Warmup", async () => {
  const w = pendingWarm();
  let lastOk: number | null = null;
  const warmup = createEmbeddingWarmup({
    denseArmAvailable: () => true,
    lastOkAt: () => lastOk,
    warm: w.warm,
    now: () => 1_000_000,
  });

  const outcomes = [1, 2, 3, 4, 5].map(() => warmup.onSessionContact());
  assert.deepEqual(outcomes, ["unknown", "unknown", "unknown", "unknown", "unknown"]);
  assert.equal(w.calls(), 1, "der zweite bis fünfte Kontakt fällt auf den laufenden Warmup");

  // Der Embed kommt zurück, der Provider stempelt lastOkAt — ab jetzt ist das
  // Modell resident und niemand wärmt mehr.
  w.finish();
  await Promise.resolve();
  await Promise.resolve();
  lastOk = 1_000_000;
  assert.equal(warmup.residency(), "warm");
  assert.equal(warmup.ensureWarm(), "skipped-warm");
  assert.equal(w.calls(), 1);
});

test("#490: Residenz kommt aus lastOkAt — unbekannt, warm, kalt", () => {
  let lastOk: number | null = null;
  let clock = 5_000_000;
  const warmup = createEmbeddingWarmup({
    denseArmAvailable: () => true,
    lastOkAt: () => lastOk,
    warm: async () => {},
    now: () => clock,
  });

  assert.equal(warmup.residency(), "unknown", "noch kein erfolgreicher Embed in diesem Prozess");
  lastOk = clock;
  assert.equal(warmup.residency(), "warm");
  clock += RESIDENT_WINDOW_MS - 1;
  assert.equal(warmup.residency(), "warm", "innerhalb des Fensters bleibt das Modell im Speicher");
  clock += 2;
  assert.equal(warmup.residency(), "cold", "danach hat keep_alive/Idle-Unload es geräumt");
});

test("#490: ein gehosteter Provider feuert nichts und heißt auch nicht kalt", () => {
  let calls = 0;
  const warmup = createEmbeddingWarmup({
    denseArmAvailable: () => true,
    hostedProvider: () => true,
    // Läge auf einer Ollama-Maschine längst außerhalb des Fensters.
    lastOkAt: () => 0,
    warm: async () => {
      calls++;
    },
    now: () => 9_000_000,
  });

  assert.equal(warmup.residency(), "hosted");
  assert.equal(warmup.onSessionContact(), "hosted");
  assert.equal(warmup.ensureWarm(), "skipped-hosted");
  assert.equal(calls, 0, "hinter einem gehosteten API gibt es kein kaltes Modell unseres Betriebs");
});

test("#490: ohne dichten Arm (Breaker offen, Embeddings aus) wird nicht gewärmt", () => {
  let calls = 0;
  const warmup = createEmbeddingWarmup({
    denseArmAvailable: () => false,
    lastOkAt: () => null,
    warm: async () => {
      calls++;
    },
    now: () => 1,
  });
  assert.equal(warmup.ensureWarm(), "skipped-no-provider");
  assert.equal(calls, 0);
});

test("#490: ein synchron werfender Warmup lässt den Koordinator nicht als in-flight zurück", () => {
  let calls = 0;
  const errors: unknown[] = [];
  const warmup = createEmbeddingWarmup({
    denseArmAvailable: () => true,
    lastOkAt: () => null,
    warm: () => {
      calls++;
      throw new Error("provider url kaputt");
    },
    now: () => 1,
    onError: (e) => errors.push(e),
  });
  assert.equal(warmup.ensureWarm(), "fired");
  assert.equal(warmup.ensureWarm(), "fired", "sonst wäre der Warmup für immer blockiert");
  assert.equal(calls, 2);
  assert.equal(errors.length, 2);
});

// ── Die Lane ───────────────────────────────────────────────────

async function readEvents(logDir: string): Promise<Record<string, unknown>[]> {
  const files = (await readdir(logDir)).filter((n) => n.startsWith("events-") && n.endsWith(".jsonl"));
  const out: Record<string, unknown>[] = [];
  for (const f of files) {
    for (const l of (await readFile(join(logDir, f), "utf8")).split("\n")) {
      if (l.trim()) out.push(JSON.parse(l) as Record<string, unknown>);
    }
  }
  return out;
}

/** Genau die Form, die `/hook/recall` bei gerissener Deadline sendet. */
const unfusedHit = {
  hits: [
    {
      id: "m1",
      title: "Session fact",
      type: "reference",
      scope: "user-preference",
      summary: "Ein Fakt.",
      score: 405585,
    },
  ],
  vault_size: 1,
  latency_ms: 1,
  recall_id: "r1",
  score_kind: "bm25",
  unfused: true,
  degraded: "vector-arm-timeout",
};

async function withDaemon(
  resp: Record<string, unknown>,
  fn: (base: string, bodies: Array<Record<string, unknown>>) => Promise<void>,
): Promise<void> {
  const seenBodies: Array<Record<string, unknown>> = [];
  const sessionContext = JSON.stringify({
    budget: {},
    aborted: [],
    data: {
      recalls: [{ scope: "user-preference", resp }],
      floors: [],
      conventions: [],
      care: { open: 0, queued: 0 },
      imports: { open: 0, queued: 0 },
      onboarding: false,
    },
  });
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (path === "/hook/session-context" && chunks.length > 0) {
        try {
          seenBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
        } catch {
          /* ein unlesbarer Body ist der Testfehler unten, nicht hier */
        }
      }
      const body =
        path === "/hook/session-context"
          ? sessionContext
          : path === "/health"
            ? JSON.stringify({ ok: true })
            : "{}";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    await fn(`http://127.0.0.1:${port}`, seenBodies);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test("#490: ein kalter SessionStart antwortet lexikalisch im Budget, benennt es ehrlich und lädt daneben", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "bastra-warmup-cold-"));
  const w = pendingWarm();
  const warmup = createEmbeddingWarmup({
    denseArmAvailable: () => true,
    // Letzter Embed liegt weit außerhalb des Residenzfensters: kalt.
    lastOkAt: () => 1_000_000,
    warm: w.warm,
    now: () => 1_000_000 + RESIDENT_WINDOW_MS + 1,
  });
  const before = process.env.BASTRA_LOG_PATH;
  const beforeTel = process.env.BASTRA_TELEMETRY;
  process.env.BASTRA_LOG_PATH = logDir;
  process.env.BASTRA_TELEMETRY = "on";
  try {
    await withDaemon(unfusedHit, async (base, bodies) => {
      const t0 = Date.now();
      const out = await runSessionLane(
        { hook_event_name: "SessionStart", source: "startup", cwd: "/tmp", session_id: "sess-cold" },
        base,
        warmup,
      );
      const elapsed = Date.now() - t0;

      // #494: UMGEDREHT gegenüber #490. Dort stand hier eine 50-ms-Frist —
      // ein Embed, der sicher aufgegeben wird, dreimal parallel, neben dem
      // Warmup, der dasselbe Modell ohnehin lädt. Jetzt läuft gar kein
      // dichter Arm.
      assert.equal(bodies[0].lexical_only, true, "auf kaltem Modell läuft kein dichter Arm");
      assert.equal(bodies[0].vector_deadline_ms, undefined, "wo kein Arm läuft, gibt es keine Frist");
      assert.equal(bodies[0].hook_budget_ms, 500, "das Schattenbudget bleibt die Wanduhr dieser Lane");
      assert.ok(elapsed < 500, `die Lane bleibt in ihrer Wanduhr (${elapsed} ms)`);
      assert.equal(w.calls(), 1, "der Ladevorgang läuft NEBEN dem Recall an");

      const ctx = (JSON.parse(out) as { hookSpecificOutput?: { additionalContext?: string } })
        .hookSpecificOutput?.additionalContext ?? "";
      assert.match(ctx, /not in memory/i, "der Block sagt, warum nur ein Arm lief");
      assert.match(ctx, /next recall in this session is fused/i);
      assert.doesNotMatch(ctx, /semantic search is off/i, "das wäre hier schlicht unwahr");
    });
    const ev = (await readEvents(logDir)).find((e) => e.kind === "session_hook_call");
    assert.ok(ev);
    assert.equal(ev.embedding_residency, "cold");
    assert.equal(ev.score_unfused, true);
  } finally {
    w.finish();
    if (before === undefined) delete process.env.BASTRA_LOG_PATH;
    else process.env.BASTRA_LOG_PATH = before;
    if (beforeTel === undefined) delete process.env.BASTRA_TELEMETRY;
    else process.env.BASTRA_TELEMETRY = beforeTel;
    await rm(logDir, { recursive: true, force: true });
  }
});

test("#490: ein warmes Modell behält die 350 ms und löst keinen Warmup aus", async () => {
  let calls = 0;
  const now = 2_000_000;
  const warmup = createEmbeddingWarmup({
    denseArmAvailable: () => true,
    lastOkAt: () => now - 1_000,
    warm: async () => {
      calls++;
    },
    now: () => now,
  });
  const beforeTel = process.env.BASTRA_TELEMETRY;
  process.env.BASTRA_TELEMETRY = "off";
  try {
    await withDaemon({ ...unfusedHit, score_kind: "rrf", unfused: false, degraded: undefined, hits: [{ ...unfusedHit.hits[0], score: 150 }] }, async (base, bodies) => {
      await runSessionLane(
        { hook_event_name: "SessionStart", source: "startup", cwd: "/tmp", session_id: "sess-warm" },
        base,
        warmup,
      );
      assert.equal(bodies[0].vector_deadline_ms, 350);
      assert.equal(calls, 0, "ein residentes Modell braucht keinen Embed, der es beweist");
    });
  } finally {
    if (beforeTel === undefined) delete process.env.BASTRA_TELEMETRY;
    else process.env.BASTRA_TELEMETRY = beforeTel;
  }
});

test("#490: ohne Koordinator bleibt die Lane, wie sie war — 350 ms", async () => {
  const beforeTel = process.env.BASTRA_TELEMETRY;
  process.env.BASTRA_TELEMETRY = "off";
  try {
    await withDaemon(unfusedHit, async (base, bodies) => {
      await runSessionLane(
        { hook_event_name: "SessionStart", source: "startup", cwd: "/tmp", session_id: "sess-no-coord" },
        base,
      );
      assert.equal(bodies[0].vector_deadline_ms, 350);
    });
  } finally {
    if (beforeTel === undefined) delete process.env.BASTRA_TELEMETRY;
    else process.env.BASTRA_TELEMETRY = beforeTel;
  }
});

test("#490: zwei gleichzeitige SessionStarts auf kaltem Modell starten EINEN Warmup", async () => {
  const w = pendingWarm();
  const warmup = createEmbeddingWarmup({
    denseArmAvailable: () => true,
    lastOkAt: () => null,
    warm: w.warm,
    now: () => 3_000_000,
  });
  const beforeTel = process.env.BASTRA_TELEMETRY;
  process.env.BASTRA_TELEMETRY = "off";
  try {
    await withDaemon(unfusedHit, async (base, bodies) => {
      await Promise.all([
        runSessionLane({ hook_event_name: "SessionStart", source: "startup", cwd: "/tmp", session_id: "a" }, base, warmup),
        runSessionLane({ hook_event_name: "SessionStart", source: "startup", cwd: "/tmp", session_id: "b" }, base, warmup),
      ]);
      assert.equal(bodies.length, 2, "beide Sitzungen haben ihren eigenen Recall");
      assert.equal(w.calls(), 1, "aber nur einen gemeinsamen Ladevorgang");
    });
  } finally {
    w.finish();
    if (beforeTel === undefined) delete process.env.BASTRA_TELEMETRY;
    else process.env.BASTRA_TELEMETRY = beforeTel;
  }
});
