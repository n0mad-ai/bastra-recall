/**
 * The M0 gold set: schema, provenance and the two-step discipline (#262, §19).
 *
 * §19 puts one hard rule on how a gold case may come into existence:
 *
 *   "Beim Formulieren oder Auswählen der Query dürfen Body, Summary und
 *    `recall_when` des Ziel-Memorys nicht geöffnet werden. Die Zuordnung zum
 *    Gold-Memory erfolgt erst danach durch einen getrennten Label-Schritt."
 *
 * That is not paperwork. A paraphrase written while looking at the memory it is
 * supposed to retrieve is a paraphrase of the answer, and measuring retrieval
 * against it measures how well the index finds text derived from itself. The
 * repo's current `PARAPHRASED_CASES` are built exactly that way — their own
 * header says "3-5 paraphrases of its recall_when trigger" — so they cannot
 * serve as the M0 gold set no matter how good the numbers look.
 *
 * The two steps are therefore separate types, not two fields on one object:
 * a `StagedQuery` has provenance and no gold, a `GoldCase` adds the label and
 * the rationale. Nothing here can produce a GoldCase from a memory body,
 * because nothing here ever reads one.
 */
import { createHash } from "node:crypto";

/** §19: the five admissible independent query sources. */
export const ORIGIN_TYPES = [
  "session_transcript",
  "task_text",
  "issue_incident",
  "user_query",
  "second_person",
] as const;
export type OriginType = (typeof ORIGIN_TYPES)[number];

/** §19 expects the retrieval zone a case is expected to resolve in. */
export const ZONES = ["core", "orbit", "outer_orbit", "asteroid_belt"] as const;
export type Zone = (typeof ZONES)[number];

/** C-051/C-057: the two cue axes must stay independently measurable. */
export const CASE_KINDS = ["descriptive", "associative"] as const;
export type CaseKind = (typeof CASE_KINDS)[number];

/** The admissible language buckets — see {@link StagedQuery.lang} on `neutral`. */
export const LANGS = ["de", "en", "mixed", "neutral"] as const;
export type Lang = (typeof LANGS)[number];

/**
 * Real recall traffic that is not a retrieval question.
 *
 * Diagnostic and noise-test runs leave events in the telemetry like any other
 * recall, so they get harvested like any other recall. They are worth keeping —
 * a nonsense string the engine must abstain on is a real test — but they must
 * not share a denominator with questions someone actually asked:
 *
 *   - `body-loss`      one investigation, several runs, one target memory. Four
 *                      ids would weight that memory four times.
 *   - `unique-n`       generator strings with a run counter (`… unique7`).
 *   - `gibberish-probe` keyboard mash and invented words, used to check that
 *                      retrieval abstains instead of reaching.
 *
 * A case carries a group or it does not; the field is optional, so every file
 * written before it existed stays valid and counts as a normal case.
 */
export const PROBE_GROUPS = ["body-loss", "unique-n", "gibberish-probe"] as const;
export type ProbeGroup = (typeof PROBE_GROUPS)[number];

/**
 * Step 1 — a query with its provenance and NO gold label.
 *
 * This is everything that may exist before a memory is opened.
 */
export interface StagedQuery {
  /** Stable id derived from the query text, so re-harvesting is idempotent. */
  id: string;
  query: string;
  origin_type: OriginType;
  /** How the query was independently obtained or formulated (§19). */
  authoring_mode: string;
  /** Privacy-preserving hash of the local origin reference (§19). Raw text stays private. */
  origin_ref_hash: string;
  /**
   * §19 wants German, English and mixed technical language covered.
   *
   * `neutral` is the fourth value the data forced: most hook queries are
   * keyword chains with no function words at all ("memory format schema json
   * yaml markdown frontmatter structure"). Filing those as `mixed` would put
   * 94% of a harvest into one bucket and make the language balance meaningless.
   * They are language-NEUTRAL, and saying so keeps `mixed` for queries that
   * genuinely carry both.
   */
  lang: Lang;
  /** True when the query carries an exact identifier, path or symbol (§19). */
  has_identifier: boolean;
}

/**
 * Step 2 — the label, added afterwards by someone who may read the vault.
 *
 * Kept as a separate type so a staged query cannot silently become a gold case
 * by acquiring a field.
 */
export interface GoldLabel {
  staged_id: string;
  /** Empty when `no_answer` is true — that IS the expected result. */
  expected_ids: string[];
  /** Ids that would also be a correct answer (§19). */
  acceptable_alternatives: string[];
  expected_zone: Zone;
  no_answer: boolean;
  scope: string | null;
  /** Point in time / version view the case is asked against (§19). */
  time_view: string | null;
  /** How deep the retrieval may go to still count as a hit (§19). */
  allowed_retrieval_depth: number;
  /** Why this label is correct (§19). Free prose, and required. */
  rationale: string;
  kind: CaseKind;
  /** C-036: the answer is to NOT apply an existing memory. */
  correct_answer_is_non_application?: boolean;
  /**
   * Set when the query is a diagnostic or noise probe rather than a question
   * anyone asked. Absent on ordinary cases — see {@link PROBE_GROUPS}.
   */
  probe_group?: ProbeGroup;
  labelled_at: string;
  labelled_by: string;
}

export interface GoldCase extends StagedQuery, Omit<GoldLabel, "staged_id"> {}

export interface GoldIssue {
  where: string;
  problem: string;
}

export function stagedId(query: string): string {
  return createHash("sha256").update(query).digest("hex").slice(0, 16);
}

/**
 * Hashes a local origin reference. The raw reference — a transcript path, a log
 * line, a session id — stays on the machine; only this hash travels (§19).
 */
export function originRefHash(reference: string): string {
  return createHash("sha256").update(reference).digest("hex");
}

/**
 * Function words, not marker samples (#423).
 *
 * The first version tested fifteen German words. Any German sentence built from
 * other function words fell through to `neutral` — "Welcher Fehler hat mich
 * einen ganzen Samstag gekostet?" contains not one of the fifteen. Twelve of
 * roughly 68 authored German queries were misfiled that way in a single batch,
 * and the consequence is not cosmetic: the M0 baseline showed language to be a
 * real seam (de R@3 0.544, en 0.400, neutral 0.747), so every German batch was
 * silently donating part of its cases to the easy bucket.
 *
 * Telemetry never exposed this because harvested queries are keyword chains
 * where `neutral` is the correct answer. It only bites once a person writes
 * prose. The lists below are the ~70 most frequent function words per language
 * — the same construction the shipped detector in
 * `packages/daemon/src/learned-recall/language.ts` uses, and for the same
 * reason: function words are high-frequency, language-specific, and survive in
 * fragments where content words do not.
 *
 * Deliberately NOT shared with that detector. It answers a different question —
 * which language POOL a live query may draw from, two-valued with an
 * abstention — while this one assigns a four-valued REPORTING bucket that
 * includes `mixed` and `neutral`. Consolidating them would force one of the two
 * contracts onto the other.
 */
const DE_WORDS = new Set([
  "aber", "alle", "als", "am", "auch", "auf", "aus", "bei", "beim", "bin", "bis",
  "da", "damit", "dann", "darf", "das", "dass", "dem", "den", "der", "des", "die",
  "diese", "dieser", "doch", "dort", "du", "durch", "ein", "eine", "einem",
  "einen", "einer", "eines", "er", "es", "für", "ganz", "ganzen", "gegen", "gibt",
  "hat", "hatte", "habe", "haben", "hier", "ich", "ihm", "ihn", "ihr", "im", "in",
  "ist", "kann", "kein", "keine", "man", "mich", "mir", "mit", "muss", "nach",
  "nicht", "noch", "nur", "ob", "oder", "ohne", "schon", "sein", "seine", "sich",
  "sie", "sind", "soll", "sollte", "über", "um", "und", "uns", "unter", "vom",
  "von", "vor", "war", "waren", "warum", "was", "wann", "weil", "welche",
  "welcher", "welches", "wenn", "wer", "wie", "wieder", "wir", "wird", "wo",
  "wurde", "würde", "zu", "zum", "zur", "trotzdem", "übrig",
]);

const EN_WORDS = new Set([
  "about", "after", "against", "all", "also", "am", "an", "and", "any", "are",
  "as", "at", "be", "because", "been", "before", "both", "but", "by", "can", "in",
  "cannot", "did", "do", "does", "each", "few", "for", "from", "had", "has",
  "have", "he", "her", "here", "his", "how", "i", "if", "into", "is", "it",
  "its", "just", "many", "may", "me", "might", "must", "my", "no", "not", "of",
  "on", "once", "only", "or", "our", "out", "over", "own", "same", "she",
  "should", "since", "so", "some", "still", "such", "than", "that", "the",
  "their", "them", "then", "there", "these", "they", "this", "those", "through",
  "to", "too", "under", "until", "up", "very", "was", "we", "were", "what",
  "when", "where", "which", "while", "who", "why", "will", "with", "would",
  "you", "your",
]);

/**
 * Tokens that cannot discriminate, and therefore must not vote.
 *
 * Two sources. The intersection of the two lists is the obvious half. The other
 * half is cross-language homographs: words that are a function word in one
 * language and an ordinary word in the other. `hat`, `war`, `man`, `die`, `bin`
 * and `also` are German function words and English nouns, verbs or adverbs;
 * `will` and `her` are the reverse. Measured on the gold set before they were
 * excluded, they filed 38 purely German and 14 purely English queries as
 * `mixed` — one stray homograph was enough, which is exactly the failure the
 * fifteen-word list had, inverted.
 */
const HOMOGRAPHS = ["an", "am", "all", "also", "bin", "die", "hat", "her", "in", "man", "so", "war", "was", "will"];
const AMBIGUOUS = new Set([...[...DE_WORDS].filter((w) => EN_WORDS.has(w)), ...HOMOGRAPHS]);

/** German umlauts and ß — a near-certain German signal, and the one cue a
 *  function-word list misses entirely on short prose. */
const DE_DIACRITICS = /[äöüß]/i;

/**
 * `mixed` needs a SECOND language, not a stray token.
 *
 * Presence alone was enough while the lists were fifteen words long. At seventy
 * it is not: a German sentence naming `survival-by-id.test.ts` donates `by` to
 * the English count, and `no-answer` donates `no` — identifier fragments split
 * like words and vote like them. Measured, that filed nine German sentences as
 * `mixed` for one borrowed token each.
 *
 * So the weaker language has to carry real weight: at least two hits, and at
 * least a third of the stronger one. "what is the diff für this" clears both
 * (4 vs 2) and stays `mixed`; a German question mentioning one English
 * identifier does not.
 */
const MIN_SECOND_LANGUAGE_HITS = 2;
const SECOND_LANGUAGE_SHARE = 3;

export function detectLang(query: string): StagedQuery["lang"] {
  const tokens = query.toLowerCase().split(/[^a-zäöüß]+/i).filter(Boolean);
  let de = 0;
  let en = 0;
  for (const t of tokens) {
    if (AMBIGUOUS.has(t)) continue;
    if (DE_WORDS.has(t)) de++;
    if (EN_WORDS.has(t)) en++;
  }
  if (DE_DIACRITICS.test(query)) de++;
  const weaker = Math.min(de, en);
  const stronger = Math.max(de, en);
  if (weaker >= MIN_SECOND_LANGUAGE_HITS && weaker * SECOND_LANGUAGE_SHARE >= stronger) return "mixed";
  if (de > en) return "de";
  if (en > de) return "en";
  if (de > 0) return "mixed";
  // Neither language's function words appear: a technical token chain that is
  // not in a language at all. Guessing here would be the difference between a
  // usable language balance and a single 94% bucket.
  return "neutral";
}

/** An exact identifier, path, symbol or issue reference (§19). */
export function hasIdentifier(query: string): boolean {
  return (
    /[A-Za-z0-9_-]+\.(ts|tsx|js|json|md|swift|py|rs|go|ya?ml)\b/.test(query) ||
    /\b[a-z]+[A-Z][A-Za-z]*\(/.test(query) ||
    /\b[a-z0-9]+([-_][a-z0-9]+){2,}\b/.test(query) ||
    /#\d+/.test(query) ||
    /\b[a-f0-9]{7,40}\b/.test(query) ||
    /packages\//.test(query)
  );
}

export function checkStaged(rows: StagedQuery[]): GoldIssue[] {
  const issues: GoldIssue[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const where = r.id || r.query.slice(0, 40);
    if (!r.query?.trim()) issues.push({ where, problem: "empty query" });
    if (r.id !== stagedId(r.query)) {
      issues.push({ where, problem: "id is not the hash of the query — re-harvesting would duplicate it" });
    }
    if (!ORIGIN_TYPES.includes(r.origin_type)) {
      issues.push({ where, problem: `origin_type \`${r.origin_type}\` is not one of the five §19 sources` });
    }
    if (!LANGS.includes(r.lang)) {
      issues.push({ where, problem: `lang \`${r.lang}\` is not one of ${LANGS.join(", ")}` });
    }
    if (!r.authoring_mode?.trim()) issues.push({ where, problem: "authoring_mode is mandatory (§19)" });
    if (!/^[a-f0-9]{64}$/.test(r.origin_ref_hash ?? "")) {
      issues.push({ where, problem: "origin_ref_hash must be a sha256 hex digest (§19)" });
    }
    if (seen.has(r.id)) issues.push({ where, problem: "duplicate staged id" });
    seen.add(r.id);
  }
  return issues;
}

export function checkLabels(labels: GoldLabel[], staged: StagedQuery[]): GoldIssue[] {
  const issues: GoldIssue[] = [];
  const stagedIds = new Set(staged.map((s) => s.id));
  for (const l of labels) {
    const where = l.staged_id;
    if (!stagedIds.has(l.staged_id)) {
      issues.push({ where, problem: "label refers to no staged query — the two steps drifted apart" });
    }
    if (!l.rationale?.trim()) {
      issues.push({ where, problem: "rationale is mandatory (§19) — a label nobody can check is not a label" });
    }
    if (l.no_answer && l.expected_ids.length > 0) {
      issues.push({ where, problem: "a no_answer case cannot expect ids" });
    }
    if (!l.no_answer && l.expected_ids.length === 0) {
      issues.push({ where, problem: "expected_ids is empty but no_answer is false — the case grades nothing" });
    }
    if (!ZONES.includes(l.expected_zone)) issues.push({ where, problem: `unknown zone \`${l.expected_zone}\`` });
    if (!CASE_KINDS.includes(l.kind)) issues.push({ where, problem: `unknown kind \`${l.kind}\`` });
    // Absent is the normal case. Present but unknown is a typo, and a typo here
    // silently moves a case out of the main denominator.
    if (l.probe_group !== undefined && !PROBE_GROUPS.includes(l.probe_group)) {
      issues.push({ where, problem: `unknown probe_group \`${l.probe_group}\` — expected one of ${PROBE_GROUPS.join(", ")}` });
    }
    if (!Number.isInteger(l.allowed_retrieval_depth) || l.allowed_retrieval_depth < 1) {
      issues.push({ where, problem: "allowed_retrieval_depth must be a positive integer (§19)" });
    }
    const overlap = l.expected_ids.filter((id) => l.acceptable_alternatives.includes(id));
    if (overlap.length) {
      issues.push({ where, problem: `${overlap.join(", ")} is both expected and merely acceptable` });
    }
  }
  return issues;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isString = (v: unknown): v is string => typeof v === "string";
const isFilled = (v: unknown): boolean => isString(v) && v.trim() !== "";
const isIdList = (v: unknown): boolean => Array.isArray(v) && v.every(isString);

/**
 * The runtime shape guard the semantic checks assume (#434).
 *
 * `checkStaged` and `checkLabels` answer "is this label admissible", not "is
 * this an object of the right shape" — they were written for values that
 * already carry the right TYPE. A finished gold file is arbitrary JSON, so
 * `has_identifier: "false"`, `scope: 42` or `labelled_at: "yesterday"` walked
 * through them unseen, and a missing id list made them throw MID-validation
 * instead of producing a controlled dataset error.
 *
 * This runs first and reports every field whose type is wrong. It deliberately
 * does not repeat the enum checks that follow: `origin_type`, `expected_zone`,
 * `kind`, `lang` and `probe_group` are only checked here for being strings at
 * all, because their admissible VALUES are the semantic layer's job and a
 * second copy of that list would be the drift this file keeps warning about.
 */
export function checkGoldShape(cases: readonly unknown[]): GoldIssue[] {
  const issues: GoldIssue[] = [];
  cases.forEach((raw, i) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      issues.push({ where: `case #${i}`, problem: "is not a JSON object" });
      return;
    }
    const c = raw as Record<string, unknown>;
    const where = isFilled(c.id) ? String(c.id) : `case #${i}`;
    const bad = (field: string, expected: string): void => {
      issues.push({ where, problem: `${field} must be ${expected}, got ${JSON.stringify(c[field]) ?? "undefined"}` });
    };

    for (const f of ["id", "query", "authoring_mode", "rationale", "labelled_by"]) {
      if (!isFilled(c[f])) bad(f, "a non-empty string");
    }
    for (const f of ["origin_ref_hash", "origin_type", "expected_zone", "kind", "lang"]) {
      if (!isString(c[f])) bad(f, "a string");
    }
    for (const f of ["has_identifier", "no_answer"]) {
      if (typeof c[f] !== "boolean") bad(f, "a boolean");
    }
    // Missing or non-array id lists are the ones that used to throw: every
    // later check reads `.length` or `.filter` on them.
    for (const f of ["expected_ids", "acceptable_alternatives"]) {
      if (!isIdList(c[f])) bad(f, "an array of strings");
    }
    if (typeof c.allowed_retrieval_depth !== "number") bad("allowed_retrieval_depth", "a number");
    if (c.scope !== null && !isString(c.scope)) bad("scope", "a string or null");
    if (c.time_view !== null && !isString(c.time_view)) bad("time_view", "a string or null");
    if (!isString(c.labelled_at) || !ISO_DATE.test(c.labelled_at)) bad("labelled_at", "a YYYY-MM-DD date");
    if (c.probe_group !== undefined && !isString(c.probe_group)) bad("probe_group", "a string when present");
    if (c.correct_answer_is_non_application !== undefined && typeof c.correct_answer_is_non_application !== "boolean") {
      bad("correct_answer_is_non_application", "a boolean when present");
    }
  });
  return issues;
}

/**
 * The full check a FINISHED gold file must pass before it is measured (#434).
 *
 * Two layers, in this order. The shape guard above establishes that every field
 * has the type the rest of the code assumes; only then do the authoring
 * pipeline's own rule sets run, because a `GoldCase` is a staged query plus its
 * label and reusing `checkStaged`/`checkLabels` is what keeps the measurement
 * and the authoring step from drifting apart.
 *
 * A broken shape short-circuits: the semantic checks are written for well-typed
 * input and would throw on anything else, and an exception during validation is
 * not a dataset error a caller can report.
 */
export function checkGoldCases(cases: readonly unknown[]): GoldIssue[] {
  const shape = checkGoldShape(cases);
  if (shape.length) return shape;
  const typed = cases as GoldCase[];
  const labels = typed.map((c) => ({ ...c, staged_id: c.id }));
  return [...checkStaged(typed), ...checkLabels(labels, typed)];
}

/**
 * Coverage §19 demands the set report, so a gap is visible before the run.
 *
 * Every field below counts the MAIN denominator — cases without a
 * `probe_group`. Probes are reported beside it in `probes`/`by_probe_group`,
 * never inside it: a nonsense string does not make the set's no-answer share
 * look healthier, and four runs of one diagnostic do not make it look bigger.
 * On a file written before probe groups existed nothing carries one, so
 * `total` equals `total_with_probes` and every number is what it always was.
 */
export interface GoldCoverage {
  total: number;
  by_origin: Record<string, number>;
  by_lang: Record<string, number>;
  by_kind: Record<string, number>;
  with_identifier: number;
  no_answer: number;
  non_application: number;
  cross_scope: number;
  /** Cases carrying a `probe_group`, excluded from every field above. */
  probes: number;
  by_probe_group: Record<string, number>;
  /** `total + probes` — the raw case count, for reconciling against a file. */
  total_with_probes: number;
}

export function coverage(cases: GoldCase[]): GoldCoverage {
  const bump = (r: Record<string, number>, k: string): void => { r[k] = (r[k] ?? 0) + 1; };
  const out: GoldCoverage = {
    total: 0,
    by_origin: {}, by_lang: {}, by_kind: {},
    with_identifier: 0, no_answer: 0, non_application: 0, cross_scope: 0,
    probes: 0, by_probe_group: {}, total_with_probes: cases.length,
  };
  for (const c of cases) {
    if (c.probe_group) {
      out.probes++;
      bump(out.by_probe_group, c.probe_group);
      continue;
    }
    out.total++;
    bump(out.by_origin, c.origin_type);
    bump(out.by_lang, c.lang);
    bump(out.by_kind, c.kind);
    if (c.has_identifier) out.with_identifier++;
    if (c.no_answer) out.no_answer++;
    if (c.correct_answer_is_non_application) out.non_application++;
    if (c.scope === null) out.cross_scope++;
  }
  return out;
}
