/**
 * Offline bridge harvester (#120). Reconstructs (far query → acted-on memory) pairs
 * from the telemetry log and mints learned bridges from them — the "minting" half of
 * the shared learned-recall layer, run OFFLINE rather than on the recall hot path.
 *
 * Why offline: recall runs on a 500 ms hook budget, the positive acted_on signal is
 * sparse, and harvesting touches the vault to read a memory's vocabulary. Doing it at
 * write/idle time (a CLI command or a periodic job) keeps the query path untouched and
 * matches zzallirog's "harvest at write time, no query cost" point (#120).
 *
 * Honest scope: this reads only what telemetry already logs — in-band acted_on reaches
 * (the runner's word, positive-biased). The below-floor far slice stays invisible until
 * #121 logs it; this harvester picks up everything that is observable today.
 */
import { readdir, readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { detectLanguage } from "./language.js";
import { mintBridge, type Bridge } from "./bridges.js";
import { rerank, type ChatFn, type RerankCandidate } from "./reranker.js";

export interface TelemetryEvent {
  kind: string;
  ts: string;
  [k: string]: unknown;
}

/** A reconstructed reach: a recall query and the memory the agent acted on. */
export interface Reach {
  query: string;
  memoryId: string;
}

export function defaultLogDir(): string {
  return process.env.BASTRA_LOG_PATH ?? join(homedir(), ".bastra", "logs");
}

/** Read events-*.jsonl from a log dir, optionally limited to the last `days`. */
export async function readEventLog(logDir: string = defaultLogDir(), days: number | null = null): Promise<TelemetryEvent[]> {
  let files: string[];
  try {
    files = (await readdir(logDir)).filter((f) => f.startsWith("events-") && f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  files.sort();
  const cutoff = days !== null ? Date.now() - days * 24 * 60 * 60 * 1000 : 0;
  const out: TelemetryEvent[] = [];
  for (const f of files) {
    const raw = await readFile(join(logDir, f), "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as TelemetryEvent;
        if (cutoff && new Date(e.ts).getTime() < cutoff) continue;
        out.push(e);
      } catch {
        /* skip malformed line */
      }
    }
  }
  return out;
}

/**
 * Join recall/hook_recall (which carry the query) with recall_episode (which carries
 * the acted-on memory) by recall_id, yielding the (query → memory) reaches a bridge is
 * mined from. Only acted_on episodes count — the agent's terminal pick.
 */
export function reconstructReaches(events: TelemetryEvent[]): Reach[] {
  const queryByRecallId = new Map<string, string>();
  for (const e of events) {
    if ((e.kind === "hook_recall" || e.kind === "recall") && typeof e.recall_id === "string" && typeof e.query === "string") {
      queryByRecallId.set(e.recall_id, e.query);
    }
  }
  const reaches: Reach[] = [];
  for (const e of events) {
    if (e.kind === "recall_episode" && e.acted_on === true && typeof e.recall_id === "string" && typeof e.memory_id === "string") {
      const query = queryByRecallId.get(e.recall_id);
      if (query) reaches.push({ query, memoryId: e.memory_id });
    }
  }
  return reaches;
}

export interface HarvestResult {
  /** Minted bridges, deduped by id with evidence = how many reaches produced each. */
  bridges: Bridge[];
  /** Reaches seen / reaches that produced a usable (far enough, language-detected) bridge. */
  reaches: number;
  minted: number;
}

/**
 * Mint bridges from reaches. `getMemoryTerms(id)` supplies a memory's distinctive
 * vocabulary (the near terms); a bridge only forms when the query is far enough that
 * some of those terms are NOT already in the query (mintBridge enforces this). Repeated
 * reaches onto the same bridge accumulate evidence.
 */
export function harvestBridges(reaches: Reach[], getMemoryTerms: (memoryId: string) => string[], date?: string): HarvestResult {
  const byId = new Map<string, Bridge>();
  for (const r of reaches) {
    const terms = getMemoryTerms(r.memoryId);
    if (terms.length === 0) continue;
    const b = mintBridge(r.query, terms, detectLanguage(r.query).lang, date);
    if (!b) continue;
    const existing = byId.get(b.id);
    if (existing) existing.evidence += 1;
    else byId.set(b.id, b);
  }
  return { bridges: [...byId.values()], reaches: reaches.length, minted: byId.size };
}

// ─── Teacher 2: deep harvest over the far slice (#120 / #121) ────────────────

/** A logged recall and the deeper candidate pool (#121) behind it. */
export interface CandidatePoolEntry {
  query: string;
  pool: { id: string; score: number }[];
  topScore: number;
  /** In welchem Raum `topScore` liegt. `null` = das Event hat es nicht gesagt
   *  (Altbestand). Der Far-Harvest schneidet bei einem absoluten Score (100),
   *  und dieser Schnitt bedeutet nur auf der fusionierten Skala etwas. */
  scoreKind: "rrf" | "bm25" | null;
  /** Die ARMMENGE und die FORMELVERSION hinter `topScore`, sofern das Event sie
   *  genannt hat. Optional, damit ältere Aufrufer (scripts/) weiter minimale
   *  Einträge bauen können. */
  scoreArms?: string[] | null;
  scoreVersion?: string | null;
}

/** Die vollständige Signatur eines Score-Raums: Kind + Formelversion + Armmenge. */
interface ScoreSpace {
  kind: "rrf" | "bm25" | null;
  version: string | null;
  arms: string[] | null;
}

/**
 * Sind zwei Scores im selben Raum — und damit gegeneinander lesbar?
 *
 * Codex-Gegenreview (P1): Vorher wurde nur `score_kind` verglichen. Gemessen:
 * `top_score: 150` aus drei Armen (bm25+commons+vector, Skala bis 241.803)
 * gegen einen Pool mit Spitzenwert 80 aus zwei Armen (bm25+vector, Skala bis
 * 163.934) — beide melden `"rrf"`, also galten sie als derselbe Raum und die
 * 150 wurde als Pool-Score gelesen. Ein eigentlich schwacher persönlicher
 * Recall lief damit nie ins Bridge-Reranking: der `< maxScore`-Schnitt sah
 * einen starken Treffer, den es im Pool-Raum gar nicht gab.
 *
 * FAIL-CLOSED: Ein fehlendes Feld heißt „unbekannt", nicht „gleich". Alte
 * Events ohne Armmenge sind deshalb NICHT vergleichbar — der Preis ist, dass
 * für sie der Pool-Spitzenwert statt `top_score` gilt, und der liegt garantiert
 * im Pool-Raum.
 */
function sameScoreSpace(a: ScoreSpace, b: ScoreSpace): boolean {
  if (a.kind === null || b.kind === null || a.kind !== b.kind) return false;
  if (a.arms === null || b.arms === null) return false;
  if (a.arms.length !== b.arms.length || a.arms.some((arm, i) => arm !== b.arms![i])) return false;
  // Auf roher Skala gibt es keine Formelversion — dort ist „beide ohne" der
  // korrekte Zustand, nicht eine Lücke. Auf `rrf` MUSS sie dastehen und
  // übereinstimmen, sonst hat die Zahl zwischen den beiden Zeilen ihre
  // Bedeutung geändert.
  if (a.kind === "rrf") return a.version !== null && a.version === b.version;
  return a.version === null && b.version === null;
}

/** Liest eine Score-Signatur aus einem Telemetrie-Event, unbekannt = `null`. */
function readScoreSpace(
  e: TelemetryEvent,
  kindKey: string,
  versionKey: string,
  armsKey: string,
): ScoreSpace {
  const rawKind = e[kindKey];
  const rawVersion = e[versionKey];
  const rawArms = e[armsKey];
  return {
    kind: rawKind === "rrf" || rawKind === "bm25" ? rawKind : null,
    version: typeof rawVersion === "string" ? rawVersion : null,
    arms:
      Array.isArray(rawArms) && rawArms.every((x) => typeof x === "string") ? (rawArms as string[]) : null,
  };
}

/** Pull (query → deeper candidate pool) entries from recall/hook_recall events (#121). */
export function extractCandidatePools(events: TelemetryEvent[]): CandidatePoolEntry[] {
  const out: CandidatePoolEntry[] = [];
  for (const e of events) {
    if ((e.kind !== "recall" && e.kind !== "hook_recall") || typeof e.query !== "string" || !Array.isArray(e.candidate_pool)) {
      continue;
    }
    const pool = (e.candidate_pool as { id?: unknown; score?: unknown }[])
      .filter((p) => typeof p.id === "string" && typeof p.score === "number")
      .map((p) => ({ id: p.id as string, score: p.score as number }));
    if (pool.length === 0) continue;
    // Zweiter Gegenreview: `top_score` und `candidate_pool` können aus
    // verschiedenen Räumen kommen (Commons-Recall: der Pool aus der
    // persönlichen Suche, `top_score` aus der Liste danach). Nur wenn beide
    // denselben Raum nennen, darf `top_score` gegen den Pool gelesen werden;
    // sonst zählt der Pool-Spitzenwert, der garantiert im Pool-Raum liegt.
    //
    // Codex-Gegenreview (P1): „denselben Raum" hieß hier nur `score_kind`, und
    // das ist zu grob. Gemessen: top_score 150 (drei Arme) gegen pool top 80
    // (zwei Arme), beide `"rrf"` — extractCandidatePools() meldete topScore 150
    // und der Far-Harvest hielt einen schwachen Recall für einen starken.
    // Verglichen wird jetzt die VOLLE Signatur, und fehlende Felder gelten als
    // unbekannt (fail-closed), nicht als gleich.
    const topSpace = readScoreSpace(e, "score_kind", "score_version", "score_arms");
    const poolSpace = readScoreSpace(
      e,
      "candidate_pool_score_kind",
      "candidate_pool_score_version",
      "candidate_pool_score_arms",
    );
    const useTop = sameScoreSpace(topSpace, poolSpace) && typeof e.top_score === "number";
    const space = useTop ? topSpace : poolSpace;
    out.push({
      query: e.query,
      pool,
      topScore: useTop ? (e.top_score as number) : pool[0].score,
      scoreKind: space.kind,
      scoreArms: space.arms,
      scoreVersion: space.version,
    });
  }
  return out;
}

export interface MemoryInfo {
  /** Title + summary the reranker judges against the query. */
  text: string;
  /** Distinctive vocabulary that becomes a bridge's expansion terms. */
  terms: string[];
}

export interface DeepHarvestResult extends HarvestResult {
  /** How many far cases were actually sent to the reranker (LLM calls). */
  judged: number;
}

/**
 * Teacher 2: over the logged far slice, ask the reranker which pooled candidate truly
 * answers each HARD query (one whose top hit was weaker than `maxScore` — the unsure
 * cases). When the reranker rescues a LOW-ranked candidate (chosenRank > 1), that is a
 * genuine far→near pair, so mint a bridge from it. Confidence gate: the reranker must
 * pick a specific candidate (not "none"); `maxJudge` caps LLM work per run.
 */
export async function harvestFarBridges(
  pools: CandidatePoolEntry[],
  getMemoryInfo: (id: string) => MemoryInfo | null,
  chat: ChatFn,
  opts: { maxScore?: number; maxJudge?: number; date?: string; onProgress?: (done: number, total: number) => void } = {},
): Promise<DeepHarvestResult> {
  const maxScore = opts.maxScore ?? 100; // only cases without a strong (REQUIRED-band) hit
  const maxJudge = opts.maxJudge ?? 50;
  const byId = new Map<string, Bridge>();
  let judged = 0;
  for (const entry of pools) {
    if (judged >= maxJudge) break;
    // Zweiter Gegenreview: `maxScore` ist ein absoluter Schnitt auf der
    // fusionierten Skala. Auf rohem BM25 (offen, sechsstellig) reißt ihn jeder
    // Treffer — der ganze Recall sähe „zuversichtlich" aus und würde nie
    // geprüft, während umgekehrt kein einziger echter far-Fall erkannt wird.
    // Ein Event, das seinen Raum ausdrücklich als `bm25` nennt, wird deshalb
    // übersprungen. `null` (Altbestand ohne das Feld) bleibt wie bisher drin —
    // fail-closed hieße hier, den kompletten historischen Log wegzuwerfen.
    if (entry.scoreKind === "bm25") continue;
    if (entry.topScore >= maxScore) continue; // already a confident hit → not a far case
    const lang = detectLanguage(entry.query).lang;
    if (!lang) continue;
    const candidates: RerankCandidate[] = [];
    for (const p of entry.pool) {
      const info = getMemoryInfo(p.id);
      if (info) candidates.push({ id: p.id, text: info.text });
    }
    if (candidates.length < 2) continue;
    judged++;
    opts.onProgress?.(judged, Math.min(maxJudge, pools.length));
    const { bestId, chosenRank } = await rerank(entry.query, candidates, chat);
    if (!bestId || chosenRank === null || chosenRank <= 1) continue; // none, or top already → no rescue
    const info = getMemoryInfo(bestId);
    if (!info) continue;
    const b = mintBridge(entry.query, info.terms, lang, opts.date);
    if (!b) continue;
    const existing = byId.get(b.id);
    if (existing) existing.evidence += 1;
    else byId.set(b.id, b);
  }
  return { bridges: [...byId.values()], reaches: pools.length, minted: byId.size, judged };
}

/** Atomically write each bridge to <root>/bridges/<lang>/<id>.json. Returns count written. */
export async function writeBridges(rootDir: string, bridges: Bridge[]): Promise<number> {
  let written = 0;
  for (const b of bridges) {
    const dir = join(rootDir, "bridges", b.lang);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${b.id}.json`);
    const tmp = `${path}.tmp-${randomBytes(4).toString("hex")}`;
    await writeFile(tmp, JSON.stringify(b, null, 2) + "\n", "utf8");
    await rename(tmp, path);
    written++;
  }
  return written;
}

/** True when a bridges/ dir already exists under root (for status/CLI messaging). */
export function hasBridgeDir(rootDir: string): boolean {
  return existsSync(join(rootDir, "bridges"));
}
