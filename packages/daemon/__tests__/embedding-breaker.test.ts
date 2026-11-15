/**
 * Tests für den Embedding-Circuit-Breaker (#165).
 *
 * Verifiziert:
 * - State-Machine-Matrix (hermetisch, injizierte nowMs): closed → open nach
 *   K konsekutiven Fehlern, Cooldown-Gating, half-open mit genau EINEM Probe,
 *   re-close bei Probe-Erfolg, re-open (frischer Cooldown) bei Probe-Fehler,
 *   Erfolg resettet den Counter, stale Probe-Claims verfallen.
 * - BreakerGuardedProvider: offener Breaker skipt den inneren Provider
 *   komplett (kein Call, kein Timeout), Probe geht nach Cooldown durch,
 *   leerer Input umgeht den Breaker in beide Richtungen.
 * - Hardening (#165 Review): reset() re-closed hart (Autostart-Fenster),
 *   der data-shaped Batch-Mismatch ("expected N embeddings, got M") zählt
 *   nie Richtung OPEN, BreakerOpenError trägt die Root-Cause des letzten
 *   Fehlers (für /health), und der embedding_degraded-Flag wird VOR dem
 *   Recall ausgewertet.
 * - Wiring ohne Netzwerk: recallHybrid über echtes Vault + SearchIndex +
 *   EmbeddingIndex degradiert bei offenem Breaker auf BM25-only und liefert
 *   weiter Hits; der Probe-Erfolg re-aktiviert das Vector-Leg.
 *
 * Runner: `tsx --test __tests__/embedding-breaker.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, SearchIndex, EmbeddingIndex, type EmbeddingProvider } from "@bastra-recall/core";
import {
  EmbeddingBreaker,
  BreakerGuardedProvider,
  BreakerOpenError,
  isBatchShapeMismatch,
  BREAKER_FAILURE_THRESHOLD,
  BREAKER_COOLDOWN_MS,
} from "../src/embedding-breaker.js";
import { recallHandler, type ToolDeps } from "../src/tool-handlers.js";
import { Telemetry } from "../src/telemetry.js";

const T0 = 1_000_000;

// ─── State-Machine-Matrix ────────────────────────────────────────

test("closed: attempts allowed, failures below K stay closed", () => {
  const b = new EmbeddingBreaker();
  assert.equal(b.shouldAttempt(T0), true);
  b.recordFailure(T0);
  b.recordFailure(T0 + 1);
  assert.equal(b.state(T0 + 2), "closed");
  assert.equal(b.shouldAttempt(T0 + 2), true);
});

test("success anywhere resets the consecutive-failure counter", () => {
  const b = new EmbeddingBreaker();
  b.recordFailure(T0);
  b.recordFailure(T0 + 1);
  b.recordSuccess();
  // Zwei weitere Fehler nach dem Reset: 2 < K=3 → bleibt closed.
  b.recordFailure(T0 + 2);
  b.recordFailure(T0 + 3);
  assert.equal(b.state(T0 + 4), "closed");
  assert.equal(b.snapshot(T0 + 4).consecutive_failures, 2);
});

test("opens after K consecutive failures — attempts denied without provider cost", () => {
  const b = new EmbeddingBreaker();
  for (let i = 0; i < BREAKER_FAILURE_THRESHOLD; i++) b.recordFailure(T0 + i);
  assert.equal(b.state(T0 + 10), "open");
  assert.equal(b.shouldAttempt(T0 + 10), false);
});

test("cooldown gates: denied one ms before, single probe allowed at cooldown", () => {
  const b = new EmbeddingBreaker();
  for (let i = 0; i < 3; i++) b.recordFailure(T0);
  assert.equal(b.shouldAttempt(T0 + BREAKER_COOLDOWN_MS - 1), false);
  assert.equal(b.shouldAttempt(T0 + BREAKER_COOLDOWN_MS), true, "probe after cooldown");
  // Probe in flight: kein zweiter Versuch.
  assert.equal(b.shouldAttempt(T0 + BREAKER_COOLDOWN_MS + 1), false, "exactly one probe");
  assert.equal(b.state(T0 + BREAKER_COOLDOWN_MS + 1), "half-open");
});

test("half-open probe success re-closes and resets the counter", () => {
  const b = new EmbeddingBreaker();
  for (let i = 0; i < 3; i++) b.recordFailure(T0);
  assert.equal(b.shouldAttempt(T0 + BREAKER_COOLDOWN_MS), true);
  b.recordSuccess();
  assert.equal(b.state(T0 + BREAKER_COOLDOWN_MS + 1), "closed");
  // Counter ist zurückgesetzt: ein einzelner Folge-Fehler öffnet nicht.
  b.recordFailure(T0 + BREAKER_COOLDOWN_MS + 2);
  assert.equal(b.state(T0 + BREAKER_COOLDOWN_MS + 3), "closed");
});

test("half-open probe failure re-opens with a fresh cooldown", () => {
  const b = new EmbeddingBreaker();
  for (let i = 0; i < 3; i++) b.recordFailure(T0);
  const tProbe = T0 + BREAKER_COOLDOWN_MS;
  assert.equal(b.shouldAttempt(tProbe), true);
  b.recordFailure(tProbe + 500);
  assert.equal(b.state(tProbe + 501), "open");
  // Frisches Fenster ab dem Probe-Fehler, nicht ab dem ersten openedAt.
  assert.equal(b.shouldAttempt(tProbe + 500 + BREAKER_COOLDOWN_MS - 1), false);
  assert.equal(b.shouldAttempt(tProbe + 500 + BREAKER_COOLDOWN_MS), true);
});

test("stale probe claim expires after a full cooldown (crashed prober)", () => {
  const b = new EmbeddingBreaker();
  for (let i = 0; i < 3; i++) b.recordFailure(T0);
  const tProbe = T0 + BREAKER_COOLDOWN_MS;
  assert.equal(b.shouldAttempt(tProbe), true);
  // Der Prober meldet sich nie zurück — nach einem weiteren Cooldown darf
  // ein neuer Probe ran, sonst bliebe der Breaker für immer zu.
  assert.equal(b.shouldAttempt(tProbe + BREAKER_COOLDOWN_MS - 1), false);
  assert.equal(b.shouldAttempt(tProbe + BREAKER_COOLDOWN_MS), true);
});

test("snapshot surfaces state, failures and remaining cooldown", () => {
  const b = new EmbeddingBreaker();
  assert.deepEqual(b.snapshot(T0), {
    state: "closed",
    consecutive_failures: 0,
    opened_at_ms: null,
    cooldown_remaining_ms: null,
  });
  for (let i = 0; i < 3; i++) b.recordFailure(T0);
  const snap = b.snapshot(T0 + 10_000);
  assert.equal(snap.state, "open");
  assert.equal(snap.consecutive_failures, 3);
  assert.equal(snap.opened_at_ms, T0);
  assert.equal(snap.cooldown_remaining_ms, BREAKER_COOLDOWN_MS - 10_000);
  assert.equal(b.snapshot(T0 + BREAKER_COOLDOWN_MS).state, "half-open");
  assert.equal(b.snapshot(T0 + BREAKER_COOLDOWN_MS).cooldown_remaining_ms, 0);
});

test("reset() re-closes an open breaker hard — autostart window (#165)", () => {
  const b = new EmbeddingBreaker();
  for (let i = 0; i < BREAKER_FAILURE_THRESHOLD; i++) {
    b.recordFailure(T0 + i, "connect ECONNREFUSED 127.0.0.1:11434");
  }
  assert.equal(b.state(T0 + 10), "open");
  // Daemon-Boot: ensureOllamaServerForDaemon meldet started / "already
  // running" → index.ts resettet. Ohne den Reset würden frühe Boot-Fehler
  // die ersten Recalls der Session 60s auf BM25 pinnen, obwohl der Server
  // Sekunden später steht.
  b.reset();
  assert.deepEqual(b.snapshot(T0 + 10), {
    state: "closed",
    consecutive_failures: 0,
    opened_at_ms: null,
    cooldown_remaining_ms: null,
  });
  assert.equal(b.shouldAttempt(T0 + 10), true);
  assert.equal(b.lastFailureMessage(), null);
});

// ─── Guarded provider (fake inner, fake clock) ───────────────────

/** Deterministischer Provider: dim 4, Fehler schaltbar, Call-Zähler. */
class FakeProvider implements EmbeddingProvider {
  readonly id = "fake-test";
  readonly dim = 4;
  calls = 0;
  failing = false;
  /** Überschreibt die Fehlermeldung (z.B. Batch-Mismatch-Shape). */
  failWith: string | null = null;
  async embed(texts: string[]): Promise<Float32Array[]> {
    // Contract der echten Provider: leerer Input → [] ohne Roundtrip.
    if (texts.length === 0) return [];
    this.calls++;
    if (this.failWith !== null) throw new Error(this.failWith);
    if (this.failing) throw new Error("fake provider down");
    return texts.map((t) => {
      // Grobe, aber stabile Text-Abbildung — genug für Cosine-Ranking.
      const v = new Float32Array(4);
      for (let i = 0; i < t.length; i++) v[i % 4] += t.charCodeAt(i) / 1000;
      return v;
    });
  }
}

test("guarded provider: opens after 3 failures, skips inner entirely, probe re-closes", async () => {
  let now = T0;
  const inner = new FakeProvider();
  const breaker = new EmbeddingBreaker();
  const guarded = new BreakerGuardedProvider(inner, breaker, () => now);
  assert.equal(guarded.id, inner.id, "id must mirror inner (persistence header)");
  assert.equal(guarded.dim, inner.dim);

  inner.failing = true;
  for (let i = 0; i < 3; i++) {
    await assert.rejects(guarded.embed(["q"]), /fake provider down/);
  }
  assert.equal(inner.calls, 3);
  // Offen: kein inner-Call mehr, sofortiger BreakerOpenError.
  await assert.rejects(guarded.embed(["q"]), BreakerOpenError);
  assert.equal(inner.calls, 3, "open breaker must not touch the provider");

  // Cooldown vorbei, Provider wieder gesund → Probe geht durch, re-closed.
  now = T0 + BREAKER_COOLDOWN_MS;
  inner.failing = false;
  const out = await guarded.embed(["q"]);
  assert.equal(out.length, 1);
  assert.equal(inner.calls, 4);
  assert.equal(breaker.state(now), "closed");
});

test("guarded provider: empty input bypasses the breaker in both directions", async () => {
  let now = T0;
  const inner = new FakeProvider();
  const breaker = new EmbeddingBreaker();
  const guarded = new BreakerGuardedProvider(inner, breaker, () => now);
  inner.failing = true;
  for (let i = 0; i < 3; i++) await assert.rejects(guarded.embed(["q"]));
  now = T0 + 1;
  // Leerer Input wirft nicht (Provider-Contract: [] ohne Roundtrip) …
  assert.deepEqual(await guarded.embed([]), []);
  // … und zählt nicht als Erfolg: der Breaker bleibt offen.
  assert.equal(breaker.state(now), "open");
});

test("isBatchShapeMismatch matches exactly the core mismatch shape", () => {
  assert.equal(isBatchShapeMismatch(new Error("Ollama embed: expected 4 embeddings, got 2")), true);
  assert.equal(isBatchShapeMismatch(new Error("Ollama embed: expected 1 embeddings, got none")), true);
  assert.equal(isBatchShapeMismatch("expected 50 embeddings, got 49"), true);
  // Availability-Fehler zählen weiter Richtung OPEN.
  assert.equal(
    isBatchShapeMismatch(new Error("Ollama embed HTTP 500 (http://127.0.0.1:11434/api/embed): boom")),
    false
  );
  assert.equal(isBatchShapeMismatch(new Error("fetch failed")), false);
  assert.equal(isBatchShapeMismatch(new Error("connect ECONNREFUSED 127.0.0.1:11434")), false);
});

test("guarded provider: poisoned-batch mismatch is data-shaped — never trips the breaker", async () => {
  const now = T0;
  const inner = new FakeProvider();
  const breaker = new EmbeddingBreaker();
  const guarded = new BreakerGuardedProvider(inner, breaker, () => now);

  // Deterministischer Pro-Batch-Fehler (z.B. ein vergiftetes Dokument im
  // Backfill): egal wie oft er auftritt, der Breaker bleibt closed — der
  // Provider ist verfügbar, nur die Daten sind kaputt. Der Fehler selbst
  // propagiert unverändert (Requeue-Verhalten des EmbeddingIndex bleibt).
  inner.failWith = "Ollama embed: expected 2 embeddings, got 1";
  for (let i = 0; i < BREAKER_FAILURE_THRESHOLD + 2; i++) {
    await assert.rejects(guarded.embed(["a", "b"]), /expected 2 embeddings, got 1/);
  }
  assert.equal(breaker.state(now), "closed");
  assert.equal(breaker.snapshot(now).consecutive_failures, 0);

  // Echte Availability-Fehler zählen weiterhin — auch mit Mismatch dazwischen.
  inner.failWith = "fake provider down";
  await assert.rejects(guarded.embed(["q"]));
  inner.failWith = "Ollama embed: expected 1 embeddings, got none";
  await assert.rejects(guarded.embed(["q"]));
  inner.failWith = "fake provider down";
  await assert.rejects(guarded.embed(["q"]));
  await assert.rejects(guarded.embed(["q"]));
  assert.equal(breaker.state(now), "open");
});

test("BreakerOpenError carries the last root cause — /health keeps showing WHY", async () => {
  let now = T0;
  const inner = new FakeProvider();
  const breaker = new EmbeddingBreaker();
  const guarded = new BreakerGuardedProvider(inner, breaker, () => now);
  inner.failing = true;
  for (let i = 0; i < 3; i++) await assert.rejects(guarded.embed(["q"]), /fake provider down/);
  assert.equal(breaker.lastFailureMessage(), "fake provider down");

  // EmbeddingIndex speichert err.message als runtime lastError (/health →
  // embedding_error) — die Root-Cause muss im BreakerOpenError mitreisen,
  // sonst überschreibt der generische Circuit-Text das actionable WARUM.
  await assert.rejects(guarded.embed(["q"]), (err: unknown) => {
    assert.ok(err instanceof BreakerOpenError);
    assert.match((err as Error).message, /embedding breaker open/);
    assert.match((err as Error).message, /last error: fake provider down/);
    return true;
  });

  // Nach Erholung (Probe-Erfolg) ist die Root-Cause gecleart.
  now = T0 + BREAKER_COOLDOWN_MS;
  inner.failing = false;
  await guarded.embed(["q"]);
  assert.equal(breaker.lastFailureMessage(), null);
});

// ─── Wiring: recallHybrid degradiert bei offenem Breaker (kein Netzwerk) ──

function memoryFile(id: string, title: string): string {
  const ts = new Date().toISOString();
  return [
    "---",
    `id: ${id}`,
    `title: ${title}`,
    "type: lesson",
    `summary: ${title} summary text`,
    "topic_path:",
    "  - test",
    "tags:",
    "  - test",
    "scope: breaker-test",
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

async function waitFor(cond: () => boolean, timeoutMs = 3_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("hybrid recall serves BM25-only while open, probe re-enables the vector leg", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-breaker-test-"));
  const vault = new Vault(dir);
  const search = new SearchIndex(vault);
  let embIdx: EmbeddingIndex | null = null;
  try {
    await writeFile(join(dir, "alpha.md"), memoryFile("alpha", "alpha bravo"), "utf8");
    await writeFile(join(dir, "charlie.md"), memoryFile("charlie", "charlie delta"), "utf8");
    await vault.init();
    search.start();

    let now = T0;
    const inner = new FakeProvider();
    const breaker = new EmbeddingBreaker();
    const guarded = new BreakerGuardedProvider(inner, breaker, () => now);
    embIdx = new EmbeddingIndex(vault, guarded, join(dir, ".bastra", "embeddings.json"));
    await embIdx.start();
    // Backfill läuft fire-and-forget — auf die Vektoren warten, damit der
    // Query-Pfad überhaupt einen Provider-Call macht (leerer Index skipt ihn).
    await waitFor(() => embIdx!.size() === 2);
    search.useEmbeddings(embIdx);

    // 3 konsekutive Query-Fehler öffnen den Breaker. Distinkte Queries
    // umgehen den SearchIndex-Query-Cache.
    inner.failing = true;
    const callsBefore = inner.calls;
    for (let i = 1; i <= 3; i++) {
      const hits = await search.recallHybrid(`alpha probefail${i}`, { k: 3 });
      assert.ok(
        hits.some((h) => h.id === "alpha"),
        "BM25 leg must still deliver"
      );
    }
    assert.equal(inner.calls, callsBefore + 3);
    assert.equal(breaker.state(now), "open");

    // Offen: Recall degradiert silent auf BM25-only OHNE Embed-Versuch.
    const degraded = await search.recallHybrid("alpha degraded", { k: 3 });
    assert.ok(degraded.some((h) => h.id === "alpha"));
    assert.equal(inner.calls, callsBefore + 3, "no provider call while open");
    // So verdrahtet index.ts den Telemetrie-Flag-Getter (embedding_degraded).
    assert.equal(search.hasEmbeddings() && breaker.state(now) === "open", true);
    // /health-Pfad: der BreakerOpenError landet als runtime lastError — und
    // trägt die Root-Cause statt sie mit dem Circuit-Text zu überschreiben.
    assert.match(embIdx.runtimeHealth().lastError ?? "", /last error: fake provider down/);

    // Cooldown vorbei + Provider gesund → genau ein Probe-Call, re-closed.
    now = T0 + BREAKER_COOLDOWN_MS;
    inner.failing = false;
    const recovered = await search.recallHybrid("alpha recovered", { k: 3 });
    assert.ok(recovered.some((h) => h.id === "alpha"));
    assert.equal(inner.calls, callsBefore + 4, "probe reached the provider");
    assert.equal(breaker.state(now), "closed");
  } finally {
    await embIdx?.stop();
    search.stop();
    await vault.stop?.();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

// ─── embedding_degraded wird VOR dem Recall ausgewertet (#165 Race) ──

test("recall telemetry: embedding_degraded describes the served recall, not the post-recall breaker state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-breaker-order-"));
  const vault = new Vault(dir);
  const search = new SearchIndex(vault);
  try {
    await writeFile(join(dir, "alpha.md"), memoryFile("alpha", "alpha bravo"), "utf8");
    await vault.init();
    search.start();

    // Der Breaker öffnet erst WÄHREND des Recalls (z.B. paralleler Backfill-
    // Batch-Fehler). Der servierte Recall lief noch gesund hybrid — würde der
    // Flag nach dem Recall ausgewertet, wäre er fälschlich degraded.
    let breakerOpen = false;
    const searchStub = {
      hasEmbeddings: () => true,
      recallHybrid: async (q: string, opts: unknown) => {
        const hits = search.recall(q, opts as never);
        breakerOpen = true;
        return hits;
      },
    } as unknown as SearchIndex;

    const telemetry = new Telemetry();
    let logged: { embedding_degraded?: boolean } | null = null;
    (telemetry as unknown as { logRecall: (p: unknown) => Promise<void> }).logRecall = async (p) => {
      logged = p as { embedding_degraded?: boolean };
    };

    const deps = {
      vault,
      search: searchStub,
      telemetry,
      vaultPath: dir,
      embeddingDegraded: () => breakerOpen,
    } as ToolDeps;

    await recallHandler(deps, { query: "alpha bravo" });
    assert.ok(logged, "logRecall must have been called");
    assert.equal(
      (logged as { embedding_degraded?: boolean }).embedding_degraded,
      undefined,
      "flag must be captured BEFORE the recall runs"
    );
  } finally {
    search.stop();
    await vault.stop?.();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
