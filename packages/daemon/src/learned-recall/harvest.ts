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
import { readdir, readFile, mkdir, writeFile, rename, unlink, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { bridgeLanguage } from "./language.js";
import { isExpiredUnconfirmed, isMachineVocabulary, mintBridge, UNCONFIRMED_BRIDGE_TTL_DAYS, type Bridge } from "./bridges.js";
import { rerank, type ChatFn, type RerankCandidate } from "./reranker.js";
import { testRunLogDir } from "../env.js";

export interface TelemetryEvent {
  kind: string;
  ts: string;
  [k: string]: unknown;
}

/** A reconstructed reach: a recall query and the memory the agent acted on. */
export interface Reach {
  query: string;
  memoryId: string;
  /** #672: when the acted-on episode happened — seeds a bridge's first_seen,
   *  so a reach already old at mint time does not get a fresh 30-day window. */
  ts?: string;
}

export function defaultLogDir(): string {
  return process.env.BASTRA_LOG_PATH ?? testRunLogDir() ?? join(homedir(), ".bastra", "logs");
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

// ─── Query origin (#704) ────────────────────────────────────────────────────

/**
 * #704: who wrote a logged recall query.
 * - `owner`: a prompt the person typed (prompt lane).
 * - `agent`: an explicit `recall` the model called over MCP.
 * - `tool`: built by a tool lane from tool input (write, bash, todo, session, stop).
 * - `system`: a harness-injected turn (task notification, teammate or
 *   cross-session message, subagent hand-back).
 * - `unknown`: the event names neither an origin nor a lane.
 */
export type QueryOrigin = "owner" | "agent" | "tool" | "system" | "unknown";

/** #704: the origins a bridge may learn from. Owner prompts and explicit MCP
 *  recalls are phrasings someone chose for a question. Tool-lane queries are
 *  assembled from tool input (paths, commands, file bodies) and recur with the
 *  work, not with the question — #704 leaves their status open, so they do not
 *  count until a measurement says they should. */
const BRIDGE_TEACHING_ORIGINS: ReadonlySet<QueryOrigin> = new Set<QueryOrigin>(["owner", "agent"]);

/** Harness turns that reach the prompt lane as if typed (#703, #704). The
 *  prompt lane gates them since #703; older log rows still carry them. */
const SYSTEM_TURN_PREFIXES = [
  "<task-notification",
  "<teammate-message",
  "<agent-message",
  "<cross-session-message",
  "[Subagent hand-back]",
  "Another Claude session sent a message",
];

export function isSystemTurnText(text: string): boolean {
  const t = text.trimStart();
  return SYSTEM_TURN_PREFIXES.some((p) => t.startsWith(p));
}

const TOOL_HOOK_SOURCES = new Set(["pre-tool", "session", "stop", "bash-pre", "bash-fail", "todo", "session-context"]);

/**
 * #704: the origin of a logged recall query, read robustly from what the event
 * carries. An explicit `origin`/`query_origin` field wins (none is written on
 * recall events today; a missing field means unknown, never owner). Otherwise
 * the query text is checked for a harness wrapper, then the lane:
 * `dimensions.hook_source` (since #263), else `tool_name` (older rows:
 * `UserPromptSubmit` = prompt lane, `mcp-forwarder` = MCP). An MCP `recall`
 * event is the model's own call.
 */
export function queryOrigin(e: TelemetryEvent): QueryOrigin {
  const dims = typeof e.dimensions === "object" && e.dimensions !== null ? (e.dimensions as Record<string, unknown>) : {};
  const explicit = [e.origin, e.query_origin, dims.origin].find((v) => typeof v === "string") as string | undefined;
  if (explicit === "system") return "system";
  if (explicit === "tool") return "tool";
  if (typeof e.query === "string" && isSystemTurnText(e.query)) return "system";
  if (explicit === "owner" || explicit === "user") return "owner";
  if (explicit === "agent") return "agent";
  if (e.kind === "recall") return "agent";
  const source = dims.hook_source;
  if (source === "prompt") return "owner";
  if (source === "mcp") return "agent";
  if (typeof source === "string" && TOOL_HOOK_SOURCES.has(source)) return "tool";
  if (e.tool_name === "UserPromptSubmit") return "owner";
  if (e.tool_name === "mcp-forwarder") return "agent";
  if (typeof e.tool_name === "string" && e.tool_name.length > 0) return "tool";
  return "unknown";
}

/** #704: may a bridge be minted from this event's query? */
export function teachesBridges(e: TelemetryEvent): boolean {
  return BRIDGE_TEACHING_ORIGINS.has(queryOrigin(e));
}

/**
 * #704: the log as the bridge teachers may see it — recall/hook_recall rows
 * whose query does not teach bridges are dropped, everything else stays. Applied
 * by the two teachers (in-band mint, `bastra bridges harvest`), not inside
 * reconstructReaches / extractCandidatePools: the curator counts reaches per
 * memory (reflex promotion, intake adoption) and the pool scripts read every
 * recall, and neither depends on who phrased the query.
 */
export function bridgeTeachingEvents(events: TelemetryEvent[]): TelemetryEvent[] {
  return events.filter((e) => (e.kind !== "hook_recall" && e.kind !== "recall") || teachesBridges(e));
}

/**
 * Join recall/hook_recall (which carry the query) with recall_episode (which carries
 * the acted-on memory) by recall_id, yielding the (query → memory) reaches a bridge is
 * mined from. Only acted_on episodes count — the agent's terminal pick. The bridge
 * teachers pass bridgeTeachingEvents(events) (#704).
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
      if (query) reaches.push({ query, memoryId: e.memory_id, ...(typeof e.ts === "string" ? { ts: e.ts } : {}) });
    }
  }
  return reaches;
}

export interface HarvestResult {
  /** Minted bridges, deduped by id with evidence = how many reaches produced each. */
  bridges: Bridge[];
  /** Reaches seen / reaches that produced a usable (far enough) bridge. */
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
    const b = mintBridge(r.query, terms, bridgeLanguage(r.query), date);
    if (!b) continue;
    // #672: first_seen = the earliest reach behind the bridge (ISO strings of
    // the same format compare chronologically).
    const reachTs = r.ts !== undefined && Number.isFinite(Date.parse(r.ts)) ? new Date(r.ts).toISOString() : undefined;
    const existing = byId.get(b.id);
    if (existing) {
      existing.evidence += 1;
      if (reachTs && (!existing.first_seen || reachTs < existing.first_seen)) existing.first_seen = reachTs;
    } else byId.set(b.id, reachTs ? { ...b, first_seen: reachTs } : b);
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
    // #707: the language only files the bridge; an undetected one is "und".
    const lang = bridgeLanguage(entry.query);
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

/** Atomically write each bridge to <root>/bridges/<lang>/<id>.json. Returns count written.
 *
 *  #672: a rewrite merges with the file already there. `first_seen` keeps the
 *  earliest stamp (a bridge's expiry clock never restarts), and `evidence`
 *  never drops below what the file already carried: the mint recounts from a
 *  log that retention trims, so a lower recount means "reach aged out of the
 *  log", not "bridge disproven" — a confirmed bridge stays confirmed. */
export async function writeBridges(rootDir: string, bridges: Bridge[], now: Date = new Date()): Promise<number> {
  let written = 0;
  for (const b of bridges) {
    // #129: an archived bridge is retired. Its reaches can still sit in the
    // log; recounting them must not bring it back — moving the file does.
    if (existsSync(archivedBridgePath(rootDir, b.lang, b.id))) continue;
    const dir = join(rootDir, "bridges", b.lang);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${b.id}.json`);
    const prior = await readBridgeFile(path);
    const stamps = [prior?.first_seen, b.first_seen].filter((s): s is string => typeof s === "string" && Number.isFinite(Date.parse(s)));
    stamps.sort((x, y) => Date.parse(x) - Date.parse(y));
    const merged: Bridge = {
      ...b,
      evidence: Math.max(b.evidence, typeof prior?.evidence === "number" ? prior.evidence : 0),
      first_seen: stamps[0] ?? now.toISOString(),
      // #129: a fresh recount is not an outcome — a demotion survives the rewrite.
      ...(typeof prior?.demoted_at === "string" ? { demoted_at: prior.demoted_at } : {}),
    };
    await writeBridgeFileAtomic(path, merged);
    written++;
  }
  return written;
}

/** Atomic write of one bridge file (tmp + rename). */
export async function writeBridgeFileAtomic(path: string, b: Bridge): Promise<void> {
  const tmp = `${path}.tmp-${randomBytes(4).toString("hex")}`;
  await writeFile(tmp, JSON.stringify(b, null, 2) + "\n", "utf8");
  await rename(tmp, path);
}

export async function readBridgeFile(path: string): Promise<Partial<Bridge> | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Partial<Bridge>) : null;
  } catch {
    return null; // no file yet, or corrupt → written fresh
  }
}

/**
 * #672: drop every unconfirmed local bridge that waited longer than the TTL for
 * its second reach (isExpiredUnconfirmed). Confirmed bridges, cloned/contributed
 * bridges and pre-#672 files without first_seen are never touched. Runs with
 * every mint pass. Returns how many files were removed.
 */
export async function pruneUnconfirmedBridges(
  rootDir: string,
  now: Date = new Date(),
  ttlDays: number = UNCONFIRMED_BRIDGE_TTL_DAYS,
): Promise<number> {
  const base = join(rootDir, "bridges");
  let langs: string[];
  try {
    langs = await readdir(base);
  } catch {
    return 0; // no bridges dir yet
  }
  let pruned = 0;
  for (const lang of langs) {
    if (lang === "archive") continue; // retired bridges (#704/#129) do not expire again
    let files: string[];
    try {
      files = (await readdir(join(base, lang))).filter((f) => f.endsWith(".json"));
    } catch {
      continue; // not a directory
    }
    for (const f of files) {
      const path = join(base, lang, f);
      const b = await readBridgeFile(path);
      if (!b || typeof b.evidence !== "number") continue;
      if (!isExpiredUnconfirmed(b as Pick<Bridge, "evidence" | "first_seen" | "verifier">, now, ttlDays)) continue;
      try {
        await unlink(path);
        pruned++;
      } catch {
        /* already gone — another pass got there first */
      }
    }
  }
  return pruned;
}

/** #704/#129: where a retired bridge goes — <root>/bridges/archive/<lang>/<id>.json.
 *  Out of the pool (BridgePool.load reads language dirs only), not deleted:
 *  moving the file back restores it. */
export function archivedBridgePath(rootDir: string, lang: string, id: string): string {
  return join(rootDir, "bridges", "archive", lang, `${id}.json`);
}

/** Move one bridge file to archive/ and append a line to archive/log.jsonl.
 *  Returns false when the move failed (file gone, another pass got there). */
export async function archiveBridgeFile(
  rootDir: string,
  path: string,
  b: Pick<Bridge, "id" | "lang" | "trigger_terms">,
  reason: string,
  now: Date,
): Promise<boolean> {
  try {
    await mkdir(join(rootDir, "bridges", "archive", b.lang), { recursive: true });
    await rename(path, archivedBridgePath(rootDir, b.lang, b.id));
  } catch {
    return false;
  }
  await appendBridgeLog(rootDir, "archive", b, reason, now);
  return true;
}

/** One line in bridges/archive/log.jsonl per retirement step (#704/#129):
 *  archive, demote, restore. Never throws — the state change is what matters. */
export async function appendBridgeLog(
  rootDir: string,
  action: "archive" | "demote" | "restore",
  b: Pick<Bridge, "id" | "lang" | "trigger_terms">,
  reason: string,
  now: Date,
): Promise<void> {
  try {
    await mkdir(join(rootDir, "bridges", "archive"), { recursive: true });
    const line = { ts: now.toISOString(), action, id: b.id, lang: b.lang, reason, trigger_terms: b.trigger_terms };
    await appendFile(join(rootDir, "bridges", "archive", "log.jsonl"), JSON.stringify(line) + "\n", "utf8");
  } catch {
    /* observability must never break the pass */
  }
}

/** Every local bridge file under <root>/bridges/<lang>/ (archive/ excluded). */
export async function listLocalBridgeFiles(rootDir: string): Promise<{ path: string; bridge: Partial<Bridge> }[]> {
  const base = join(rootDir, "bridges");
  let langs: string[];
  try {
    langs = await readdir(base);
  } catch {
    return [];
  }
  const out: { path: string; bridge: Partial<Bridge> }[] = [];
  for (const lang of langs) {
    if (lang === "archive") continue;
    let files: string[];
    try {
      files = (await readdir(join(base, lang))).filter((f) => f.endsWith(".json"));
    } catch {
      continue; // not a directory
    }
    for (const f of files) {
      const path = join(base, lang, f);
      const bridge = await readBridgeFile(path);
      if (bridge) out.push({ path, bridge });
    }
  }
  return out;
}

/**
 * #704: move every local bridge whose trigger is mostly machine vocabulary
 * (isMachineVocabulary) to archive/. Such a bridge was minted from harness text
 * before the origin gate existed; the mint can no longer produce one, so after
 * the first pass this finds nothing. Contributed (verifier) bridges are not
 * ours to move. Returns how many were archived.
 */
export async function archiveMachineBridges(rootDir: string, now: Date = new Date()): Promise<number> {
  let archived = 0;
  for (const { path, bridge } of await listLocalBridgeFiles(rootDir)) {
    if (bridge.verifier !== undefined || typeof bridge.id !== "string" || typeof bridge.lang !== "string") continue;
    if (!Array.isArray(bridge.trigger_terms) || !isMachineVocabulary(bridge.trigger_terms)) continue;
    const ok = await archiveBridgeFile(
      rootDir,
      path,
      { id: bridge.id, lang: bridge.lang, trigger_terms: bridge.trigger_terms },
      "machine-vocabulary trigger (#704)",
      now,
    );
    if (ok) archived++;
  }
  return archived;
}

/** True when a bridges/ dir already exists under root (for status/CLI messaging). */
export function hasBridgeDir(rootDir: string): boolean {
  return existsSync(join(rootDir, "bridges"));
}
