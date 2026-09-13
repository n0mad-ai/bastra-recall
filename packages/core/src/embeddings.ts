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
import { RRF_K, RRF_SCALE } from "./rrf.js";
// #493: Die Provider stehen seit dem 800-Zeilen-Schnitt daneben. Re-exportiert,
// damit jeder bestehende Import aus `embeddings.js` unverändert weiterläuft.
import type { EmbeddingProvider } from "./embedding-providers.js";
import { PROVIDER_COLD_LOAD_MS } from "./embedding-providers.js";
export {
  OpenAIEmbeddingProvider,
  OllamaEmbeddingProvider,
  PROVIDER_COLD_LOAD_MS,
} from "./embedding-providers.js";
export type { EmbeddingProvider, EmbedWithMeta } from "./embedding-providers.js";

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


// ─── Embedding Hit ───────────────────────────────────────────────

export interface EmbeddingHit {
  id: string;
  /** Cosine similarity, [-1, 1]. Higher = more relevant. */
  score: number;
}

/**
 * #493: Wie der dichte Arm ausgegangen ist — die Unterscheidung, die
 * `search()` bis hierher verschluckt hat. Siehe
 * {@link EmbeddingIndex.searchDetailed}.
 */
export type ProviderOutcome = "hits" | "empty" | "error";

export interface VectorSearchOutcome {
  outcome: ProviderOutcome;
  /** Leer bei `empty` und bei `error`. */
  hits: EmbeddingHit[];
  /** Die vom Provider gemeldete Modell-Ladezeit dieses Calls (Ollama:
   *  `load_duration`), `null` wenn er keine meldet. ROH — die Kaltstart-
   *  Schwelle lässt sich daraus jederzeit neu ziehen. */
  providerLoadMs: number | null;
  /** GRUNDWAHRHEIT statt Schätzung: Der Provider hat für diesen Call ein
   *  Modell geladen (`providerLoadMs >= PROVIDER_COLD_LOAD_MS`). Genau die
   *  Größe, die Tor 3 aus #492 zählen will. */
  coldStartObserved: boolean;
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
   *  für Single-User-Vaults (≤10k Memories) schnell genug (<10ms).
   *
   *  Die BC-Fassade über {@link searchDetailed}: ein Provider-Fehler kommt hier
   *  weiterhin als `[]` zurück. Wer den Unterschied braucht, ruft die
   *  ausführliche Variante — siehe deren Kommentar. */
  async search(query: string, k: number = 10): Promise<EmbeddingHit[]> {
    return (await this.searchDetailed(query, k)).hits;
  }

  /**
   * #493: dieselbe Suche, aber mit einem STRUKTURIERTEN Ausgang.
   *
   * DER DEFEKT, den das behebt. `search()` fing jeden Provider-Fehler ab und
   * gab `[]` zurück — byte-identisch zu „dieser Vault hat keine Vektoren".
   * Für `abandonAfter` (deadline.ts) ist eine aufgelöste Promise ein `settled:
   * true`, also lernte das Latenzprofil (#491) die Dauer des FEHLERS als
   * gültige Latenzstichprobe: Ein Ollama, das nach 600 ms mit HTTP 500
   * antwortet, brachte dem Profil bei „600 ms sind ein normaler dichter Arm",
   * und Tor 3 aus #492 hätte die Zeile womöglich als echten Kaltstart gezählt.
   *
   * Drei Ausgänge, weil es drei verschiedene Ereignisse sind:
   *
   *   `hits`  — der Provider hat geantwortet und es gab Vektoren zu ranken.
   *             NUR das ist eine Latenzstichprobe.
   *   `empty` — kein Fehler, aber nichts zu ranken (leerer Vault, leere
   *             Query, Provider ohne Vektor in der Antwort). Der teuerste
   *             Unterfall davon macht gar keinen Provider-Call, weshalb die
   *             Dauer hier keine Providerdauer sein muss.
   *   `error` — der Provider ist gescheitert. Keine Latenz, keine Residenz,
   *             kein Kaltstart.
   */
  async searchDetailed(query: string, k: number = 10): Promise<VectorSearchOutcome> {
    const empty = (): VectorSearchOutcome => ({
      outcome: "empty",
      hits: [],
      providerLoadMs: null,
      coldStartObserved: false,
    });
    if (!query.trim() || this.vectors.size === 0) return empty();
    let q: Float32Array;
    let loadMs: number | null = null;
    try {
      // `embedWithMeta` wo der Provider es kann (Ollama meldet `load_duration`),
      // sonst der alte Weg — eine gehostete API hat kein Modell von uns im
      // Speicher und damit nichts zu melden.
      const result = this.provider.embedWithMeta
        ? await this.provider.embedWithMeta([query])
        : { vectors: await this.provider.embed([query]), loadMs: null };
      this.markProviderOk();
      loadMs = result.loadMs;
      if (result.vectors.length === 0) return { ...empty(), providerLoadMs: loadMs };
      q = result.vectors[0];
    } catch (err) {
      this.markProviderError(err);
      console.error("[bastra.embeddings] query embed error:", err);
      return { outcome: "error", hits: [], providerLoadMs: null, coldStartObserved: false };
    }
    const hits: EmbeddingHit[] = [];
    for (const [id, v] of this.vectors) {
      hits.push({ id, score: cosine(q, v) });
    }
    hits.sort((a, b) => b.score - a.score);
    return {
      outcome: "hits",
      hits: hits.slice(0, k),
      providerLoadMs: loadMs,
      coldStartObserved: loadMs !== null && loadMs >= PROVIDER_COLD_LOAD_MS,
    };
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
        // #495: Dieser Call läuft BEWUSST nicht durch den Warmup-Singleflight
        // aus #494. Der ist ein Warmup-Singleflight, kein Provider-
        // Singleflight: Der Backfill ist echte Arbeit mit eigenem Ergebnis und
        // eigenem Limit (`this.inFlight` gegen EMBED_MAX_INFLIGHT), und ihn in
        // jene Grenze zu ziehen hieße, Batches zu verwerfen, weil gerade ein
        // Wärmeembed fliegt. Seine Last bleibt sichtbar: Der
        // Nebenläufigkeitszähler aus #493 sitzt am Providerrand im Daemon und
        // zählt ihn mit. Die Entscheidung steht bei `ensureWarm`
        // (daemon/embedding-warmup.ts).
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
