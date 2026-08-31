/**
 * Embedding-Index für semantische Recall-Suche. Parallel zur BM25-Suche
 * (search.ts) — kombiniert via Reciprocal-Rank-Fusion zu Hybrid-Recall.
 *
 * Provider: aktuell OpenAI text-embedding-3-small (1536 Dim, ~$0.02/1M tok).
 * Vector-Storage: Map<id, Float32Array> in memory + JSON-Persistenz auf Disk
 * (base64-encoded bytes, vault-relativer Pfad `<vault>/.bastra/embeddings.json`).
 *
 * Lifecycle:
 * - start(): load() persisted vectors, subscribe to vault events, queue
 *   backfill für alle Memories ohne Vector
 * - vault.add/change → queue Embed → batch flush → persist
 * - vault.remove → vector remove → persist
 *
 * Bei Fehler (kein API-Key, Network, Provider-Outage) bleibt der Index
 * leer/incomplete; Hybrid-Recall fällt elegant auf reine BM25 zurück.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { Memory } from "./schema.js";
import type { Vault, VaultEvent } from "./vault.js";
import { EmbedCache, hashEmbedContent } from "./embed-cache.js";
import { assertLocalOrOptIn } from "./ollama-egress.js";
import { RRF_K, RRF_SCALE } from "./rrf.js";

// ─── Tunables (env-overridable für load-tests / large-vault-bursts) ──

/** Max gleichzeitige Embed-Batches in flight. Default 2.
 *  Provider-Calls (OpenAI/Ollama) sind teils sehr fett — wir wollen
 *  Burst-Schutz, aber nicht so streng dass Backfill ewig dauert. */
const MAX_CONCURRENT_BATCHES = Math.max(
  1,
  Number(process.env.BASTRA_EMBED_MAX_CONCURRENT ?? "2"),
);

/** Queue-Länge ab der `enqueue()` ein kurzes Sleep einbaut, damit Aufrufer
 *  (z.B. bulk-Import von 1000 Memories) blockieren bis die Queue abebbt.
 *  Zur Laufzeit gelesen (nicht als Modul-Konstante), damit Tests die env
 *  deterministisch setzen können — ohne fragilen Modul-Reimport. */
function backpressureLimit(): number {
  return Math.max(1, Number(process.env.BASTRA_EMBED_BACKPRESSURE_LIMIT ?? "200"));
}

/** Stall-Dauer pro `enqueue()`-Call wenn queue über Limit. */
function backpressureStallMs(): number {
  return Math.max(0, Number(process.env.BASTRA_EMBED_BACKPRESSURE_STALL_MS ?? "100"));
}

// ─── Provider Interface ──────────────────────────────────────────

export interface EmbeddingProvider {
  /** Stable ID für Persistenz-Header — bei Provider-Wechsel wird der
   *  Index invalidiert, weil Cosine zwischen Modellen sinnlos ist. */
  readonly id: string;
  readonly dim: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

// ─── OpenAI Provider ─────────────────────────────────────────────

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly dim: number;
  private apiKey: string;
  private model: string;

  constructor(opts: {
    apiKey: string;
    model?: string;
    dim?: number;
  }) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? "text-embedding-3-small";
    this.dim = opts.dim ?? 1536;
    this.id = `openai-${this.model}`;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const resp = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
        encoding_format: "float",
      }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "<binary>");
      throw new Error(`OpenAI embed HTTP ${resp.status}: ${body.slice(0, 200)}`);
    }
    const json = (await resp.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
    };
    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    return sorted.map((d) => new Float32Array(d.embedding));
  }
}

// ─── Ollama Provider ─────────────────────────────────────────────

/**
 * Lokales Embedding-Provider via Ollama (https://ollama.com).
 *
 * Vorteile ggü. OpenAI:
 * - Keine Token-Kosten / kein Quota
 * - Daten bleiben on-device (privatsphäre, GDPR)
 * - Kein Network-Roundtrip → schneller bei vielen kleinen Batches
 *
 * Setup:
 *   brew install ollama
 *   ollama pull embeddinggemma   # ~200 MB, multilingual, 768 dim
 *
 * Spricht das NATIVE `/api/embed`-Endpoint (nicht den OpenAI-compat-Layer
 * `/v1/embeddings`): nur das native API versteht `keep_alive`, womit der
 * Daemon das Lade-Fenster des Modells pro Request steuert — Kern des
 * Energie-Designs (#78): Modell bleibt während aktiver Arbeit warm, wird
 * bei Idle entladen statt dauerhaft RAM zu belegen (Laptop-Akku).
 * Cosine ist skalierungsinvariant, daher bleiben persistierte Vektoren
 * aus dem alten /v1-Pfad kompatibel (gleiches Modell, gleiche dim).
 *
 * Default-Modell: `embeddinggemma` (Google, 308M Params, multilingual,
 * MTEB-Best <500M). Daniels deutscher Vault profitiert vom multilingual-
 * Training. Alternativen: `nomic-embed-text` (288M, EN-fokussiert),
 * `bge-m3` (~2.3GB, 100+ Sprachen, schwerer aber robuster).
 */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly dim: number;
  private baseURL: string;
  private model: string;
  private keepAlive?: string | number;

  constructor(opts: {
    baseURL?: string;
    model?: string;
    dim?: number;
    /** Ollama keep_alive pro Embed-Request, z.B. "10m" oder Sekunden.
     *  undefined = Feld weglassen → Server-Default (OLLAMA_KEEP_ALIVE, 5m). */
    keepAlive?: string | number;
  }) {
    this.baseURL = opts.baseURL ?? "http://localhost:11434";
    // Embedding text (query + memory) is POSTed to this endpoint. Enforce the
    // same "no egress" contract the reranker does (#124/#125): loopback by
    // default, remote only with BASTRA_ALLOW_REMOTE_OLLAMA=1. Fail fast at
    // construction rather than silently shipping text off-box on first embed.
    assertLocalOrOptIn(this.baseURL);
    this.model = opts.model ?? "embeddinggemma";
    // EmbeddingGemma default 768, andere Modelle abweichend — via opts
    // override-bar. Bei Mismatch wird der Index automatisch invalidiert
    // (siehe load(): dim/provider-Check).
    this.dim = opts.dim ?? 768;
    this.id = `ollama-${this.model}`;
    this.keepAlive = opts.keepAlive;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const url = this.baseURL.replace(/\/+$/, "") + "/api/embed";
    const body: Record<string, unknown> = { model: this.model, input: texts };
    if (this.keepAlive !== undefined) body.keep_alive = this.keepAlive;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const respBody = await resp.text().catch(() => "<binary>");
      throw new Error(
        `Ollama embed HTTP ${resp.status} (${url}): ${respBody.slice(0, 200)}`,
      );
    }
    const json = (await resp.json()) as { embeddings: number[][] };
    if (!Array.isArray(json.embeddings) || json.embeddings.length !== texts.length) {
      throw new Error(
        `Ollama embed: expected ${texts.length} embeddings, got ${Array.isArray(json.embeddings) ? json.embeddings.length : "none"}`,
      );
    }
    return json.embeddings.map((e) => new Float32Array(e));
  }
}

// ─── Embedding Hit ───────────────────────────────────────────────

export interface EmbeddingHit {
  id: string;
  /** Cosine similarity, [-1, 1]. Higher = more relevant. */
  score: number;
}

/** Runtime-Gesundheit des Provider-Pfads (#92). `ok=false` heißt: der letzte
 *  Provider-Call ist fehlgeschlagen und seitdem kam kein Erfolg — Recall läuft
 *  gerade silent auf BM25-only, obwohl semantic recall konfiguriert ist. */
export interface EmbeddingRuntimeHealth {
  ok: boolean;
  lastError: string | null;
  lastErrorAt: number | null;
  lastOkAt: number | null;
  /** #365/4: monoton steigende Zahl der Provider-Fehler seit Prozessstart.
   *  `lastErrorAt` hat ms-Auflösung und taugt deshalb NICHT als Diskriminator
   *  „ist genau dieser Call gescheitert?" — zwei Fehler in derselben
   *  Millisekunde sind darüber nicht unterscheidbar, und der zweite Leser
   *  sieht seinen eigenen Fehler als „schon vorher da". Der Zähler ist die
   *  Kante, der Timestamp bleibt die Anzeige. */
  errorCount: number;
}

// ─── Embedding Index ─────────────────────────────────────────────

/** Subscriber für „dieser Memory hat gerade ein frisches Vector bekommen" —
 *  Auto-Related-Enricher nutzt das, um nach jedem Embed-Batch die Similar-
 *  Suche zu triggern und `related_via` zu pflegen. */
export type EmbedListener = (id: string) => void;

export class EmbeddingIndex {
  private vectors = new Map<string, Float32Array>();
  private detach?: () => void;
  private pendingQueue: Set<string> = new Set();
  private processing = false;
  private persistTimer: NodeJS.Timeout | null = null;
  private embedListeners = new Set<EmbedListener>();
  /** Anzahl gerade laufender Provider-Calls (Semaphore-Counter). */
  private inFlight = 0;
  /** Content-Hash-Cache — skipt Re-Embed bei unverändertem Content. */
  private cache: EmbedCache;
  /** Runtime-Health des Providers (#92): letzter Fehler / letzter Erfolg. */
  private lastError: string | null = null;
  private lastErrorAt: number | null = null;
  private lastOkAt: number | null = null;
  /** #365/4: monotoner Fehlerzähler — siehe EmbeddingRuntimeHealth.errorCount. */
  private errorCount = 0;
  /** Provider-Calls seit Prozessstart (query + batch) — Energie-Telemetrie (#109). */
  private providerCalls = 0;
  /** Wie oft `enqueue()` wegen voller Queue gestallt hat (#331). Der Stall ist
   *  sonst nur an der Wanduhr sichtbar, und eine Wanduhr-Untergrenze hält nur
   *  solange der Stall das Langsamste im Burst ist — unter Suite-Last nicht. */
  private stalls = 0;

  constructor(
    private readonly vault: Vault,
    private readonly provider: EmbeddingProvider,
    private readonly persistPath: string,
    cachePath?: string,
  ) {
    // Cache liegt neben persistPath: `<vault>/.bastra/embed-cache.json`
    const resolvedCachePath =
      cachePath ?? path.join(path.dirname(persistPath), "embed-cache.json");
    this.cache = new EmbedCache(
      resolvedCachePath,
      provider.id,
      provider.dim,
    );
  }

  /** Lädt persistierte Vectors, subscribed an vault.on, backfillt fehlende. */
  async start(): Promise<void> {
    await this.load();
    await this.cache.load();
    // #240/A8: prune vectors whose memory no longer exists. Only the LIVE
    // remove-event drops a vector, so everything deleted while the daemon was
    // down stayed in the index forever. Orphans are ranked before the
    // vault filter runs, so they push eligible memories out of the vector
    // top-k, and findSimilarById hands them to the related-enricher as
    // neighbours — which is how dangling related_via edges get written.
    const orphans = [...this.vectors.keys()].filter((id) => !this.vault.get(id));
    for (const id of orphans) this.vectors.delete(id);
    if (orphans.length > 0) {
      console.error(
        `[bastra.embeddings] pruned ${orphans.length} orphan vector(s) with no memory in the vault`,
      );
      this.schedulePersist();
    }
    this.detach = this.vault.on((e) => this.handle(e));
    for (const m of this.vault.list()) {
      if (!this.vectors.has(m.fm.id)) this.pendingQueue.add(m.fm.id);
    }
    if (this.pendingQueue.size > 0) {
      console.error(
        `[bastra.embeddings] backfilling ${this.pendingQueue.size} memories…`,
      );
      void this.flushQueue();
    }
  }

  /**
   * #240/B3: stop DRAINS the pending persist instead of discarding it.
   * `schedulePersist()` resets a 1 s timer on every embed event, so under a
   * continuous backfill the write is starved indefinitely — a SIGTERM in that
   * window used to throw away the vectors of the entire backfill, not just
   * the last second. Awaiting is optional for callers that only want the
   * listener detached.
   */
  async stop(): Promise<void> {
    this.detach?.();
    this.detach = undefined;
    const hadPending = this.persistTimer !== null;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (hadPending) {
      try {
        await this.persist();
      } catch (err) {
        console.error(`[bastra.embeddings] final persist failed: ${(err as Error).message}`);
      }
    }
  }

  /** Subscribe für post-embed events. Liefert eine `unsubscribe`-Funktion. */
  onEmbed(listener: EmbedListener): () => void {
    this.embedListeners.add(listener);
    return () => this.embedListeners.delete(listener);
  }

  /** Liefert Top-k Nachbarn eines bereits embedded Memory. Nutzt das vorhandene
   *  Vector — KEIN Provider-Call (kein Embedding-Kosten, kein Network). Wenn
   *  das Memory noch keinen Vector hat: `null`. Self wird automatisch
   *  herausgefiltert. */
  findSimilarById(id: string, k: number = 5): EmbeddingHit[] | null {
    const seed = this.vectors.get(id);
    if (!seed) return null;
    const hits: EmbeddingHit[] = [];
    for (const [otherId, v] of this.vectors) {
      if (otherId === id) continue;
      hits.push({ id: otherId, score: cosine(seed, v) });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, k);
  }

  /** Liefert Top-k via Cosine-Similarity. Brute-force über alle Vectors —
   *  für Single-User-Vaults (≤10k Memories) schnell genug (<10ms). */
  async search(query: string, k: number = 10): Promise<EmbeddingHit[]> {
    if (!query.trim() || this.vectors.size === 0) return [];
    let q: Float32Array;
    try {
      const result = await this.provider.embed([query]);
      this.markProviderOk();
      if (result.length === 0) return [];
      q = result[0];
    } catch (err) {
      this.markProviderError(err);
      console.error("[bastra.embeddings] query embed error:", err);
      return [];
    }
    const hits: EmbeddingHit[] = [];
    for (const [id, v] of this.vectors) {
      hits.push({ id, score: cosine(q, v) });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, k);
  }

  size(): number {
    return this.vectors.size;
  }

  /** Read-only view of all stored vectors (id → vector), for consumers that
   *  do pure math over the whole set (#207 semantic map). Live map — do not
   *  mutate, and don't hold it across awaits (the index keeps writing). */
  snapshot(): ReadonlyMap<string, Float32Array> {
    return this.vectors;
  }

  /** Anzahl Memories die noch auf Embedding warten (Backfill-Queue). */
  pendingSize(): number {
    return this.pendingQueue.size;
  }

  // ─── persistence ─────────────────────────────────────────────

  private async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.persistPath, "utf-8");
      const data = JSON.parse(raw) as {
        dim: number;
        provider: string;
        vectors: Record<string, string>;
      };
      if (data.dim !== this.provider.dim || data.provider !== this.provider.id) {
        console.error(
          `[bastra.embeddings] provider/dim changed (was ${data.provider}/${data.dim}, now ${this.provider.id}/${this.provider.dim}) — reindexing all`,
        );
        return;
      }
      for (const [id, b64] of Object.entries(data.vectors)) {
        const buf = Buffer.from(b64, "base64");
        const f32 = new Float32Array(
          buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
        );
        this.vectors.set(id, f32);
      }
      console.error(`[bastra.embeddings] loaded ${this.vectors.size} vectors`);
    } catch (err) {
      // file existiert nicht oder defekt — start fresh
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        console.error("[bastra.embeddings] load error:", err);
      }
    }
  }

  /** Debounced persist — viele Add-Events in Folge schreiben nur einmal raus. */
  private schedulePersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persist();
    }, 1000);
  }

  private async persist(): Promise<void> {
    const vectors: Record<string, string> = {};
    for (const [id, v] of this.vectors) {
      const buf = Buffer.from(v.buffer, v.byteOffset, v.byteLength);
      vectors[id] = buf.toString("base64");
    }
    const data = {
      dim: this.provider.dim,
      provider: this.provider.id,
      vectors,
    };
    try {
      await fs.mkdir(path.dirname(this.persistPath), { recursive: true });
      // tmp + rename: ein Kill mitten im Write darf keine angerissene (aber
      // JSON-valide) Datei hinterlassen, die beim Load Vectors verliert.
      // #240/B3: unique per write — see embed-cache.ts. Same defect here.
      const tmp = `${this.persistPath}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(data));
      await fs.rename(tmp, this.persistPath);
    } catch (err) {
      console.error("[bastra.embeddings] persist error:", err);
    }
  }

  // ─── event handler ───────────────────────────────────────────

  private handle(e: VaultEvent): void {
    if (e.kind === "remove") {
      if (this.vectors.delete(e.id)) {
        this.schedulePersist();
      }
      // Cache-Eintrag löschen, damit ein späteres Re-Add tatsächlich
      // wieder embedded wird (Cache würde sonst als „fresh" einschätzen).
      if (this.cache.delete(e.id)) {
        void this.cache.save();
      }
      return;
    }
    // Vault hat eine Change/Add gemeldet → in Queue stopfen. Den Cache NICHT
    // invalidieren: der Hash-Vergleich beim nächsten Flush ist genau der
    // Filter, der entscheidet ob wirklich re-embedded werden muss. Wenn der
    // neue Content denselben Hash hat (z.B. unverändert oder nur kosmetische
    // Whitespace-Edits in einem Feld das wir nicht hashen), bleibt der Cache-
    // Eintrag fresh und der Provider-Call wird gespart.
    this.pendingQueue.add(e.memory.fm.id);
    void this.flushQueue();
  }

  /**
   * Public Enqueue mit Backpressure. Wenn die Queue über `BACKPRESSURE_LIMIT`
   * wächst, returnt ein Promise das nach `BACKPRESSURE_STALL_MS` resolvet —
   * der Caller (z.B. bulk-Import) blockiert kurz und gibt der Queue Zeit,
   * abzubauen.
   *
   * Wird nicht intern (von handle()) genutzt — Vault-Events sind selten
   * genug, dass Backpressure dort overkill ist. Gedacht für externe
   * Bulk-Producer (Backfill-Scripte, Bridge-RPC-Floods, Tests).
   */
  async enqueue(id: string): Promise<void> {
    this.pendingQueue.add(id);
    if (this.pendingQueue.size > backpressureLimit()) {
      this.stalls++;
      await new Promise<void>((r) => setTimeout(r, backpressureStallMs()));
    }
    void this.flushQueue();
  }

  /** Anzahl gerade laufender Provider-Calls (für Tests / Telemetry). */
  inFlightCount(): number {
    return this.inFlight;
  }

  /** Wie oft `enqueue()` gestallt hat (für Tests / Telemetry). */
  stallCount(): number {
    return this.stalls;
  }

  /** Runtime-Health (#92) — der Daemon spiegelt das auf /health, damit ein
   *  zur Laufzeit gestorbener Provider (Modell gelöscht, Server down) nicht
   *  als semantic_recall=on weiterläuft. Fehler wird beim nächsten
   *  erfolgreichen Provider-Call automatisch gecleart. */
  runtimeHealth(): EmbeddingRuntimeHealth {
    return {
      ok: this.lastError === null,
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt,
      lastOkAt: this.lastOkAt,
      errorCount: this.errorCount,
    };
  }

  /** Anzahl Provider-Calls seit Prozessstart (#109). */
  providerCallCount(): number {
    return this.providerCalls;
  }

  private markProviderOk(): void {
    this.lastError = null;
    this.lastOkAt = Date.now();
    this.providerCalls++;
  }

  private markProviderError(err: unknown): void {
    this.lastError = err instanceof Error ? err.message : String(err);
    this.lastErrorAt = Date.now();
    this.errorCount++;
  }

  /** Cache-Hits zu Beobachtungszwecken (Tests). */
  cacheSize(): number {
    return this.cache.size();
  }

  private async flushQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    // Laufende Provider-Calls. Batches werden NICHT inline awaited — sonst
    // wäre der Semaphore toter Code und alles liefe strikt seriell (genau so
    // war der Bug: inFlight konnte nie über 1 steigen).
    const inFlightBatches = new Set<Promise<void>>();
    let aborted = false;
    try {
      while (!aborted && this.pendingQueue.size > 0) {
        // Semaphore: warte bis ein In-Flight-Slot frei wird.
        while (this.inFlight >= MAX_CONCURRENT_BATCHES) {
          await Promise.race(inFlightBatches);
        }
        const batch = Array.from(this.pendingQueue).slice(0, 50);
        for (const id of batch) this.pendingQueue.delete(id);
        const memories = batch
          .map((id) => ({ id, m: this.vault.get(id) }))
          .filter(
            (x): x is { id: string; m: Memory } => x.m !== undefined,
          );
        if (memories.length === 0) continue;

        // Content-Hash-Cache: Items rausfiltern deren Hash sich nicht geändert
        // hat UND deren Vector noch in Memory liegt. Wenn der Vector fehlt
        // (z.B. nach Cache-Hit beim Cold-Start ohne Vectors), trotzdem embed.
        const toEmbed: { id: string; m: Memory; hash: string }[] = [];
        const skipped: { id: string }[] = [];
        for (const { id, m } of memories) {
          const hash = hashEmbedContent(m);
          if (this.cache.isFresh(id, hash) && this.vectors.has(id)) {
            skipped.push({ id });
          } else {
            toEmbed.push({ id, m, hash });
          }
        }
        if (skipped.length > 0) {
          // Listener trotzdem benachrichtigen — der RelatedEnricher will
          // wissen, dass das Memory "fresh genug" ist, auch wenn wir nicht
          // re-embedded haben.
          for (const { id } of skipped) {
            for (const listener of this.embedListeners) {
              try {
                listener(id);
              } catch (err) {
                console.error("[bastra.embeddings] embed listener error:", err);
              }
            }
          }
        }
        if (toEmbed.length === 0) continue;

        const texts = toEmbed.map(({ m }) => buildEmbedText(m));
        this.inFlight++;
        const batchPromise = (async () => {
          try {
            const vectors = await this.provider.embed(texts);
            this.markProviderOk();
            for (let i = 0; i < toEmbed.length; i++) {
              this.vectors.set(toEmbed[i].id, vectors[i]);
              this.cache.set(toEmbed[i].id, toEmbed[i].hash);
            }
            this.schedulePersist();
            void this.cache.save();
            for (const { id } of toEmbed) {
              for (const listener of this.embedListeners) {
                try {
                  listener(id);
                } catch (err) {
                  console.error("[bastra.embeddings] embed listener error:", err);
                }
              }
            }
          } catch (err) {
            this.markProviderError(err);
            console.error("[bastra.embeddings] batch error, requeue:", err);
            // Bei Fehler: Items zurück in queue für Retry beim nächsten
            // Add-Event oder Restart; keine neuen Batches mehr starten,
            // um einen Retry-Storm zu vermeiden.
            for (const { id } of toEmbed) this.pendingQueue.add(id);
            aborted = true;
          } finally {
            this.inFlight--;
          }
        })();
        inFlightBatches.add(batchPromise);
        void batchPromise.then(() => inFlightBatches.delete(batchPromise));
      }
      await Promise.all(inFlightBatches);
    } finally {
      this.processing = false;
      // #233: ein Add, das im Drain-Endfenster eintraf (Queue schon leer, aber
      // `processing` noch true), verpuffte am Guard oben und strandete bis zum
      // nächsten Vault-Event. Re-Check nach dem Reset — aber nur bei sauberem
      // Drain: nach einem Provider-Fehler wandern die Batch-IDs zurück in die
      // Queue (Retry), ein Re-Trigger würde sie sofort wieder scheitern lassen
      // (Retry-Storm). Fehler-Retries bleiben an Vault-Events/Restart gekoppelt.
      if (!aborted && this.pendingQueue.size > 0) void this.flushQueue();
    }
  }
}

// ─── helpers ─────────────────────────────────────────────────────

/** Baut den Text der ein Memory vector-mäßig repräsentiert. Title +
 *  Tags + recall_when + Summary + Body-Anfang. Body auf 4000 chars
 *  limitiert (Token-Budget). */
function buildEmbedText(m: Memory): string {
  const fm = m.fm;
  const parts = [
    fm.title,
    fm.tags.join(" "),
    fm.recall_when.join(" "),
    fm.summary,
    m.body.slice(0, 4000),
  ];
  return parts.filter((p) => p && p.length > 0).join("\n");
}

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (denom < 1e-10) return 0;
  return dot / denom;
}

// ─── Hybrid Recall (BM25 + Vector via RRF) ───────────────────────

/**
 * Ein fusionierter Hit: der (unskalierte) RRF-Wert plus das Rang-Paar, aus
 * dem er sich zusammensetzt. #230: der Score ist eine Rang-Größe, keine
 * Content-Similarity — das Rang-Paar macht das für Caller sichtbar.
 */
export interface FusedEntry {
  /** Summierter RRF-Wert (unskaliert): Σ 1/(k + rank) über beide Arme. */
  score: number;
  /** 1-basierter Rang im BM25-Arm, `null` wenn dieser Arm den Hit nicht führte. */
  rank_bm25: number | null;
  /** 1-basierter Rang im Vector-Arm, `null` wenn dieser Arm den Hit nicht führte. */
  rank_vector: number | null;
}

// #305/#342: the two constants moved to the dependency-free `rrf.ts` leaf so
// a hook CLI can word a band without importing this module's provider/cache
// stack (~12ms of process start vs ~1ms). Re-exported here, so `fuseRRF`
// below and every existing importer are unaffected. (Imported at the top of
// the file too — a bare `export … from` would not put RRF_K in local scope,
// and `fuseRRF` uses it as a default parameter.)
export { RRF_K, RRF_SCALE };

/**
 * Reciprocal-Rank-Fusion aus BM25-Hits und Vector-Hits. Höherer RRF-Score =
 * relevanter. Liefert pro Hit den RRF-Wert samt Rang-Paar (#230), damit der
 * spätere skalierte Score dekomponierbar bleibt.
 */
export function fuseRRF(
  bm25Ids: string[],
  vectorIds: string[],
  k: number = RRF_K,
): Map<string, FusedEntry> {
  const fused = new Map<string, FusedEntry>();
  const ensure = (id: string): FusedEntry => {
    let e = fused.get(id);
    if (!e) {
      e = { score: 0, rank_bm25: null, rank_vector: null };
      fused.set(id, e);
    }
    return e;
  };
  bm25Ids.forEach((id, idx) => {
    const e = ensure(id);
    e.score += 1 / (k + idx + 1);
    e.rank_bm25 = idx + 1;
  });
  vectorIds.forEach((id, idx) => {
    const e = ensure(id);
    e.score += 1 / (k + idx + 1);
    e.rank_vector = idx + 1;
  });
  return fused;
}
