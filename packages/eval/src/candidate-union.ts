/**
 * Kandidaten-Union für das Qualitätsset (#362, Phase 0.5).
 *
 * Jede Bewertung, die bisher gefahren wurde, hat dieselbe Schwäche: Sie nimmt
 * die heute ausgelieferten Treffer als Wahrheit. Das ist zirkulär. Ein Treffer
 * mit `score >= 100` muss konstruktionsbedingt aus BEIDEN Armen stammen — wer
 * gegen diese Menge misst, kann nie herausfinden, was ein einarmiger Modus
 * besser fände, weil solche Kandidaten die 100 nie erreichen und deshalb gar
 * nicht erst im Vergleich auftauchen.
 *
 * Dieses Werkzeug baut die Menge, gegen die man ehrlich messen kann: die
 * VEREINIGUNG dessen, was die verschiedenen Wege vorschlagen —
 *
 *   - die Top-N des dichten Arms,
 *   - die Top-N des lexikalischen Arms,
 *   - den schnellen Lexikpfad als eigenen Modus (`bm25_no_fuzzy`),
 *   - was über der Einblendgrenze liegt (Score >= 100),
 *   - beide Ränder: unter 100 UND unter dem Floor von 30, letzteres aus dem
 *     tiefen Kandidatenpool, den die Antwort gar nicht mehr enthält,
 *   - exakte Identifier-Treffer (die Klasse, die der dichte Arm nachweislich
 *     verfehlt: 22 von 90 im Stresstest),
 *   - eine query-gehashte, scope-kompatible Kontrollstichprobe aus dem Vault —
 *     sonst misst das Set nur, wie einig sich die Retriever sind.
 *
 * Die Projekt-Erkennung für die Kontrolle nutzt die echte `cwd`, die Claude
 * Code auf jeden User-Turn im Transkript mitschreibt (kein Raten mehr aus dem
 * #-codierten Session-Ordnernamen). Zwei UNABHÄNGIGE Fragen entscheiden über
 * den Pool, nicht eine abgeleitete Kette (siehe `recognizeProject`): (1) Liefert
 * die cwd überhaupt ein Projekt? (2) Kommt das im Vault als Scope vor? Drei
 * Lagen, drei Provenienzen, damit keine mit einer anderen Frage verwechselt
 * wird:
 *   - `random-control`              Projekt erkannt UND Vault-Scope
 *                                   vorhanden — die eigentlich interessante,
 *                                   scope-kompatible Kontrolle.
 *   - `random-control-global-only`  Projekt aus der cwd klar, aber KEIN
 *                                   Vault-Scope dafür — Pool ist dann
 *                                   ausdrücklich nur die globale Schicht
 *                                   (all-projects, user-preference, taxonomy,
 *                                   commons), es gibt zu diesem Projekt
 *                                   schlicht noch nichts Eigenes.
 *   - `random-control-unscoped`     Aus der cwd ließ sich gar kein Projekt
 *                                   ableiten — Pool ist dann wirklich
 *                                   ungefiltert (`allMemories`), statt die Query
 *                                   ganz ohne Kontrolle zu lassen.
 *
 * Ausgegeben werden ZWEI Dateien, verknüpft über `query_index` + `id`:
 *
 *   - `--out foo.json`      das BLINDE Arbeitsblatt zum Labeln — NUR id,
 *                           title, label. Auch die Provenienz bleibt draußen:
 *                           "above-inject-floor" vs. "random-control" färbt
 *                           ein menschliches Relevanzurteil genauso wie ein
 *                           Score. Kandidaten sind je Query deterministisch
 *                           (query-gehasht) gemischt, damit die Reihenfolge
 *                           selbst keinen Hinweis gibt.
 *   - `foo.meta.json`       die AUSWERTUNGSDATEI mit allem, was beim Labeln
 *                           verstecken muss: Provenienz, Score, Rang unter
 *                           dem Floor, Abstand zu Score 30.
 *
 * ```
 * BASTRA_VAULT_PATH=~/vault npx tsx src/candidate-union.ts --n 20 --out set.json
 * ```
 *
 * Die Aufteilung in Train/Validation gehört NICHT hierher und passiert nicht
 * zufällig über einzelne Treffer: Zwei Kandidaten derselben Query sind nicht
 * unabhängig. Getrennt wird nach ganzen Queries beziehungsweise Sessions.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  Vault,
  Memory,
  SearchIndex,
  EmbeddingIndex,
  OllamaEmbeddingProvider,
  groupQueryTerms,
  tokenizeWithIdentifiers,
  detectProject,
  isScopeCompatible,
  normalizeScopeKey,
  GLOBAL_SCOPES,
} from "@bastra-recall/core";

const MUST_LOAD_SCORE = 100;
const RECALL_FLOOR = 30;

/** Wieviele scope-kompatible Kontroll-Memories pro Query gezogen werden. */
const CONTROL_SIZE = 8;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** Woher ein Kandidat kommt. Mehrere Quellen pro Kandidat sind der Normalfall. */
type Provenance =
  | "dense-top"
  | "lexical-top"
  /** Score >= 100 im Core. NICHT dasselbe wie „wurde eingeblendet": danach
   *  kommen Scope-Filter, weak_result, Backoff, Session-Dedup und Lane-Regeln.
   *  Der Name sagt deshalb, was gemessen wurde, nicht was vermutet wird. */
  | "above-inject-floor"
  /** Score 30..99 (im Ergebnis der Fusion) ODER Score < 30 (Near-Miss aus dem
   *  tiefen Pool, der nie zurückgegeben wird). Beide Fälle teilen sich die
   *  Provenienz, unterscheiden sich aber in der Meta-Datei über `score` und
   *  `rank_below_floor` — genau der Rand, den man kennen muss, wurde von
   *  mindestens einem Arm gefunden, nur außerhalb von dessen ausgewerteter
   *  Top-20-Tiefe. */
  | "below-floor"
  | "identifier-exact"
  /** Der schnelle Lexikpfad als eigener Modus (`bm25_no_fuzzy`) — er ist es,
   *  der freigegeben werden soll, also muss er seine eigenen Kandidaten
   *  vorschlagen dürfen. Exakte Identifier-Abfragen ersetzen ihn nicht. */
  | "lexical-fast"
  /** Query-gehashte, scope-kompatible Memories, die kein Retriever vorgeschlagen
   *  hat. Eine Union kann nur labeln, was mindestens ein Retriever gefunden
   *  hat — diese Quelle ist der einzige Blick auf den GEMEINSAMEN blinden
   *  Fleck. Ohne sie misst das Set, wie gut die Retriever untereinander
   *  übereinstimmen, nicht wie gut sie sind. */
  | "random-control"
  /** Projekt erkannt (Scope existiert im Vault), aber der scope-kompatible
   *  Pool bestand ausschließlich aus globalen Scopes — es gibt zu diesem
   *  Projekt im Vault schlicht noch keine eigenen Memories. Eigene
   *  Provenienz, weil das etwas anderes aussagt als eine Kontrolle mit
   *  echtem Projektbezug. */
  | "random-control-global-only"
  /** Wie `random-control`, aber OHNE verlässliche Scope-Erkennung — die
   *  Projekt-Erkennung ist gescheitert, oder das erkannte Segment ist gar
   *  kein tatsächlicher Vault-Scope. Beantwortet eine andere Frage
   *  (irgendein Vault-Rest statt Projekt-Kontext) und wird deshalb nicht mit
   *  `random-control` vermischt, siehe Header. */
  | "random-control-unscoped";

/** Was ein Mensch beim Labeln sieht: NUR id, title, label. Auch die
 *  Provenienz bleibt draußen — "above-inject-floor" vs. "random-control"
 *  beeinflusst ein menschliches Relevanzurteil genauso wie ein Score oder ein
 *  Rang, siehe Header. Provenienz lebt ausschließlich in `CandidateMeta`. */
interface Candidate {
  id: string;
  title: string;
  label: null | "required" | "optional" | "irrelevant";
}

/** Die Zahlen, die beim Labeln verstecken müssen. `score` ist nur für
 *  `above-inject-floor` / `below-floor` gesetzt (gemeinsame Hybrid-Skala
 *  0..100+) — die anderen Arme liefern Scores auf unvergleichbaren Skalen
 *  (Cosinus, roher BM25), die hier nichts über "Randbreite reicht 5?" aussagen
 *  würden. */
interface CandidateMeta {
  id: string;
  provenance: Provenance[];
  score: number | null;
  /** 1 = am nächsten am Floor, nur für Near-Miss-Kandidaten (score < 30) aus
   *  dem tiefen Pool gesetzt. Beantwortet: "kam auf Position 6–10 noch etwas
   *  Relevantes?" */
  rank_below_floor: number | null;
  /** score - RECALL_FLOOR, nur wenn score bekannt. */
  distance_to_floor: number | null;
}

interface QuerySet {
  query_index: number;
  query: string;
  query_chars: number;
  unique_terms: number;
  candidates: Candidate[];
}

interface MetaSet {
  query_index: number;
  candidates: CandidateMeta[];
}

interface Prompt {
  text: string;
  /** Session-Ordner unter ~/.claude/projects — Teil des Dedup-Keys (siehe
   *  `collectPrompts`), damit derselbe Prompttext aus zwei verschiedenen
   *  Projekten nicht willkürlich nur dem zuerst gelesenen zugeordnet wird. */
  sessionDir: string;
  /** cwd aus dem JSONL-Record selbst — Claude Code schreibt sie auf jeden
   *  User-Turn mit, das ist der echte Pfad statt eine Näherung aus dem
   *  #-codierten Ordnernamen. `null` nur, falls ein Transkript das Feld
   *  nicht trägt (alte Version, unvollständige Zeile). */
  cwd: string | null;
}

async function collectPrompts(limit: number): Promise<Prompt[]> {
  const root = path.join(os.homedir(), ".claude", "projects");
  // Dedup-Key ist sessionDir+Text, nicht nur Text: sonst landet derselbe
  // Prompttext aus zwei Projekten willkürlich beim zuerst gelesenen
  // Verzeichnis, und dessen cwd/Projekt ist für die andere Query schlicht
  // falsch.
  const found = new Map<string, Prompt>();
  let dirs: string[] = [];
  try {
    dirs = (await fs.readdir(root)).sort();
  } catch {
    return [];
  }
  for (const d of dirs) {
    let files: string[] = [];
    try {
      files = (await fs.readdir(path.join(root, d))).filter((f) => f.endsWith(".jsonl")).sort();
    } catch {
      continue;
    }
    for (const f of files) {
      let raw: string;
      try {
        raw = await fs.readFile(path.join(root, d, f), "utf8");
      } catch {
        continue;
      }
      for (const line of raw.split("\n")) {
        if (!line.startsWith("{")) continue;
        let rec: { type?: string; message?: { role?: string; content?: unknown }; cwd?: string };
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        if (rec.type !== "user" || rec.message?.role !== "user") continue;
        const c = rec.message.content;
        const text =
          typeof c === "string"
            ? c
            : Array.isArray(c)
              ? c
                  .filter((p): p is { type: string; text: string } => (p as { type?: string })?.type === "text")
                  .map((p) => p.text)
                  .join("\n")
              : "";
        if (text.includes("<recall-hints") || text.includes("<system-reminder")) continue;
        // Bewusst die ganze Breite, nicht nur lange Prompts: Der Router muss
        // gerade an der Grenze zwischen billig und teuer bewertet werden.
        if (text.length < 40 || text.length > 8000) continue;
        const key = `${d}\0${text}`;
        if (!found.has(key)) found.set(key, { text, sessionDir: d, cwd: rec.cwd ?? null });
      }
    }
  }
  // Deterministisch und über die Längen gestreut, damit kurze exakte Suchen und
  // lange Prosa beide im Set landen. sessionDir als Tiebreaker, damit zwei
  // Einträge mit identischem Text (verschiedene Projekte) stabil sortiert
  // bleiben statt von der Map-Iterationsreihenfolge abzuhängen.
  const sorted = [...found.values()].sort(
    (a, b) =>
      a.text.length - b.text.length ||
      (a.text < b.text ? -1 : a.text > b.text ? 1 : a.sessionDir < b.sessionDir ? -1 : 1),
  );
  const step = Math.max(1, Math.floor(sorted.length / limit));
  const out: Prompt[] = [];
  for (let i = 0; i < sorted.length && out.length < limit; i += step) out.push(sorted[i]);
  return out;
}

interface RawCandidate {
  id: string;
  title: string;
  provenance: Provenance[];
  score: number | null;
  rankBelowFloor: number | null;
}

function add(
  map: Map<string, RawCandidate>,
  id: string,
  title: string,
  p: Provenance,
  hybrid?: { score: number; rankBelowFloor?: number },
): void {
  const existing = map.get(id);
  if (existing) {
    if (!existing.provenance.includes(p)) existing.provenance.push(p);
    // Erster Hybrid-Score gewinnt — spätere Aufrufe (z.B. dense-top nach
    // below-floor) liefern keine vergleichbare Skala und dürfen ihn nicht
    // überschreiben.
    if (hybrid && existing.score === null) {
      existing.score = hybrid.score;
      existing.rankBelowFloor = hybrid.rankBelowFloor ?? null;
    }
    return;
  }
  map.set(id, {
    id,
    title,
    provenance: [p],
    score: hybrid?.score ?? null,
    rankBelowFloor: hybrid?.rankBelowFloor ?? null,
  });
}

/** Sieht der Term aus wie ein Bezeichner — Pfad, Datei, camelCase, Punktkette? */
function looksLikeIdentifier(term: string): boolean {
  if (term.length < 4) return false;
  return /[./_-]/.test(term) || /[a-z][A-Z]/.test(term) || /\d/.test(term);
}

/**
 * Zwei UNABHÄNGIGE Fragen, die vorher fälschlich zu einer verschmolzen waren
 * (Review-Fund: dadurch war `random-control-global-only` unerreichbar, weil
 * "erkannt" implizit schon "hat einen Vault-Scope" bedeutete):
 *
 *   - `project`:  reine cwd-Frage. Was liefert `detectProject(cwd)` aus der
 *                 echten cwd des Transkripts (kein Raten aus dem #-codierten
 *                 Session-Ordnernamen mehr)? `null`, wenn cwd fehlt oder
 *                 `detectProject` nichts liefert.
 *   - `hasScope`: reine Vault-Frage. Kommt DIESES Projekt im Vault
 *                 tatsächlich als Scope vor? Ein Projekt kann aus der cwd
 *                 klar erkennbar sein und trotzdem (noch) keinen eigenen
 *                 Vault-Scope haben — genau der mittlere Fall, den es zu
 *                 unterscheiden gilt.
 */
function recognizeProject(cwd: string | null, knownScopes: Set<string>): { project: string | null; hasScope: boolean } {
  const project = cwd ? detectProject(cwd) : null;
  // `knownScopes` ist über `normalizeScopeKey` normalisiert (siehe Aufrufer)
  // — hier ebenso, sonst bleibt z.B. "CarNexus" (roher Ordnername) für immer
  // ohne Scope, obwohl "carnexus" im Vault existiert.
  return { project, hasScope: project !== null && knownScopes.has(normalizeScopeKey(project)) };
}

/** Deterministischer 32-Bit-Hash (FNV-1a) — kein Math.random, damit derselbe
 *  Lauf reproduzierbar bleibt, aber verschiedene Queries verschiedene
 *  Kontrollmemories und Mischungen bekommen. */
function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 — kleiner seedbarer PRNG für die deterministische Mischung. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleDeterministic<T>(arr: T[], seed: number): T[] {
  const rng = mulberry32(seed);
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

async function main(): Promise<void> {
  const vaultRoot = (process.env.BASTRA_VAULT_PATH ?? arg("--vault", "")).replace(/^~/, os.homedir());
  if (!vaultRoot) {
    console.error("FATAL: set BASTRA_VAULT_PATH (or --vault)");
    process.exit(1);
  }
  const n = Number.parseInt(arg("--n", "20"), 10);
  const out = arg("--out", "");
  // Pilot war 5 (nur Position 1-5 unter dem Floor). Default jetzt 10, damit die
  // Meta-Datei beantworten kann, ob 5 gereicht hätte oder ob auf Position 6-10
  // noch etwas Relevantes saß.
  const belowFloorMargin = Number.parseInt(arg("--below-floor-margin", "10"), 10);

  const vault = new Vault(vaultRoot);
  await vault.init();
  const search = new SearchIndex(vault);
  search.start();
  const emb = new EmbeddingIndex(
    vault,
    new OllamaEmbeddingProvider({
      baseURL: process.env.BASTRA_OLLAMA_URL ?? "http://localhost:11434",
      model: process.env.BASTRA_EMBEDDING_MODEL ?? "embeddinggemma",
      keepAlive: "10m",
    }),
    path.join(vaultRoot, ".bastra", "embeddings.json"),
  );
  await emb.start();
  search.useEmbeddings(emb);

  const allMemories: Memory[] = vault.list();
  // Über `normalizeScopeKey` normalisiert, damit der Vergleich in
  // `recognizeProject` case-insensitive bleibt (siehe Kommentar dort und bei
  // `isScopeCompatible`).
  const knownScopes = new Set(allMemories.map((m) => normalizeScopeKey(m.fm.scope)));

  const prompts = await collectPrompts(n);
  const sets: QuerySet[] = [];
  const metaSets: MetaSet[] = [];
  // Wie oft die Projekt-Erkennung scheitert/unsicher bleibt bzw. ein Projekt
  // erkennt, das im Vault noch keine eigenen Memories hat — interessiert beim
  // Auswerten, ob die Erkennung selbst nachgebessert werden muss.
  let unscopedFallbackCount = 0;
  let globalOnlyCount = 0;

  for (const prompt of prompts) {
    const q = prompt.text;
    const map = new Map<string, RawCandidate>();
    const titleOf = (id: string): string => vault.get(id)?.fm.title ?? id;

    // 1) Was über der Einblendgrenze liegt, plus BEIDE Ränder. Der tiefe
    //    Kandidatenpool geht unter den Floor von 30 — genau dort sitzt der
    //    Kandidat, den ein anderer Modus nach oben spülen könnte, und ein Set
    //    ohne ihn kann diesen Effekt nie messen.
    let deepPool: { id: string; score: number }[] = [];
    const hybrid = await search.recallHybrid(q, {
      k: 30,
      onCandidatePool: (pool) => {
        deepPool = pool.map((h) => ({ id: h.id, score: h.score }));
      },
    });
    for (const h of hybrid) {
      if (h.score >= MUST_LOAD_SCORE) add(map, h.id, h.title, "above-inject-floor", { score: h.score });
      else if (h.score >= RECALL_FLOOR) add(map, h.id, h.title, "below-floor", { score: h.score });
    }
    // Der Rand UNTER 30 — im Pool, aber nie zurückgegeben. Bewusst nur die
    // NÄCHSTEN paar: Gefragt ist die Schwellenumgebung, nicht der ganze Pool.
    // Ungebremst kamen auf 12 Queries 1004 Randkandidaten zusammen, mehr als
    // hundert pro Query — ein Arbeitsblatt, das niemand labelt, ist so wertlos
    // wie gar keines.
    const nearMiss = deepPool
      .filter((c) => c.score < RECALL_FLOOR)
      .sort((a, b) => b.score - a.score)
      .slice(0, belowFloorMargin);
    nearMiss.forEach((c, i) =>
      add(map, c.id, titleOf(c.id), "below-floor", { score: c.score, rankBelowFloor: i + 1 }),
    );

    // 2) Der dichte Arm für sich — er findet anderes als die Fusion zeigt.
    for (const d of await emb.search(q, 20)) add(map, d.id, titleOf(d.id), "dense-top");

    // 3) Der lexikalische Arm für sich.
    for (const b of search.recall(q, { k: 20 })) add(map, b.id, b.title, "lexical-top");

    // 4) Der schnelle Lexikpfad als eigener Modus — er soll freigegeben
    //    werden, also schlägt er selbst vor.
    for (const h of search.recall(q, { k: 20, bm25_no_fuzzy: true })) {
      add(map, h.id, h.title, "lexical-fast");
    }

    // 5) Exakte Identifier — die Klasse, die der dichte Arm nachweislich
    //    verfehlt. Ohne sie fehlt dem Set genau der Fall, für den BM25 bleibt.
    const grouped = groupQueryTerms(q, tokenizeWithIdentifiers);
    for (const term of grouped.counts.keys()) {
      if (!looksLikeIdentifier(term)) continue;
      for (const h of search.recall(term, { k: 5, bm25_no_fuzzy: true })) {
        add(map, h.id, h.title, "identifier-exact");
      }
    }

    // 6) Kontrollstichprobe: scope-kompatible Memories, die diese Query nicht
    //    über einen Retriever gefunden hat. Query-gehasht statt "jedes k-te
    //    nach Vault-Reihenfolge" — sonst zieht praktisch jede Query dieselbe
    //    Menge (dieselbe Vault-Reihenfolge, derselbe Stride), unabhängig davon,
    //    worum es in ihr geht, und die Kontrolle testet gar nichts.
    const { project, hasScope } = recognizeProject(prompt.cwd, knownScopes);
    // Drei Lagen (siehe Header), jede mit einem EXPLIZIT anderen Pool — kein
    // "isScopeCompatible mit Phantom-Projekt" mehr, das durch die immer
    // vorhandenen globalen Memories ohnehin nie leer geworden wäre:
    let pool: Memory[];
    let controlProvenance: Provenance;
    if (project === null) {
      // Fakt 1 negativ: aus der cwd ließ sich gar kein Projekt ableiten
      // (fehlt im Transkript, oder kein bekanntes Root-Stichwort im Pfad) —
      // Kontrolle ist dann auch wirklich ungefiltert, nicht nur behauptet.
      pool = allMemories;
      controlProvenance = "random-control-unscoped";
      unscopedFallbackCount++;
    } else if (!hasScope) {
      // Fakt 1 positiv, Fakt 2 negativ: Projekt aus der cwd klar, aber im
      // Vault (noch) kein eigener Scope dafür. `isScopeCompatible` mit einem
      // Scope, den es gar nicht gibt, würde nur die globale Schicht liefern —
      // das schreiben wir hier explizit, statt es zufällig herauszufinden.
      pool = allMemories.filter((m) => GLOBAL_SCOPES.has(normalizeScopeKey(m.fm.scope)));
      controlProvenance = "random-control-global-only";
      globalOnlyCount++;
    } else {
      pool = allMemories.filter((m) => isScopeCompatible(m.fm.scope, project));
      controlProvenance = "random-control";
    }
    const seed = hashString(q);
    const stride = Math.max(1, Math.floor(pool.length / CONTROL_SIZE));
    const offset = seed % stride;
    for (let i = 0, idx = offset; i < CONTROL_SIZE && idx < pool.length; i++, idx += stride) {
      const m = pool[idx];
      if (!map.has(m.fm.id)) add(map, m.fm.id, m.fm.title, controlProvenance);
    }

    const raw = [...map.values()];
    // Deterministisch gemischt (eigener Seed, damit die Mischung nicht an der
    // Kontroll-Auswahl hängt) statt nach id sortiert — sonst wäre die
    // Reihenfolge selbst ein Hinweis (Provenienz-Cluster, id-Muster).
    const shuffled = shuffleDeterministic(raw, hashString(q + "#shuffle"));

    const queryIndex = sets.length;
    sets.push({
      query_index: queryIndex,
      query: q,
      query_chars: q.length,
      unique_terms: grouped.counts.size,
      candidates: shuffled.map((c) => ({
        id: c.id,
        title: c.title,
        label: null,
      })),
    });
    metaSets.push({
      query_index: queryIndex,
      candidates: raw.map((c) => ({
        id: c.id,
        provenance: c.provenance,
        score: c.score,
        rank_below_floor: c.rankBelowFloor,
        distance_to_floor: c.score !== null ? c.score - RECALL_FLOOR : null,
      })),
    });
    process.stderr.write(`  ${sets.length}/${prompts.length}: ${map.size} Kandidaten\n`);
  }

  const total = sets.reduce((s, q) => s + q.candidates.length, 0);
  const byProv = new Map<string, number>();
  for (const s of metaSets)
    for (const c of s.candidates)
      for (const p of c.provenance) byProv.set(p, (byProv.get(p) ?? 0) + 1);

  console.log(`\nQueries: ${sets.length}, Kandidaten gesamt: ${total}`);
  console.log("Provenienz (Mehrfachnennung pro Kandidat möglich):");
  for (const [p, c] of [...byProv.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${p.padEnd(24)} ${String(c).padStart(5)}`);
  }
  if (unscopedFallbackCount > 0) {
    console.log(
      `\nProjekt-Erkennung gescheitert/unsicher bei ${unscopedFallbackCount}/${sets.length} Queries — ` +
        "deren Kontrolle ist UNGEFILTERT (random-control-unscoped), nicht scope-kompatibel.",
    );
  }
  if (globalOnlyCount > 0) {
    console.log(
      `Projekt aus der cwd erkannt, aber ohne Vault-Scope bei ${globalOnlyCount}/${sets.length} Queries — ` +
        "deren Kontrolle (random-control-global-only) besteht ausdrücklich nur aus globalen Scopes.",
    );
  }
  // Exklusivität wird gegen die ARM-Quellen gerechnet, nicht gegen alle
  // Provenienzen: `below-floor` und die Kontroll-Provenienzen sagen nichts
  // darüber aus, WELCHER Retriever einen Kandidaten gefunden hat, und würden
  // die Aussage sonst verwässern, bis sie null ergibt.
  const LEX: Provenance[] = ["lexical-top", "lexical-fast", "identifier-exact"];
  const HYBRID_POOL: Provenance[] = ["above-inject-floor", "below-floor"];
  const all = metaSets.flatMap((s) => s.candidates);
  const onlyDense = all.filter(
    (c) => c.provenance.includes("dense-top") && !LEX.some((p) => c.provenance.includes(p)),
  ).length;
  const onlyLex = all.filter(
    (c) => LEX.some((p) => c.provenance.includes(p)) && !c.provenance.includes("dense-top"),
  ).length;
  // Außerhalb der ausgewerteten Arm-Tiefe: der Hybrid-Pool (above-inject-floor
  // / below-floor) hat den Kandidaten gefunden — also mindestens ein Arm hat
  // ihn gescort —, aber er landete nicht in dessen Top-20 dense-top/lexical-*.
  // Das ist Pool-Randzone, KEIN blinder Fleck.
  const outsideArmDepth = all.filter(
    (c) =>
      HYBRID_POOL.some((p) => c.provenance.includes(p)) &&
      !c.provenance.includes("dense-top") &&
      !LEX.some((p) => c.provenance.includes(p)),
  ).length;
  // Von keinem Retriever vorgeschlagen: einzig über die random-control-Quelle
  // ins Set gekommen, kein Arm und kein Hybrid-Pool hat den Kandidaten je
  // berührt. Das ist der tatsächliche gemeinsame blinde Fleck.
  const CONTROL: Provenance[] = ["random-control", "random-control-global-only", "random-control-unscoped"];
  const noRetriever = all.filter((c) => c.provenance.every((p) => CONTROL.includes(p))).length;
  console.log(`\nNur vom dichten Arm gefunden:                     ${onlyDense}`);
  console.log(`Nur von einem lexikalischen Modus gefunden:       ${onlyLex}`);
  console.log(`Außerhalb der ausgewerteten Arm-Tiefe (Pool-Rand): ${outsideArmDepth}`);
  console.log(`Von KEINEM Retriever vorgeschlagen (Kontrolle):   ${noRetriever}`);
  console.log("Die ersten beiden Zahlen kann ein Set aus den heutigen Treffern nicht enthalten.");
  console.log("Die dritte ist Pool-Randzone: mindestens ein Arm hat gescort, nur außerhalb seiner Top-20.");
  console.log("Die vierte ist der einzige echte gemeinsame blinde Fleck, sichtbar nur über die Kontrolle.");
  console.log(`\nLabelaufwand: ${all.length} Kandidaten über ${sets.length} Queries (${Math.round(all.length / sets.length)} je Query).`);

  if (out) {
    const metaOut = out.endsWith(".json") ? out.slice(0, -".json".length) + ".meta.json" : out + ".meta.json";
    await fs.writeFile(out, JSON.stringify({ created_for: "#362 Phase 0", sets }, null, 2), "utf8");
    await fs.writeFile(
      metaOut,
      JSON.stringify({ created_for: "#362 Phase 0", note: "NICHT zum Labeln — enthält Scores/Ränge.", sets: metaSets }, null, 2),
      "utf8",
    );
    console.log(`\nBlindes Arbeitsblatt geschrieben: ${out}`);
    console.log(`Auswertungsdatei geschrieben:      ${metaOut}`);
    console.log('Labeln: jedes `label: null` in der ERSTEN Datei auf "required" | "optional" | "irrelevant" setzen.');
  }

  search.stop();
  emb.stop();
  await vault.stop();
  process.exit(0);
}

void main();
