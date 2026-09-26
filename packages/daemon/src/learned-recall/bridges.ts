/**
 * Shared learned-recall bridges (#120) — the data model + pool + query expansion.
 *
 * A BRIDGE is a language-tagged vocabulary-expansion rule, NOT a memory. It says:
 * "in language L, a query phrased with `trigger_terms` should also search for
 * `expansion_terms`." That is the whole privacy contract — a bridge carries only
 * term lists and a language, never a memory id, body, or any vault content. It is
 * the lexical floor of zzallirog's "drag far next to near" idea: instead of an
 * encoder learning the far↔near map, a bridge widens the BM25 surface so a
 * far-worded query reaches the memory the contributor already proved it resolves to.
 *
 * Pools are partitioned by language (product requirement): a German bridge only
 * ever fires for a query detected as German. Bridges are loaded read-only from a
 * git-synced clone (mirroring Bastra Commons) and never written there by the daemon.
 *
 * The shared/contribution path is privacy-sensitive: scrubBridge() is a best-effort
 * filter, and the real guarantee is the same PR review gate Commons uses. The local
 * pool (this machine only) and the contribution path are independent — toggle off
 * means neither runs.
 *
 * Wiring status (#120, staged): BridgePool.load + expandQuery are wired into recall.
 * mintBridge (harvest a bridge from a successful recall) and scrubBridge (contribute)
 * are implemented and tested but NOT yet wired into the live telemetry/contribution
 * loop — that step depends on #121 (the below-floor far slice is not logged yet). So
 * with the layer enabled but no cloned bridges repo, the pool is empty and the layer
 * is a deliberate no-op.
 */
import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { capAtWordBoundary } from "@bastra-recall/core";
import { detectLanguage, isSupportedLanguage, type SupportedLanguage } from "./language.js";

export interface Bridge {
  /** Deterministic dedup key = hash(lang + sorted trigger + sorted expansion). */
  id: string;
  /** Language of the far query this bridge serves; selects which pool it lives in. */
  lang: SupportedLanguage;
  /** Distinctive tokens of the far query — at least two must appear for the
   *  bridge to fire (all of them for a one-term bridge), see MIN_TRIGGER_OVERLAP. */
  trigger_terms: string[];
  /** Vocabulary the bridge adds to a matching query to broaden recall. */
  expansion_terms: string[];
  /** Independent confirmations (verify-loop evidence). 1 when freshly minted;
   *  CONFIRMED_BRIDGE_EVIDENCE or more makes the bridge permanent (#672). */
  evidence: number;
  /** #672: ISO timestamp of the first local write. Optional and additive — files
   *  written before #672 (all confirmed) and cloned Commons bridges have none.
   *  An unconfirmed local bridge older than UNCONFIRMED_BRIDGE_TTL_DAYS by this
   *  stamp is dropped at the next mint pass. */
  first_seen?: string;
  /** Pseudonymous contributor hash (Commons verifierId shape). Absent for local mints. */
  verifier?: string;
  date?: string;
}

// A distinctive term: ≥4 chars, not a stopword-ish filler, deduped. Mirrors the
// spirit of tool-handlers' distinctiveTokensForActedOn, kept independent to avoid
// a circular import. The point is to drop noise words so triggers/expansions are
// specific enough to be useful and safe-ish to share.
const MIN_TERM_LEN = 4;
const GENERIC_TERMS = new Set([
  "this", "that", "with", "from", "have", "should", "would", "could", "your",
  "what", "when", "where", "which", "about", "into", "code", "file", "files",
  "eine", "einen", "einem", "einer", "dann", "noch", "auch", "sehr", "wenn",
  "wieder", "schon", "nicht", "machen", "soll", "sollte", "werden", "diese",
  "dieser", "dieses", "beim", "dass", "weil",
  // 20.08.: Alltagswörter, die der In-band-Mint als Trigger geprägt hatte —
  // „bitte" allein zog bei jedem höflichen Prompt zehn Fremdterme nach. Ein
  // Trigger muss ein Thema benennen, nicht eine Satzform.
  "bitte", "habe", "haben", "hast", "hatte", "kann", "kannst", "können", "muss",
  "müssen", "will", "willst", "möchte", "gerne", "jetzt", "erstmal", "nochmal",
  "einmal", "heute", "morgen", "gestern", "hier", "dort", "mehr", "alles",
  "alle", "allem", "etwas", "nichts", "immer", "stand", "steht", "liegt",
  "gibt", "kurz", "kurze", "neue", "neuen", "neues", "neuer", "fertig",
  "aktuell", "aktuelle", "aktueller", "aktuellen", "geschrieben", "gemacht",
  "schauen", "schau", "bauen", "baue", "prüfen", "prüfe", "nutzen", "nutze",
  "danke", "hallo", "okay", "genau", "passt", "sonst", "oder", "aber", "doch",
  "also", "dafür", "damit", "darauf", "davon", "dazu", "denn", "ohne", "über",
  "unter", "nach", "dein", "deine", "deinen", "mein", "meine", "meinen",
  "sind", "wird", "wurde", "waren", "gewesen", "worden",
  "please", "just", "need", "needs", "want", "wants", "make", "makes", "like",
  "more", "some", "then", "there", "here", "will", "been", "were", "they",
  "them", "than", "only", "very", "really", "thing", "things", "something",
  "going", "know", "think", "sure", "done", "right", "still", "again",
  "today", "first", "next", "last", "take", "look", "check", "help", "each",
  "every", "much", "many", "most", "such", "same",
]);

/** Extract deduped distinctive terms from a free-text string. */
/** Quality track (#353 addendum): ephemeral tokens — raw tool-call ids,
 *  chat snowflakes, commit shas, date fragments — can never recur in a
 *  future query. A bridge whose trigger carries one is a dead slot; an
 *  expansion carrying one is noise. zzalli measured ~1/3 of a fresh mint
 *  affected. Filtered at the term source, so trigger AND expansion (and the
 *  near-terms overlap check) all stay clean. */
export function isEphemeralTerm(t: string): boolean {
  if (/^\d{5,}$/.test(t)) return true; // snowflakes, timestamps, big counters
  if (/^(19|20)\d{2}$/.test(t)) return true; // bare years — ISO-date fragments
  if (/^(?=.*\d)[0-9a-f]{6,}$/.test(t)) return true; // hex ids: shas, uuid/tool-call segments
  if (/^(?=.*\d)[a-z0-9]{12,}$/.test(t)) return true; // long alnum ids (base36-ish)
  return false;
}

export function distinctiveTerms(text: string): string[] {
  const seen = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-zäöüß0-9]+/i)) {
    if (raw.length < MIN_TERM_LEN) continue;
    if (GENERIC_TERMS.has(raw)) continue;
    if (isEphemeralTerm(raw)) continue;
    seen.add(raw);
  }
  return [...seen];
}

/** Stable id so the same bridge from two contributors dedupes to one file. */
export function bridgeId(lang: string, trigger: string[], expansion: string[]): string {
  const norm = (xs: string[]): string => [...new Set(xs.map((x) => x.toLowerCase()))].sort().join(" ");
  return createHash("sha256").update(`${lang}\n${norm(trigger)}\n${norm(expansion)}`).digest("hex").slice(0, 16);
}

// ─── Minting (local: a successful far recall → a bridge) ─────────────────────

const MAX_TRIGGER_TERMS = 8;
const MAX_EXPANSION_TERMS = 10;

/**
 * Build a bridge from a successful recall: the far query's distinctive terms become
 * the trigger, and the resolved memory's distinctive terms (those NOT already in the
 * query) become the expansion — the near vocabulary the far query failed to use.
 * Returns null when there is no usable signal or the language could not be detected
 * (no language → no pool to put it in).
 */
export function mintBridge(
  query: string,
  memoryTerms: string[],
  lang: SupportedLanguage | null = detectLanguage(query).lang,
  date?: string,
): Bridge | null {
  if (!lang) return null;
  const trigger = distinctiveTerms(query).slice(0, MAX_TRIGGER_TERMS);
  if (trigger.length === 0) return null;
  const triggerSet = new Set(trigger);
  const expansion = memoryTerms
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= MIN_TERM_LEN && !GENERIC_TERMS.has(t) && !triggerSet.has(t))
    .filter((t, i, a) => a.indexOf(t) === i)
    .slice(0, MAX_EXPANSION_TERMS);
  if (expansion.length === 0) return null;
  return {
    id: bridgeId(lang, trigger, expansion),
    lang,
    trigger_terms: trigger,
    expansion_terms: expansion,
    evidence: 1,
    ...(date ? { date } : {}),
  };
}

// ─── Scrub (contribution: best-effort privacy filter before a bridge leaves) ──

// Terms that look like identifiers, paths, secrets, or proper-noun-ish leakage are
// dropped before a bridge can be contributed. This is BEST-EFFORT — the real
// guarantee is the PR review gate (a human sees every contributed bridge), same as
// Commons. We never auto-egress; this only shapes what a deliberate contribution
// would carry.
const LOOKS_SENSITIVE = [
  /\d/, // any digit → ids, versions, dates, ticket numbers
  /[/\\.@:]/, // path/email/url separators
  /_/, // snake_case identifiers
  /^[a-f0-9]{8,}$/i, // hex hashes
];
const MIN_SHARE_TERMS = 2;
const MAX_SHARE_TERM_LEN = 24;

function scrubTerms(terms: string[]): string[] {
  return terms.filter((t) => t.length <= MAX_SHARE_TERM_LEN && !LOOKS_SENSITIVE.some((re) => re.test(t)));
}

/**
 * Best-effort scrub of a bridge for contribution. Returns null when too little
 * survives to be a useful, safe bridge — that bridge simply is not shared. The
 * surviving bridge still passes through PR review before it is authoritative.
 */
export function scrubBridge(b: Bridge): Bridge | null {
  const trigger = scrubTerms(b.trigger_terms);
  const expansion = scrubTerms(b.expansion_terms);
  if (trigger.length < 1 || expansion.length < MIN_SHARE_TERMS) return null;
  return { ...b, id: bridgeId(b.lang, trigger, expansion), trigger_terms: trigger, expansion_terms: expansion };
}

// ─── Pool (read-only, language-partitioned, loaded from a clone) ─────────────

const MAX_QUERY_EXPANSION = 12; // cap how much a single query can be widened

/** 20.08.: one shared word is not a topic. A bridge fires when at least two of
 *  its trigger terms appear in the query — a single term („bitte", „nutzen",
 *  „konventionen") dragged up to 12 foreign terms into unrelated prompts and
 *  pushed the memories the prompt was actually about out of the top-k. A
 *  one-term bridge still fires on its one term: it was minted that specific. */
const MIN_TRIGGER_OVERLAP = 2;
const requiredOverlap = (b: Bridge): number => Math.min(MIN_TRIGGER_OVERLAP, b.trigger_terms.length);
function triggerOverlap(b: Bridge, queryTerms: Set<string>): number {
  let n = 0;
  for (const t of b.trigger_terms) if (queryTerms.has(t)) n++;
  return n;
}

/** Evidence a bridge needs to be written and loaded at all.
 *
 *  20.08. this was 2: the first in-band mint wrote 116 evidence-1 bridges from
 *  single reaches, and a single reach widened queries at full weight. #672
 *  measured the other side: on a normal-volume vault (~300 loads a month) the
 *  same reach rarely repeats — 3,435 minted, 0 written in a month. So a bridge
 *  is now written on its first reach, and the 20.08. risk is carried by two
 *  other rules instead: an unconfirmed bridge widens a query only at reduced
 *  weight (expansionsFor), and it expires unless a second reach confirms it
 *  within UNCONFIRMED_BRIDGE_TTL_DAYS (pruneUnconfirmedBridges). */
export const MIN_BRIDGE_EVIDENCE = 1;

/** #672: from this evidence on a bridge is confirmed — full weight, never expires.
 *  The old write threshold, so every bridge written before #672 is confirmed. */
export const CONFIRMED_BRIDGE_EVIDENCE = 2;

/** #672: how long an unconfirmed bridge may wait for its second reach. 30 days
 *  matches the curator's mining window and the log-retention floor, so a reach
 *  that could confirm it is still in the log for the whole window. */
export const UNCONFIRMED_BRIDGE_TTL_DAYS = 30;

/** #672: reduced weight of an unconfirmed bridge — at most this many of its
 *  expansion terms reach the query (a confirmed bridge may fill all 12 slots). */
const MAX_UNCONFIRMED_EXPANSION = 3;

export function isConfirmedBridge(b: Pick<Bridge, "evidence">): boolean {
  return b.evidence >= CONFIRMED_BRIDGE_EVIDENCE;
}

/** #672: an unconfirmed LOCAL bridge whose first_seen is older than the TTL.
 *  Only bridges this machine stamped can expire: no first_seen (pre-#672 or
 *  cloned) or a verifier (a Commons contribution) is never ours to drop. */
export function isExpiredUnconfirmed(
  b: Pick<Bridge, "evidence" | "first_seen" | "verifier">,
  now: Date,
  ttlDays: number = UNCONFIRMED_BRIDGE_TTL_DAYS,
): boolean {
  if (isConfirmedBridge(b) || b.verifier !== undefined || typeof b.first_seen !== "string") return false;
  const seen = Date.parse(b.first_seen);
  if (!Number.isFinite(seen)) return false;
  return now.getTime() - seen > ttlDays * 24 * 60 * 60 * 1000;
}

/** #672: an unconfirmed bridge must match a larger share of its trigger — at
 *  least half its terms, never fewer than the confirmed rule asks. */
function requiredOverlapFor(b: Bridge): number {
  const base = requiredOverlap(b);
  return isConfirmedBridge(b) ? base : Math.max(base, Math.ceil(b.trigger_terms.length / 2));
}

// #162: the base query is capped BEFORE expansion terms are appended, so the
// appended terms always survive core's downstream QUERY_MAX_CHARS (8000)
// defense cap — otherwise a long base pushes the tail-appended expansions
// past the cap and telemetry claims an expansion that was silently dropped.
// 4000 base + ≤12 terms of ≤24 chars stays far below the core cap.
const MAX_BASE_QUERY_CHARS = 4000;

/**
 * A language-partitioned, read-only set of bridges. Built once at daemon boot from
 * <root>/bridges/<lang>/*.json (mirroring the Commons recipes layout). Never written.
 */
export class BridgePool {
  private constructor(private readonly byLang: Map<SupportedLanguage, Bridge[]>) {}

  static empty(): BridgePool {
    return new BridgePool(new Map());
  }

  /** Load <root>/bridges/<lang>/*.json into per-language buckets. Defensive: skips
   *  corrupt files and unknown languages, never throws. */
  static load(rootDir: string, now: Date = new Date()): BridgePool {
    const byLang = new Map<SupportedLanguage, Bridge[]>();
    const base = join(rootDir, "bridges");
    try {
      for (const langDir of readdirSync(base, { withFileTypes: true })) {
        if (!langDir.isDirectory() || !isSupportedLanguage(langDir.name)) continue;
        const lang = langDir.name;
        const bucket: Bridge[] = [];
        for (const f of readdirSync(join(base, lang))) {
          if (!f.endsWith(".json")) continue;
          try {
            const b = JSON.parse(readFileSync(join(base, lang, f), "utf8")) as Bridge;
            if (!isValidBridge(b) || b.lang !== lang) continue;
            if (b.evidence < MIN_BRIDGE_EVIDENCE) continue;
            // #672: a single reach is trusted only from this machine's own mint,
            // which stamps first_seen. A contributed (verifier-carrying) bridge
            // still needs confirmation, and so do the evidence-1 files the
            // pre-20.08. mint left behind (no first_seen — they stay inert, as
            // they were, instead of coming back without an expiry date).
            if (!isConfirmedBridge(b) && (b.verifier !== undefined || typeof b.first_seen !== "string")) continue;
            // Expired but not yet pruned (the prune runs with the next mint).
            if (isExpiredUnconfirmed(b, now)) continue;
            // Defense-in-depth: a cloned repo is foreign input. Cap term length so
            // no oversized token from a hostile bridge ever reaches the search query
            // (the contribution path scrubs; the load path must not trust more).
            const trigger = b.trigger_terms.filter((t) => t.length <= MAX_SHARE_TERM_LEN);
            const expansion = b.expansion_terms.filter((t) => t.length <= MAX_SHARE_TERM_LEN);
            if (trigger.length === 0 || expansion.length === 0) continue;
            bucket.push({ ...b, trigger_terms: trigger, expansion_terms: expansion });
          } catch {
            /* skip corrupt bridge */
          }
        }
        // Sort once by descending evidence here so the recall hot path (expansionsFor)
        // can iterate directly without re-sorting on every query.
        if (bucket.length > 0) {
          bucket.sort((a, c) => c.evidence - a.evidence);
          byLang.set(lang, bucket);
        }
      }
    } catch {
      /* no bridges dir yet → empty pool */
    }
    return new BridgePool(byLang);
  }

  size(lang?: SupportedLanguage): number {
    if (lang) return this.byLang.get(lang)?.length ?? 0;
    let n = 0;
    for (const b of this.byLang.values()) n += b.length;
    return n;
  }

  languages(): SupportedLanguage[] {
    return [...this.byLang.keys()];
  }

  /**
   * Collect expansion terms from every bridge in `lang` whose trigger overlaps the
   * query. Higher-evidence bridges contribute first; result is deduped, excludes
   * terms already in the query, and is capped. Pure — no detection here.
   */
  expansionsFor(query: string, lang: SupportedLanguage): string[] {
    const bridges = this.byLang.get(lang);
    if (!bridges || bridges.length === 0) return [];
    const queryTerms = new Set(distinctiveTerms(query));
    if (queryTerms.size === 0) return [];
    const added = new Set<string>();
    for (const b of bridges) {
      // bucket is pre-sorted by descending evidence at load time
      if (triggerOverlap(b, queryTerms) < requiredOverlapFor(b)) continue;
      // #672: an unconfirmed bridge adds at most MAX_UNCONFIRMED_EXPANSION new
      // terms; confirmed bridges come first (pre-sorted) and keep full weight.
      const cap = isConfirmedBridge(b) ? MAX_QUERY_EXPANSION : MAX_UNCONFIRMED_EXPANSION;
      let fromThis = 0;
      for (const e of b.expansion_terms) {
        if (fromThis >= cap) break;
        if (!queryTerms.has(e) && !added.has(e)) {
          added.add(e);
          fromThis++;
        }
        if (added.size >= MAX_QUERY_EXPANSION) break;
      }
      if (added.size >= MAX_QUERY_EXPANSION) break;
    }
    return [...added];
  }
}

function isValidBridge(b: unknown): b is Bridge {
  const x = b as Bridge;
  return (
    !!x &&
    typeof x.id === "string" &&
    isSupportedLanguage(x.lang) &&
    Array.isArray(x.trigger_terms) &&
    x.trigger_terms.every((t) => typeof t === "string") &&
    Array.isArray(x.expansion_terms) &&
    x.expansion_terms.every((t) => typeof t === "string") &&
    typeof x.evidence === "number"
  );
}

// ─── Query expansion (the recall-time integration helper) ────────────────────

export interface ExpansionResult {
  /** The query to actually run — original (base capped at MAX_BASE_QUERY_CHARS
   *  when expansions fire), plus any bridge expansion terms appended. */
  query: string;
  /** The language the bridge layer routed on (null = abstained, no expansion). */
  lang: SupportedLanguage | null;
  /** The expansion terms that were appended (empty when none fired). */
  added: string[];
}

/**
 * The single recall-time entry point used by both the MCP recall handler and the
 * hook recall path. Detects the query language (or uses a configured override),
 * consults ONLY the matching language pool, and returns the (possibly widened)
 * query. Local-first/no-op safety: a null pool or an abstained/unsupported language
 * returns the query untouched.
 */
export function expandQuery(
  query: string,
  pool: BridgePool | null | undefined,
  opts: { configuredLang?: SupportedLanguage | null } = {},
): ExpansionResult {
  if (!pool) return { query, lang: null, added: [] };
  const lang = opts.configuredLang ?? detectLanguage(query).lang;
  if (!lang) return { query, lang: null, added: [] };
  const added = pool.expansionsFor(query, lang);
  if (added.length === 0) return { query, lang, added: [] };
  // Trigger-Matching (expansionsFor) sah die VOLLE Query; nur die Basis des
  // zusammengesetzten Suchstrings wird gedeckelt (Wortgrenze, nie im Token),
  // damit die Expansions strukturell vor dem Core-Cap sicher sind (#162).
  const base = capAtWordBoundary(query, MAX_BASE_QUERY_CHARS);
  return { query: `${base} ${added.join(" ")}`, lang, added };
}
