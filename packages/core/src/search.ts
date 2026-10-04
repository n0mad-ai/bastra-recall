import type { Memory } from "./schema.js";
import type { Vault, VaultEvent } from "./vault.js";
import type { EmbeddingIndex } from "./embeddings.js";
import { normalizeQuery, tokenizeWithIdentifiers } from "./query-normalize.js";
import { DocFreqMiniSearch } from "./doc-freq-index.js";
import { rareTermFuzzy } from "./bm25-expansion.js";
import { groupQueryTerms, groupedTokenize } from "./bm25-grouping.js";
import { capBm25Query } from "./bm25-query-cap.js";
import type { CueProjection } from "./cue-sidecar.js";
import type { CueIndexOptions, IndexDoc, RecallHit, RecallOptions } from "./search-types.js";
import { matchedRecallWhen, anchorStrength } from "./search-anchor.js";
import {
  passesRecallFilters,
  round,
  StageEmitter,
  lookupQueryCache,
  emitCachedPool,
  storeQueryCache,
  collectOneHopNeighbors,
  type QueryCacheEntry,
} from "./search-pipeline.js";
import { applyStaleness, type StaleStatus } from "./search-staleness.js";
import { awaitDenseArm, fuseArms } from "./search-hybrid.js";

/*
 * #1039: Die Recall-Pipeline ist auf fünf Module verteilt. Dieses hier hält den
 * Index und seinen Zustand (`SearchIndex`) und die beiden Recall-Pfade; die
 * öffentlichen Typen und Funktionen der anderen Module werden unten unter dem
 * alten Pfad re-exportiert, damit kein Importeur sich ändert.
 *
 *   search-types.ts      RecallHit, RecallOptions, IndexDoc, CueIndexOptions
 *   search-anchor.ts     matched_recall_when / anchor_strength pro Treffer
 *   search-pipeline.ts   Filter, Rundung, Stage-Events, Query-Cache, 1-Hop
 *   search-hybrid.ts     dichter Arm (Warten + Filter) und RRF-Fusion
 *   search-staleness.ts  Lifecycle-Reranking und das Score-Gateway
 */
export type { RecallHit, RecallOptions, CueIndexOptions } from "./search-types.js";
export {
  type StaleStatus,
  CURATOR_DEMOTION_MULTIPLIER,
  DOC_TYPE_DAMPING,
  salienceRankCap,
  computeStaleness,
  applyStalenessMultiplier,
} from "./search-staleness.js";

/**
 * Field weights of the BM25 index — the "Search ranking" table in
 * packages/daemon/README.md. The cue field is not here: its weight comes from
 * the caller (`CueFieldOptions.boost`).
 */
export const FIELD_BOOST: Readonly<Record<string, number>> = Object.freeze({
  // recall_when is authored exactly for triggering — highest weight.
  recall_when_flat: 5,
  title: 4,
  tags_flat: 3,
  // doc2query paraphrases (#117): machine-generated, so weighted below
  // the hand-written triggers and tags but above plain body — they widen
  // far recall without outranking the author's own words.
  recall_when_expanded_flat: 2,
  topic_path_flat: 2,
  summary: 2,
  body: 1,
});

/**
 * In-memory BM25 search over the vault.
 * Built on minisearch — handles ~thousands of memorys easily.
 * Field weights chosen so title + recall_when + tags > body.
 */
export class SearchIndex {
  private mini: DocFreqMiniSearch<IndexDoc>;
  private detach?: () => void;
  private embeddings?: EmbeddingIndex;

  // Staleness-Cache (#29): `computeStaleness()` parsed Date-Strings und
  // rechnet Ratio-Logik — pro Recall × Hit-Count summiert sich das. Cache
  // ist memId → { touchTs, status, computedAt }. Invalidiert in `handle()`
  // bei change/remove, plus 12h-TTL gegen Tageswechsel (`aging → stale`
  // ohne Vault-Change).
  private stalenessCache = new Map<
    string,
    { touchTs: number; status: StaleStatus; computedAt: number }
  >();

  // Curator-Demotions (#155): id-Set, vom Daemon nach jedem Curator-Pass
  // (und beim Boot aus dem State-File) gesetzt. Reiner Score-Mechanismus —
  // siehe CURATOR_DEMOTION_MULTIPLIER.
  private curatorDemotions = new Set<string>();

  /** Ersetzt das aktive Demotion-Set (score-only, #155). Leert den
   *  Query-Cache, damit die neue Gewichtung sofort greift. */
  setDemotions(ids: Iterable<string>): void {
    this.curatorDemotions = new Set(ids);
    this.queryCache.clear();
  }

  // #360: recall_when-DF für `anchorStrength` — wie viele DISTINKTE Memories
  // tragen `term` (gefaltet) in ihrem `recall_when`? `DocFreqMiniSearch.docFreq()`
  // summiert über alle sieben indizierten Felder und ist damit für die
  // Anker-Seltenheit die falsche Zahl (ein Term in zehn Bodies zählt zehnfach
  // mit, obwohl er nur einmal authored getriggert wurde). Gepflegte Zähl-Map
  // statt Live-Scan: ein Anker-Check pro Recall-Hit würde sonst den ganzen
  // Vault durchlaufen. `recallWhenTermsByMemId` hält die zuletzt gezählten
  // Terme pro Memory, damit `change`/`remove` sie sauber wieder abziehen kann.
  private recallWhenTermFreq = new Map<string, number>();
  private recallWhenTermsByMemId = new Map<string, Set<string>>();

  /** Zieht die zuletzt gezählten recall_when-Terme einer Memory wieder ab —
   *  Vorstufe für Re-Index (`change`) und `remove`. No-op, wenn die id noch
   *  nie gezählt wurde (erste Indizierung). */
  private forgetRecallWhenTerms(id: string): void {
    const terms = this.recallWhenTermsByMemId.get(id);
    if (!terms) return;
    for (const t of terms) {
      const n = this.recallWhenTermFreq.get(t) ?? 0;
      if (n <= 1) this.recallWhenTermFreq.delete(t);
      else this.recallWhenTermFreq.set(t, n - 1);
    }
    this.recallWhenTermsByMemId.delete(id);
  }

  /** Wie viele Memories tragen `term` (gefaltet) in ihrem `recall_when` —
   *  DISTINKTE Memories, nicht die feldübergreifende Summe. */
  private recallWhenDocFreq(term: string): number {
    return this.recallWhenTermFreq.get(term.toLowerCase()) ?? 0;
  }

  // Query-Cache (#30): MiniSearch tokenisiert die Query bei jedem
  // `recall()` neu. Hooks rufen häufig mit identischer Query auf
  // (detectTopics() ist deterministisch). LRU via Map-insertion-order,
  // hard cap 100 Einträge, TTL 30s. Vault-Change leert komplett.
  // #365/5: der Eintrag trägt den TIEFEN Pool mit, nicht nur die servierten k
  // Hits. `onCandidatePool` ist der einzige Weg nach draußen für die Kandidaten
  // unterhalb von k (Reflex-/Hop-Seeds, far-slice-Harvest) — ohne Pool im Cache
  // lieferte ein Hit für die volle TTL nichts (BM25) bzw. Tiefe k statt
  // max(k*4, 20) (Hybrid). Rein In-Memory, ~20 flache Objekte pro Eintrag.
  private queryCache = new Map<string, QueryCacheEntry>();

  /**
   * Die geladene Cue-Projektion, oder `null` — und `null` ist der
   * Produktionszustand: Solange kein Generator gelaufen ist, gibt es keine
   * Sidecar-Datei (§11.4 Rollback). Dann wird `cues_flat` weder als Feld
   * angemeldet noch je gesetzt, und der Index ist derselbe wie vor der
   * Cue-Schicht — nicht „gleich gemessen", sondern gleich konstruiert.
   */
  private readonly cues: CueProjection | null;

  constructor(
    private readonly vault: Vault,
    cues?: CueIndexOptions,
  ) {
    // Freier Parameter (§18.3): Boost und alle Cue-Parameter werden auf dem
    // Auswahlteil bestimmt, nicht hier geraten. Der Default 0 heißt AUS, und
    // aus heißt: das Feld existiert nicht. Ein Boost von 0 bei angemeldetem
    // Feld wäre nicht dasselbe — ein Dokument, das NUR über einen Cue matcht,
    // käme mit Score 0 trotzdem in den Kandidatenpool und veränderte ihn.
    const boost = cues?.boost ?? 0;
    this.cues = cues && boost > 0 ? cues.projection : null;
    this.mini = new DocFreqMiniSearch<IndexDoc>({
      // #162: Identifier-erhaltender Tokenizer (Dual-Emission: `my-app.config.ts`
      // + `my app config ts`). Gilt für Index- UND Query-Seite — MiniSearch fällt
      // ohne `searchOptions.tokenize` auf diese Funktion zurück; KEIN separates
      // searchOptions.tokenize setzen, sonst bricht die Symmetrie (query-normalize.ts).
      tokenize: tokenizeWithIdentifiers,
      fields: [
        "title",
        "summary",
        "tags_flat",
        "recall_when_flat",
        "recall_when_expanded_flat",
        "topic_path_flat",
        "body",
        ...(this.cues ? (["cues_flat"] as const) : []),
      ],
      storeFields: [
        "id",
        "title",
        "type",
        "scope",
        "summary",
        "topic_path",
        "obsolete",
        "confidence",
        "sensitivity",
      ],
      searchOptions: {
        boost: {
          ...FIELD_BOOST,
          // Abgeleitete Cues: eigenes Gewicht, eigener Vertrauensklasse wegen.
          // Der Wert kommt vom Aufrufer und wird auf dem Auswahlteil bestimmt
          // (§18.3) — hier steht kein geratener Standardwert.
          ...(this.cues ? { cues_flat: boost } : {}),
        },
        fuzzy: 0.2,
        prefix: true,
        combineWith: "OR",
      },
    });
  }

  /** Initial population from the vault, then subscribe to changes. */
  start(): void {
    for (const m of this.vault.list()) this.indexOne(m);
    this.detach = this.vault.on((e) => this.handle(e));
  }

  stop(): void {
    this.detach?.();
    this.detach = undefined;
  }

  /** Optionalen Embedding-Index registrieren — recallHybrid nutzt ihn,
   *  recall (sync) bleibt BM25-only für Backwards-Compat. */
  useEmbeddings(idx: EmbeddingIndex | undefined): void {
    this.embeddings = idx;
  }

  hasEmbeddings(): boolean {
    return this.embeddings !== undefined;
  }

  /**
   * Alles, was der lexikalische Arm für EINEN Aufruf braucht — an einer Stelle,
   * damit die drei Dinge zusammenbleiben, die zusammengehören: die gruppierte
   * Query, die Optionen, die ihre Häufigkeiten wieder einrechnen, und die
   * Termmenge für den Anker.
   *
   * Getrennt gehalten wären sie eine Fehlerquelle mit Ansage: Ein gruppierter
   * Aufruf OHNE `boostTerm` verliert das Gewicht der Wiederholung, und ein
   * `boostTerm` ohne den Identitäts-Tokenizer zählt Identifier doppelt. Beides
   * fällt nicht auf — es rankt nur anders.
   */
  private bm25Plan(
    query: string,
    opts: RecallOptions,
  ): {
    lexQuery: string;
    searchOptions: Record<string, unknown>;
    queryTerms: ReadonlySet<string>;
    /** Nur die Terme aus der AUTHORED Query — die Basis jeder Anker- und
     *  Berechtigungsentscheidung (siehe `authored_query`). */
    authoredTerms: ReadonlySet<string>;
    emitted: number;
    unique: number;
  } {
    const capped = capBm25Query(query, (term) => this.mini.docFreq(term), {
      maxChars: opts.bm25_query_max_chars ?? 0,
    });
    const grouped = groupQueryTerms(capped, tokenizeWithIdentifiers);
    const fuzzy = rareTermFuzzy((term) => this.mini.docFreq(term), opts.bm25_fuzzy_rare_df_max);
    // #362 Phase 3: `bm25_no_fuzzy` schlägt die feinere Steuerung — wer den
    // schnellen Pfad anfordert, will keine Expansion, auch keine selektive.
    const fuzzyOption = opts.bm25_no_fuzzy ? { fuzzy: false } : fuzzy ? { fuzzy } : {};
    return {
      lexQuery: grouped.query,
      searchOptions: {
        // Die Query ist bereits die Termliste — erneut zerlegen würde die
        // Dual-Emission des Identifier-Tokenizers ein zweites Mal anwenden.
        tokenize: groupedTokenize,
        boostTerm: (term: string) => grouped.counts.get(term) ?? 1,
        ...fuzzyOption,
      },
      queryTerms: new Set(grouped.counts.keys()),
      authoredTerms:
        opts.authored_query === undefined || opts.authored_query === query
          ? new Set(grouped.counts.keys())
          : new Set(groupQueryTerms(opts.authored_query, tokenizeWithIdentifiers).counts.keys()),
      emitted: grouped.emitted,
      unique: grouped.counts.size,
    };
  }

  recall(query: string, opts: RecallOptions = {}): RecallHit[] {
    // #162: Query-Hygiene für ALLE Caller (MCP-Recall, Hooks, Bridge, Dedup) —
    // Längen-Cap, Whitespace-Kollaps, dangling Operatoren. Vor dem Cache-Key,
    // damit äquivalente Queries denselben Eintrag teilen.
    query = normalizeQuery(query);
    const k = opts.k ?? 5;
    const stage = new StageEmitter(opts.onStage);
    const recallStart = Date.now();

    const tParse = stage.start("query.parse");
    if (!query.trim()) {
      stage.end("query.parse", tParse);
      stage.emit("done", recallStart, { hit_count: 0, vault_size: this.mini.documentCount, total_ms: 0 });
      return [];
    }
    stage.end("query.parse", tParse);

    // Query-Cache (#30) — bei Hit komplett überspringen, inkl. Hop-
    // Expansion und Staleness-Reranking. Cache speichert das finale
    // RecallHit[], nicht den BM25-Roh-Output.
    const cacheKey = `recall|${query}|${JSON.stringify(opts)}`;
    const cached = lookupQueryCache(this.queryCache, cacheKey);
    if (cached) {
      stage.emit("cache.hit", recallStart, { cache: "query", hit_count: cached.hits.length });
      // #365/5: der Hit kehrte hier zurück, BEVOR irgendein `onCandidatePool`
      // lief — auf dem BM25-Pfad feuerte er also gar nicht. Ein einziger
      // primender Caller reichte, um Reflex- und Hop-Seeds für die volle TTL
      // verschwinden zu lassen. Replay vor `done`, damit die Reihenfolge
      // dieselbe ist wie auf dem kalten Pfad.
      emitCachedPool(opts, cached.pool);
      stage.emit("done", recallStart, {
        hit_count: cached.hits.length,
        vault_size: this.mini.documentCount,
        total_ms: Date.now() - recallStart,
        cached: true,
      });
      return cached.hits;
    }

    const tBm = stage.start("bm25.search");
    const plan = this.bm25Plan(query, opts);
    const lexQuery = plan.lexQuery;
    const raw = this.mini.search(lexQuery, plan.searchOptions);
    const authoredTerms = plan.authoredTerms;
    stage.end("bm25.search", tBm, {
      raw_hit_count: raw.length,
      query_chars: query.length,
      bm25_query_chars: lexQuery.length,
      // #362 Phase 0: Die Kosten des Arms hängen an der Termzahl, nicht an den
      // Zeichen — und der Abstand zwischen beiden Zahlen IST der Gewinn der
      // Gruppierung. Ohne sie in der Telemetrie ist später nicht mehr
      // nachvollziehbar, ob ein langsamer Aufruf viele Terme hatte oder viele
      // Wiederholungen.
      terms_emitted: plan.emitted,
      terms_unique: plan.unique,
    });

    const filtered = raw.filter((r) => {
      if (!passesRecallFilters(r, opts)) return false;
      return true;
    });

    const { ranked, pool } = this.rankBm25(filtered, k, opts, stage, authoredTerms);

    storeQueryCache(this.queryCache, cacheKey, ranked, pool);

    stage.emit("done", recallStart, {
      hit_count: ranked.length,
      vault_size: this.mini.documentCount,
      total_ms: Date.now() - recallStart,
    });
    return ranked;
  }

  /**
   * BM25 hit construction → candidate pool → damping/re-sort → top-k → hops.
   *
   * Factored out so `recallHybrid` can degrade to the BM25 result WITHOUT
   * re-entering the public `recall()` (#240/B2 follow-up): that recursion
   * opened a second StageEmitter on the same callback, so `bm25.search` was
   * emitted twice, MCP progress jumped backwards from stage 4 to 1, telemetry
   * buckets overwrote each other, and a warm inner cache reported the whole
   * hybrid attempt as `cache.hit` while `onCandidatePool` fired zero times.
   * The caller owns `query.parse`, `bm25.search`, `done` and the cache.
   */
  private rankBm25(
    filtered: ReturnType<DocFreqMiniSearch<IndexDoc>["search"]>,
    k: number,
    opts: RecallOptions,
    stage: StageEmitter,
    /** Gefaltete Query-Terme für den exakten Anker — siehe `matchedRecallWhen`. */
    queryTerms: ReadonlySet<string>,
  ): { ranked: RecallHit[]; pool: RecallHit[] } {
    // Pool-Size für Hop-Seeds: max(k*4, 20). Multi-Hop soll Nachbarn auch
    // für Hits sehen, die knapp unter dem k-Cut liegen — sonst gehen die
    // related_via-Kanten der Positionen 6–20 verloren.
    const HOP_SEED_POOL = Math.max(k * 4, 20);
    const directFull: RecallHit[] = filtered.slice(0, HOP_SEED_POOL).map((r) => ({
      id: r.id as string,
      title: r.title as string,
      type: r.type as string,
      scope: r.scope as string,
      summary: r.summary as string,
      topic_path: r.topic_path as string[],
      score: round(r.score),
      matched_terms: r.terms ?? [],
      matched_recall_when: matchedRecallWhen(r, queryTerms),
      ...(() => {
        const a = anchorStrength(r, queryTerms, (t) => this.recallWhenDocFreq(t), (id) =>
          this.vault.get(id)?.fm.recall_when ?? [],
        );
        return a ? { anchor_strength: a } : {};
      })(),
      mode: "bm25" as const,
      hop: "direct" as const,
    }));

    // #240/A7: apply the lifecycle/curator/doc/salience multipliers to the
    // FULL candidate pool and re-sort BEFORE cutting to k. Cutting first meant
    // a fresh hit at position k+1 could never displace an expired, demoted or
    // doc-damped hit inside the top-k — so the served top-k was not the top-k
    // of the ranking function the code actually defines. Fires whenever two
    // candidates sit within the damping factor of each other (<5× expired,
    // <2× doc/curator), which is the normal case for near-duplicate notes.
    // applyStaleness mutates scores in place, so the damping runs on a CLONE:
    // `directFull` keeps its raw scores for the hop seeds below. Damping the
    // seeds first compounded the multiplier — a neighbour behind an expired
    // seed was multiplied twice (0.2 × 0.2), dropping a fresh neighbour to 4%
    // of its raw score and below downstream floors.
    const tStale = stage.start("staleness.rank");
    const rankedFull = this.applyStaleness(directFull.map((h) => ({ ...h })), opts);
    const direct = rankedFull.slice(0, k);
    stage.end("staleness.rank", tStale, { reranked_count: direct.length });

    // #121: expose the deeper pool (incl. below-floor candidates) before slicing to k.
    // #365/16: DAMPED pool, hinter dem Damping. Vorher ging `directFull` mit
    // rohen Scores raus, während die servierten Hits gedämpft waren — zwei
    // Skalen in derselben Telemetrie, und da das Damping umsortiert, kippte
    // auch die Reihenfolge gegen die servierte. Die Hop-Seeds hängen NICHT am
    // Callback (sie greifen unten direkt auf `directFull` zu), der Pool darf
    // hier also gedämpft sein; `rankedFull` ist derselbe tiefe Pool.
    opts.onCandidatePool?.(rankedFull);

    let ranked: RecallHit[];
    if (opts.expand_hops === 1) {
      const tHops = stage.start("hops.expand");
      // Seeded from the RAW pool; each neighbour is damped exactly once, by
      // its own multiplier.
      const neighbors = this.applyStaleness(
        collectOneHopNeighbors(this.vault, directFull, opts, new Set(direct.map((h) => h.id))),
        opts,
      ).slice(0, k);
      stage.end("hops.expand", tHops, { hop_count: neighbors.length });
      ranked = [...direct, ...neighbors];
    } else {
      ranked = direct;
    }
    // #365/5: der Pool geht mit zurück, damit der Caller ihn in den
    // Query-Cache legen und bei einem Hit erneut ausliefern kann.
    return { ranked, pool: rankedFull };
  }

  /** Hybrid-Recall: BM25 + Vector via Reciprocal-Rank-Fusion. Wenn kein
   *  EmbeddingIndex registriert ist — oder der Vektor-Arm nichts liefert
   *  (#240/B1) — fällt auf reines BM25 (sync) zurück.
   *
   *  Der finale Score ist `RRF * RRF_SCALE` (siehe :39 und die Skalierung unten),
   *  NICHT die hier früher behaupteten `* 1000`. Wichtig für jeden, der
   *  Schwellen darauf setzt: der Wert ist eine skalierte Rang-Summe, keine
   *  Ähnlichkeit — Rang 1 in beiden Armen ergibt die Obergrenze 163.934
   *  (#230). */
  async recallHybrid(query: string, opts: RecallOptions = {}): Promise<RecallHit[]> {
    if (!this.embeddings) return this.recall(query, opts);
    // #162: gleiche Query-Hygiene wie in recall() — auch der Vector-Arm
    // profitiert vom Längen-Cap (idempotent, deshalb kein Doppel-Schaden
    // beim BM25-Fallback oben).
    query = normalizeQuery(query);
    const k = opts.k ?? 5;
    const stage = new StageEmitter(opts.onStage);
    const recallStart = Date.now();

    const tParse = stage.start("query.parse");
    if (!query.trim()) {
      stage.end("query.parse", tParse);
      stage.emit("done", recallStart, { hit_count: 0, vault_size: this.mini.documentCount, total_ms: 0 });
      return [];
    }
    stage.end("query.parse", tParse);

    // Query-Cache (#30) — eigener Key-Prefix damit BM25-only und Hybrid
    // sich nicht gegenseitig überschreiben (gleicher Query-String,
    // anderes Ranking-Ergebnis).
    // #240/B2: the cache key must carry the vector generation. Otherwise a
    // result computed while the vector arm was unavailable (provider down, or
    // simply the boot-window backfill still running) survives recovery for
    // the full TTL — and the boot window is exactly when session-start hooks
    // inject. Callbacks vanish from JSON.stringify, so they never varied the
    // key; the generation does.
    const cacheKey = `hybrid|${this.embeddings.size()}|${query}|${JSON.stringify(opts)}`;
    const cached = lookupQueryCache(this.queryCache, cacheKey);
    if (cached) {
      // #240/B2: the sync path emits cache.hit + done on a hit; this one
      // returned before any emission, so SSE progress and the candidate-pool
      // harvest silently saw nothing.
      stage.emit("cache.hit", recallStart, { cache: "query", hit_count: cached.hits.length });
      // #365/5: bisher gingen hier die SERVIERTEN k Hits als „Pool" raus —
      // bei k=2 also Tiefe 2 statt der 8, die derselbe Call kalt geliefert
      // hätte. Jetzt der mitgecachte tiefe Pool.
      emitCachedPool(opts, cached.pool);
      stage.emit("done", recallStart, {
        hit_count: cached.hits.length,
        vault_size: this.mini.documentCount,
        total_ms: Date.now() - recallStart,
        cached: true,
        // P0: der Degradations-Grund wird mit-repliziert. Er ist die einzige
        // Quelle, aus der der Recall-Handler `score_kind` ableitet — fehlt er
        // beim Cache-Hit, wird derselbe rohe BM25-Score (gemessen: 1997.338)
        // beim zweiten Aufruf als `rrf` ausgeliefert und von den Bändern
        // 50/100 gelesen, die nur auf der RRF-Skala existieren.
        ...(cached.degraded ? { degraded: cached.degraded } : {}),
      });
      return cached.hits;
    }

    // #370: der Dense-Arm wird ZUERST abgefeuert und erst nach dem BM25-Pass
    // awaited. Er ist ein Netzwerk-Roundtrip zu Ollama, BM25 ist CPU-Arbeit
    // in-process, und zwischen den Armen besteht keine Datenabhängigkeit —
    // `fuseRRF` konsumiert beide Rank-Listen ohnehin erst danach. Vorher lief
    // `this.mini.search()` vollständig durch, bevor der Embed überhaupt
    // dispatched wurde: die Wanduhr zahlte die SUMME statt des MAXIMUMS
    // (gemessen über n=1545 `hook_recall`, 19.–24.08.: `latency_ms_recall −
    // (bm25 + vector)` p50 1 ms / p90 2 ms — die Stages addierten sich exakt
    // zum Total, es überlappte nichts).
    //
    // Reines Reordering: identische Eingaben in beide Arme, identisches
    // RRF-Ergebnis.
    //
    // #466: Die Deadline läuft ab dem `await` unten, NICHT ab dem Abfeuern.
    // #370 wollte sie ab dem Abfeuern, damit der Arm nicht „Budget plus
    // BM25-Zeit" bekommt. Das setzt voraus, dass der Arm während BM25 auch
    // läuft — und das tat er nicht: Der Request geht erst auf die Leitung,
    // wenn der Loop frei ist, und danach hält BM25 ihn synchron. Ein Timer,
    // der beim Abfeuern startet, misst deshalb die BM25-Dauer, nicht den Arm.
    // Am 02.09. waren 27 von 49 Prompt-Lane-Recalls unfused, `vector_search_ms`
    // lag bei jedem davon auf `bm25_search_ms` + 2…7 ms bzw. exakt auf der
    // Deadline — bei einem Ollama, das die Embeds in 25–66 ms beantwortet.
    // Die Folge war kein Latenzgewinn, sondern ein stiller Qualitätsverlust:
    // ohne Fusion kein REQUIRED-Band, kein Backoff-Bypass, kein semantischer
    // Reflex (prompt-lane.ts).
    //
    // Ab dem `await` bekommt der Arm sein volles Budget für die Zeit, in der
    // er tatsächlich auf Antwort wartet. Ein Arm, der wirklich zu langsam ist,
    // läuft weiterhin in seinen Timeout (dense-arm-dispatch.test.ts). Die
    // Stage `vector.search` misst weiterhin ab dem Abfeuern — sie ist die
    // Wanduhr des Arms, nicht seine Frist.
    // #240/A8: ask for a deeper pool when a filter is active. The vault/scope/
    // type/private filter below runs AFTER the provider's global top-k, so a
    // fixed 100 silently truncated eligible candidates for every scoped query
    // — measured on a real 514-memory vault: 95.3% of scoped queries lost
    // in-scope candidates, and the smallest scopes lost a third of theirs.
    const filtered = opts.scope != null || opts.type != null || !opts.allow_private;
    // #365/4 hat den Provider-Fehler über `runtimeHealth().errorCount` um den
    // `await` herum erschlossen, weil `EmbeddingIndex.search()` jeden Fehler
    // abfing und `[]` zurückgab — byte-identisch zu „dieser Vault hat keine
    // Vektoren". #493 hat den Ausgang STRUKTURIERT gemacht (`searchDetailed`),
    // also steht er jetzt direkt am Ergebnis statt aus einem Zählerdelta
    // erschlossen zu werden. Das war nicht nur unschön: `abandonAfter` sah in
    // der aufgelösten Fehler-Promise ein `settled: true`, und das Latenzprofil
    // (#491) lernte die Dauer des Fehlers als gültige Stichprobe.
    const tVec = stage.start("vector.search");
    const vectorArm = this.embeddings.searchDetailed(query, filtered ? 1000 : 100);

    // #305: EIN Durchlauf des Event Loops, bevor der lexikalische Arm ihn
    // synchron belegt.
    //
    // WARUM DAS NÖTIG IST. Die Zeile darüber startet den dichten Arm, aber sie
    // SENDET ihn nicht: Ein HTTP-Request verlässt den Prozess erst, wenn der
    // Loop das nächste Mal frei ist. `this.mini.search()` unten ist synchron
    // und hält ihn — bei langen Queries mehrere hundert Millisekunden. Ohne
    // diese Zeile lief also folgendes ab: Deadline-Timer startet, Ollama wird
    // gar nicht gefragt, der Timer fällt, und der Arm gilt als „zu langsam".
    //
    // Nachgestellt mit der dichten Seite in einem eigenen Prozess: ohne den
    // Durchlauf 5 von 5 Läufen im Timeout, mit ihm 0 von 5 — bei sonst
    // identischen Zeiten. In der Produktionstelemetrie ist derselbe Effekt als
    // 96 % Event-Loop-Blockade an der scheinbaren Vektorzeit sichtbar.
    //
    // WAS DAS NICHT TUT. Es ändert weder die Reihenfolge der Arme noch ihre
    // Eingaben noch die Fusion — beide bekommen dieselbe Query wie vorher, RRF
    // rechnet unverändert.
    //
    // Der Durchlauf reicht nur, wenn der Request in ihm auch geschrieben wird —
    // das setzt einen SCHON offenen Socket voraus (#466: der Ollama-Provider
    // hält seine Verbindung deshalb über einen Keep-Alive-Agent, embeddings.ts).
    // Auf einem kalten Socket wird der Connect erst nach BM25 fertig; dann
    // läuft der Arm sequentiell hinter BM25 und bekommt seine Frist ab dem
    // `await` unten.
    //
    // WARUM EIN TIMER UND KEIN `setImmediate`. Gemessen gegen einen echten
    // Fremdprozess, je 5 Läufe mit 300 ms Blockade:
    //
    //   nichts (vorher)   5/5 Timeouts    0,000 ms
    //   1x setImmediate   5/5 Timeouts    0,020 ms
    //   3x setImmediate   5/5 Timeouts    0,048 ms
    //   setTimeout(0)     0/5 Timeouts    1,141 ms
    //
    // `setImmediate` läuft in der Check-Phase und lässt die Poll-Phase aus —
    // genau die, in der der Socket-Connect fertig wird und der Request
    // geschrieben wird. Ein Timer durchläuft den Zyklus vollständig. Beliebig
    // viele Immediates helfen deshalb nicht; einer allein tut es hier nicht.
    //
    // Der Preis ist die Timer-Mindestauflösung, gemessen 1,1 ms, und er fällt
    // nur an, wo es überhaupt einen dichten Arm gibt: Dieser Zweig läuft nur
    // mit angehängtem Embedding-Index.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    // BM25 — top 50 für RRF-Pool. Läuft jetzt IM Schatten des Dense-Arms.
    // #362: der lexikalische Arm bekommt die gekappte Query (siehe
    // `bm25Query`), der Dense-Arm oben bewusst die vollständige — Embedding-
    // Kosten sind längenunabhängig konstant (104–153 ms über alle Bänder),
    // und der semantische Arm lebt vom ganzen Kontext.
    const tBm = stage.start("bm25.search");
    const plan = this.bm25Plan(query, opts);
    const lexQuery = plan.lexQuery;
    const bm25 = this.mini
      .search(lexQuery, plan.searchOptions)
      .filter((r) => passesRecallFilters(r, opts));
    const authoredTerms = plan.authoredTerms;
    const bm25Top = bm25.slice(0, 50);
    stage.end("bm25.search", tBm, {
      raw_hit_count: bm25.length,
      query_chars: query.length,
      bm25_query_chars: lexQuery.length,
      terms_emitted: plan.emitted,
      terms_unique: plan.unique,
    });

    const { vectorTop, vectorArmTimedOut, vectorArmErrored } =
      await awaitDenseArm(vectorArm, this.vault, opts, stage, tVec);

    // #240/B1: an empty vector arm is NOT "degraded to BM25" — running RRF
    // on one arm produced a different score space, not the BM25 one. A
    // one-armed rank-1 hit scores RRF_SCALE/(RRF_K+1) = 81.967 by
    // construction, and the documented MUST_LOAD band (100) is structurally
    // unreachable on one arm at ANY k — exactly when the provider is down.
    // (The width of the band below that ceiling does move with RRF_K: at
    // k=60 rank 20 sat at 62.5, at k=5 it sits at 19.7.) Fall back to the
    // real BM25 path so scores mean what the thresholds assume.
    if (vectorTop.length === 0) {
      // Reuse the BM25 results this call already computed — no recursion into
      // the public pipeline, so the stage sequence stays monotonic and emits
      // exactly one `done` and one candidate-pool callback.
      const { ranked: bm25Only, pool: bm25Pool } = this.rankBm25(bm25, k, opts, stage, authoredTerms);
      // #342: a timeout degradation must NOT be cached. The cache key varies on
      // `embeddings.size()`, which a cold model does not change — so caching
      // here would freeze the one-armed answer for the full TTL and every
      // follow-up query in that window would be served BM25-only by a warm
      // machine. Same trap #240/B2 closed for the boot window, arriving through
      // a different door. An empty vector arm still caches: that is a property
      // of the vault, not of this call's timing.
      // #365/4: ein Provider-FEHLER ist ebenfalls eine Eigenschaft dieses
      // Calls, nicht des Vaults. `embeddings.size()` im Key bewegt sich dabei
      // nicht, also fror ein 5xx die einarmige Antwort für die volle TTL ein —
      // die Erholung des Providers kam nicht durch. Gleiche Falle wie #342,
      // durch die Nachbartür.
      if (!vectorArmTimedOut && !vectorArmErrored) {
        // P0: der Grund geht MIT in den Cache. Diese Hits sind rohe
        // BM25-Scores; ein Cache-Hit, der das verschweigt, macht sie beim
        // Leser wieder zu RRF-Werten.
        storeQueryCache(this.queryCache, cacheKey, bm25Only, bm25Pool, "vector-arm-empty");
      }
      stage.emit("done", recallStart, {
        hit_count: bm25Only.length,
        vault_size: this.mini.documentCount,
        total_ms: Date.now() - recallStart,
        degraded: vectorArmTimedOut
          ? "vector-arm-timeout"
          : vectorArmErrored
            ? "vector-arm-error"
            : "vector-arm-empty",
      });
      return bm25Only;
    }

    const outFull = fuseArms(
      bm25Top,
      vectorTop,
      k,
      this.vault,
      authoredTerms,
      (t) => this.recallWhenDocFreq(t),
      stage,
    );

    // #240/A7: same ordering fix as the BM25 path — multipliers and re-sort
    // over the full pool, THEN cut to k. Damping runs on a clone so `outFull`
    // keeps raw scores for the hop seeds (see the BM25 path for why).
    const tStale = stage.start("staleness.rank");
    const rankedFull = this.applyStaleness(outFull.map((h) => ({ ...h })), opts);
    const out = rankedFull.slice(0, k);
    stage.end("staleness.rank", tStale, { reranked_count: out.length });

    // #121: expose the deeper pool (incl. below-floor candidates) before slicing to k.
    // #365/16: gedämpfter Pool, hinter dem Damping — gleiche Skala und gleiche
    // Reihenfolge wie die servierten Hits (siehe rankBm25).
    opts.onCandidatePool?.(rankedFull);

    let ranked: RecallHit[];
    if (opts.expand_hops === 1) {
      const tHops = stage.start("hops.expand");
      const neighbors = this.applyStaleness(
        collectOneHopNeighbors(this.vault, outFull, opts, new Set(out.map((h) => h.id))),
        opts,
      ).slice(0, k);
      stage.end("hops.expand", tHops, { hop_count: neighbors.length });
      ranked = [...out, ...neighbors];
    } else {
      ranked = out;
    }

    storeQueryCache(this.queryCache, cacheKey, ranked, rankedFull);

    stage.emit("done", recallStart, {
      hit_count: ranked.length,
      vault_size: this.mini.documentCount,
      total_ms: Date.now() - recallStart,
    });
    return ranked;
  }

  loadFull(id: string): Memory | undefined {
    return this.vault.get(id);
  }

  size(): number {
    return this.mini.documentCount;
  }

  // ─── internals ───────────────────────────────────────────────

  private handle(e: VaultEvent): void {
    if (e.kind === "remove") {
      // Staleness-Cache invalidieren (#29) — memId genügt.
      this.stalenessCache.delete(e.id);
      // #360: recall_when-DF-Map — die Terme dieser Memory zählen nicht mehr
      // mit. `indexOne()` (add/change) macht das intern selbst; hier muss es
      // explizit passieren, weil kein neuer Indexier-Aufruf folgt.
      this.forgetRecallWhenTerms(e.id);
      // Query-Cache komplett leeren (#30) — selektive Invalidierung wäre
      // ein eigenes Ranking-Problem und Vault-Changes sind selten.
      this.queryCache.clear();
      try {
        this.mini.discard(e.id);
      } catch {
        // not indexed; ignore
      }
      return;
    }
    if (e.kind === "change") {
      this.stalenessCache.delete(e.memory.fm.id);
      this.queryCache.clear();
      try {
        this.mini.discard(e.memory.fm.id);
      } catch {
        // first time; treat as add
      }
    } else if (e.kind === "add") {
      // Neue Memory könnte BM25-Ranking aller bestehenden Queries
      // verändern → Query-Cache leeren. Staleness wird ohnehin lazy
      // beim nächsten Recall berechnet.
      this.queryCache.clear();
    }
    this.indexOne(e.memory);
  }

  /** Score-Gateway (#194): alle Multiplikatoren in EINER Funktion, siehe
   *  `applyStaleness` in search-staleness.ts — hier nur mit dem Zustand. */
  private applyStaleness(hits: RecallHit[], opts: RecallOptions = {}, now: Date = new Date()): RecallHit[] {
    return applyStaleness(this.vault, this.stalenessCache, this.curatorDemotions, hits, opts, now);
  }

  private indexOne(m: Memory): void {
    const fm = m.fm;
    // #360: recall_when-DF-Map neu aufbauen — erst alte Terme dieser id
    // abziehen (no-op bei Erstindizierung), dann die aktuellen zählen. Deckt
    // add/change gleichermaßen ab, `remove` räumt in `handle()` separat auf,
    // weil dort kein neuer Stand mehr kommt.
    this.forgetRecallWhenTerms(fm.id);
    const recallWhenTerms = new Set(
      tokenizeWithIdentifiers(fm.recall_when.join(" ")).map((t) => t.toLowerCase()),
    );
    for (const t of recallWhenTerms) {
      this.recallWhenTermFreq.set(t, (this.recallWhenTermFreq.get(t) ?? 0) + 1);
    }
    this.recallWhenTermsByMemId.set(fm.id, recallWhenTerms);
    const doc: IndexDoc = {
      id: fm.id,
      title: fm.title,
      summary: fm.summary,
      tags_flat: fm.tags.join(" "),
      recall_when_flat: fm.recall_when.join(" \n "),
      recall_when_expanded_flat: (fm.recall_when_expanded ?? []).join(" \n "),
      topic_path_flat: fm.topic_path.join(" "),
      body: m.body,
      // Nur wenn eine Projektion geladen ist. Ein Memory ohne Cues bekommt das
      // Feld leer — es ist dann im Index vorhanden, trägt aber keine Terme.
      ...(this.cues
        ? { cues_flat: (this.cues.byMemory.get(fm.id) ?? []).join(" \n ") }
        : {}),
      type: fm.type,
      scope: fm.scope,
      topic_path: fm.topic_path,
      obsolete: fm.obsolete === true,
      confidence: fm.confidence ?? 1,
      // Default ist "team" (kommt aus dem zod-Schema), aber alte Files
      // ohne das Feld werden hier zu "team" defaultet damit der Filter
      // konsistent ist.
      sensitivity: (fm as { sensitivity?: string }).sensitivity ?? "team",
    };
    this.mini.add(doc);
  }
}
