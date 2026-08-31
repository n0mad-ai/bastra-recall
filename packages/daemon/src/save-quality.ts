/**
 * `save_quality` — the advisory the save path hands back to the agent.
 *
 * Split out of tool-handlers.ts (#239 follow-up): eight open issues touch that
 * file and it had grown past 1400 lines, so the scoring logic gets its own
 * boundary before the next one lands on it. Pure move — no behaviour change.
 *
 * This is ADVISORY: it never blocks a save. It reports how specific the
 * triggers are, whether the memory looks like a near-duplicate of one that
 * already exists, and whether its `recall_when` phrases collide with the rest
 * of its scope. The numbers it returns have to mean what their names say —
 * that was the whole point of #239.
 */
import {
  SaveMemoryInput,
  containsInjectedBlock,
  scanForInjection,
  formatInjectionAdvisory,
  scopeEquals,
} from "@bastra-recall/core";
import { detectLanguage } from "./learned-recall/language.js";
import {
  containedIn,
  fieldSimilarity,
  triggerRestatesSummary,
  DUPLICATE_SIMILARITY_MIN,
  TRIGGER_CLAIMS_SITUATION_MIN,
  tokens as words,
  type SimilarityFields,
} from "./save-similarity.js";
import type { ToolDeps } from "./tool-deps.js";

/** #239: upper bound for the collision scan. The pool decides `k`, but a
 *  pathological scope must not turn an advisory into a full-index sweep on
 *  every save. Above this the count is reported as a lower bound. */
const COLLISION_SCAN_MAX = 300;

export interface SaveQualityResult {
  /** 0-100 advisory score: higher means more specific, less duplicative triggers. */
  score: number;
  band: "low" | "medium" | "high";
  issues: string[];
  suggestions: string[];
  /** #239: `similarity` is a normalized 0..1 content overlap, NOT the raw BM25
   *  score this used to expose. The old field was additive, query-dependent and
   *  ran into the tens of thousands, which invited comparison with the capped
   *  hybrid recall score even though the two scales mean different things. */
  duplicate_candidates: Array<{ id: string; similarity: number; title: string }>;
  trigger_collisions: Array<{
    trigger: string;
    count: number;
    examples: string[];
    /** #360: every colliding id, uncapped — what the claim gate decides on. */
    claimants?: string[];
    /** #300: the colliding memory's OWN trigger — the phrase that makes this a
     *  collision. Without it the advisory names a conflict the author cannot
     *  see, which is how the previous count stayed unactionable even when it
     *  happened to be right. */
    claim?: string;
    /** #239: true when `count` is bounded by the retrieval cap and the real
     *  number is higher. An exact count cannot reuse `SearchIndex.recall` —
     *  staleness/demotion multipliers are applied only to the already-sliced
     *  candidate set — so the honest move is to mark the bound rather than
     *  render a capped value as exact. */
    at_least?: boolean;
    /** Memories the scope/type filter admits at all — "20 of 21 admitted" is
     *  actionable where a bare "20" is not, and it makes the signal comparable
     *  across vault sizes. */
    admitted_pool?: number;
  }>;
}

export const GENERIC_TRIGGER_WORDS = new Set([
  "api",
  "app",
  "auth",
  "bug",
  "code",
  "css",
  "data",
  "db",
  "debug",
  "design",
  "docs",
  "error",
  "fix",
  "frontend",
  "ios",
  "js",
  "macos",
  "memory",
  "node",
  "python",
  "react",
  "refactor",
  "server",
  "swift",
  "test",
  "typescript",
  "ui",
  "ux",
]);

function triggerSpecificityIssue(trigger: string): string | undefined {
  const tokens = words(trigger);
  if (tokens.length <= 1) return `recall_when '${trigger}' is too short/generic`;
  if (tokens.length <= 2 && tokens.every((t) => GENERIC_TRIGGER_WORDS.has(t))) {
    return `recall_when '${trigger}' is only generic technology words`;
  }
  return undefined;
}

function buildSpecificTriggerSuggestion(input: SaveMemoryInput): string {
  const path = input.topic_path.join("/") || input.scope;
  const summaryTokens = words(input.summary)
    .filter((t) => !GENERIC_TRIGGER_WORDS.has(t))
    .slice(0, 5)
    .join(" ");
  const anchor = summaryTokens || input.title.toLowerCase();
  return `tighten recall_when around an action + anchor, e.g. 'about to ${input.type} in ${path}: ${anchor}'`;
}

/**
 * #300 — does one of `theirs` already declare the situation `trigger` names?
 *
 * Directional on purpose: full containment of THIS trigger in one of theirs is
 * the actionable direction. It means this trigger is the broader of the two, so
 * every situation it names also belongs to them and their memory comes up
 * whenever it fires. The reverse (theirs contained in this one) is their
 * problem to solve, not something to charge this save for.
 *
 * Per single trigger, never against the joined list: two of their triggers that
 * between them cover this one's words do not claim its situation, they just
 * share vocabulary — which is the mistake this whole issue is about.
 */
/** #360: exported so the write-time claim gate and the curator's `claimed
 *  twice` sweep answer the containment question with the same primitive the
 *  save-time advisory uses — three implementations of "declares the same
 *  situation" would drift apart the moment one of them is tuned. */
export function claimingTrigger(trigger: string, theirs: string[]): string | undefined {
  return theirs.find((candidate) => containedIn(trigger, candidate) >= TRIGGER_CLAIMS_SITUATION_MIN);
}

// #159: admission rules — vault rot has a known shape. Negative capability
// claims harden into standing refusals that outlive the problem; imperative
// phrasing gets re-read as a directive in unrelated later contexts. Both are
// advisory-only flags, never blocks.
const NEGATIVE_CLAIM_RE =
  /\b(is broken|does ?n[o']?t work|not working|no longer works|never works|funktioniert nicht( mehr)?|ist kaputt|geht nicht( mehr)?)\b/i;
const FIX_MARKER_RE =
  /\b(fix(ed)?|lösung|solution|workaround|abhilfe|stattdessen|instead|how to apply)\b/i;
const IMPERATIVE_LEAD_RE =
  /^(always|never|don'?t|do not|avoid|remember to|ensure|immer|nie(mals)?|benutze|verwende|vermeide|nutze|stelle sicher)\b/i;

/**
 * @param excludeId Die EFFEKTIVE id des Saves (`input.id ?? slugify(title)`).
 *   Muss vom Caller berechnet werden: `input.id` ist auf dem dokumentierten
 *   Normalpfad `undefined` (der Agent schickt nur den Titel), und ein Filter
 *   gegen `undefined` schließt nichts aus — das Memory fand beim Overwrite
 *   sich selbst als Top-Duplikat und kollidierte mit den eigenen Triggern.
 */
export function scoreSaveQuality(
  deps: ToolDeps,
  input: SaveMemoryInput,
  excludeId: string,
): SaveQualityResult {
  const issues: string[] = [];
  const suggestions: string[] = [];
  let score = 100;

  const triggerIssues = input.recall_when
    .map(triggerSpecificityIssue)
    .filter((issue): issue is string => issue !== undefined);
  if (triggerIssues.length > 0) {
    issues.push(...triggerIssues);
    suggestions.push(buildSpecificTriggerSuggestion(input));
    score -= Math.min(55, triggerIssues.length * 25);
  }

  const genericTags = input.tags.filter((tag) => {
    const tokens = words(tag);
    return tokens.length === 1 && GENERIC_TRIGGER_WORDS.has(tokens[0]);
  });
  if (genericTags.length > 0) {
    issues.push(`generic tags: ${genericTags.join(", ")}`);
    suggestions.push("add at least one project/component/outcome tag so future matches are narrower");
    score -= Math.min(24, genericTags.length * 12);
  }

  // #159: 'X is broken / doesn't work' without a fix becomes a standing
  // refusal that keeps surfacing long after the problem was solved
  if (
    NEGATIVE_CLAIM_RE.test(`${input.title} ${input.summary}`) &&
    !FIX_MARKER_RE.test(`${input.summary} ${input.body}`)
  ) {
    issues.push("negative capability claim without a fix — hardens into a standing refusal");
    suggestions.push(
      "capture the FIX (install step, config, env var) instead of the failure as a constraint — or add the fix to the body",
    );
    score -= 12;
  }

  // #159: imperative lead reads as a directive when recalled in unrelated
  // contexts — declarative facts age better
  if (IMPERATIVE_LEAD_RE.test(input.title.trim()) || IMPERATIVE_LEAD_RE.test(input.summary.trim())) {
    issues.push("imperative phrasing — re-reads as a self-directive in unrelated later contexts");
    suggestions.push("state it as a declarative fact: 'User prefers …' / 'X requires Y', not 'Always/Never …'");
    score -= 8;
  }

  // #238 (zzallirog, measured on a 471-note vault): 81% of real notes had
  // recall_when[0] as a verbatim copy of the summary. That spends the weight-5
  // field on text already indexed at weight 2 — bytes without signal, diluting
  // the one field that decides whether a memory surfaces at the right moment.
  // Rewriting to distinct triggers moved that vault's recall@5 from 0.457 to
  // 0.565 while getting SMALLER. Trust the direction, not the magnitude:
  // single vault, authored queries, small per-arm n.
  const restating = input.recall_when.filter((trigger) => triggerRestatesSummary(trigger, input.summary));
  if (restating.length > 0) {
    issues.push(
      `recall_when restates the summary: ${restating.map((t) => `'${t}'`).join(", ")} — the weight-5 trigger field carries text already indexed at weight 2`,
    );
    suggestions.push(
      "author each trigger as a SITUATION where this should surface ('about to write a Tailwind grid'), not a paraphrase of the summary",
    );
    // Small nudge, like its advisory siblings. This is an authoring hint, not
    // a defect: the memory still works, it just spends its best field badly.
    score -= Math.min(16, restating.length * 8);
  }

  // #231 (language-first recall): the hook manufactures English queries on every
  // box, so on a non-English vault the highest-weighted field (recall_when)
  // structurally can't match English-authored triggers. If the user's primary
  // language is set and non-English but the joined triggers read as English,
  // nudge toward authoring in their language. Conservative by construction:
  // detectLanguage only fires on a confident "en" (it abstains on short /
  // code-shaped / ambiguous input and can only tell de/en apart, so e.g. a
  // Russian primary with Russian triggers abstains and never trips this),
  // advisory only — never a rejection. A false negative is cheaper here.
  const primaryLang = deps.primaryLanguage;
  if (primaryLang && primaryLang !== "en" && detectLanguage(input.recall_when.join(" ")).lang === "en") {
    issues.push(`recall_when reads as English but your primary language is '${primaryLang}'`);
    suggestions.push(
      `author triggers in '${primaryLang}', keeping only genuine English tech terms (daemon, deploy, hook, …) as cross-lingual anchors`,
    );
    score -= 8;
  }

  // #149: a complete hook/context block quoted in memory content is
  // conversation scaffolding, not memory — it re-enters the index via body
  // search and (title/summary) doc2query. Advisory only: save content is never
  // silently rewritten; the agent removes the block and re-saves.
  const injectedTags = Array.from(
    new Set([
      ...containsInjectedBlock(input.title),
      ...containsInjectedBlock(input.summary),
      ...containsInjectedBlock(input.body),
    ]),
  );
  if (injectedTags.length > 0) {
    issues.push(`injected context blocks in content: <${injectedTags.join(">, <")}>`);
    suggestions.push(
      "remove quoted hook/context blocks (<recall-hints>, <session-context>, <system-reminder>, …) — they are conversation scaffolding, not memory content",
    );
    score -= 20;
  }

  // #147: Injection-Marker im Save-Inhalt — advisory only, nie blocken (der
  // Flag ist billig, ein verpasster Marker nicht). Trifft vor allem Captures
  // von Third-Party-Content (Bridge, zitierte Dokumente); rein user-eigene
  // Memories triggern die Muster praktisch nie.
  const injectionFindings = scanForInjection([input.title, input.summary, input.body].join("\n"));
  const injectionAdvisory = formatInjectionAdvisory(injectionFindings);
  if (injectionAdvisory) {
    issues.push(injectionAdvisory);
    suggestions.push(
      "review the flagged spans — quoted third-party material keeps the flag as provenance; if it is your own phrasing, reword it",
    );
    score -= 15;
  }

  // #162: kurze, diskriminierende Felder (title, tags, recall_when) zuerst,
  // die potentiell lange summary zuletzt — falls der QUERY_MAX_CHARS-Cap
  // greift, fällt nur Summary-Schwanz weg, nie ein diskriminierender Term.
  // #239: BM25 generates candidates, it does NOT decide. Its raw score is
  // additive and query-dependent — repeating a term multiplies it, corpus size
  // moves it — so the old `hit.score >= 20` gate flagged unrelated memories at
  // five-digit "scores" and pointed agents at the wrong overwrite target. The
  // decision now runs on `fieldSimilarity` (0..1, set-based, vault-independent).
  // Query terms are deduped before retrieval so repetition cannot widen the net
  // either.
  const duplicateQuery = [
    ...new Set(words([input.title, ...input.tags, ...input.recall_when, input.summary].join(" "))),
  ].join(" ");
  const asFields = (m: { title: string; summary: string; tags?: string[]; recall_when?: string[] }): SimilarityFields => ({
    title: m.title,
    summary: m.summary,
    tags: m.tags ?? [],
    recall_when: m.recall_when ?? [],
  });
  const self = asFields(input);
  const duplicateCandidates = deps.search
    .recall(duplicateQuery, { k: 10, scope: input.scope, type: input.type, allow_private: false })
    .filter((hit) => hit.id !== excludeId)
    .map((hit) => {
      // The hit carries only title/summary; tags and recall_when — the fields
      // the author wrote to be matched — come from the vault.
      const stored = deps.vault.get(hit.id)?.fm;
      return {
        id: hit.id,
        title: hit.title,
        similarity: fieldSimilarity(
          self,
          asFields({
            title: stored?.title ?? hit.title,
            summary: stored?.summary ?? hit.summary,
            tags: stored?.tags,
            recall_when: stored?.recall_when,
          }),
        ),
      };
    })
    .filter((candidate) => candidate.similarity >= DUPLICATE_SIMILARITY_MIN)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 3)
    .map((candidate) => ({ ...candidate, similarity: Math.round(candidate.similarity * 1000) / 1000 }));
  if (duplicateCandidates.length > 0) {
    const top = duplicateCandidates[0];
    issues.push(`possible duplicate: ${top.id} (similarity ${top.similarity})`);
    suggestions.push(`consider load_memory('${top.id}') and overwrite/update instead of creating a near-duplicate`);
    // #239: the penalty follows HOW similar, not how many candidates came back.
    // The old `12 + n*6` charged 18 points for one candidate regardless of
    // whether it was a near-copy or a distant neighbour.
    score -= Math.round(30 * top.similarity);
  }

  // #239: the scope/type filter decides which memories a trigger could collide
  // with at all. "20 of 21 admitted" says the scope shares vocabulary; a bare
  // "20" says nothing and does not compare across vaults.
  //
  // #300: obsolete and private memories are excluded here too, because the scan
  // below cannot reach them — `recall` masks both. Counting them made the
  // denominator name a set the numerator was never drawn from: in the very
  // cohort the issue reports, "of 27" was really "of 25".
  const admittedPool = deps.vault
    .list()
    .filter(
      (m) =>
        scopeEquals(m.fm.scope, input.scope) &&
        m.fm.type === input.type &&
        m.fm.id !== excludeId &&
        !m.fm.obsolete &&
        m.fm.sensitivity !== "private",
    ).length;
  const triggerCollisions = input.recall_when
    .map((trigger) => {
      // #108: ohne den Noise-Floor zählte das die rohe top-k-Liste — jeder
      // Trigger meldete "matches 20 memories" (k-Cap, keine Kollisionen).
      //
      // #239: `k` was 20 while the reported number was rendered as exact, so a
      // trigger matching 146 memories reported "19". `k` now follows the pool,
      // and whatever the cap still hides is marked rather than hidden.
      //
      // #300: but the floor was still the DECISION, and an absolute cut on a
      // raw BM25 score decides nothing — inside one scan that score spans two
      // orders of magnitude, so `>= 30` passed all but the tail and "collision"
      // became a synonym for "the admitted pool" (a median 69% of it on a
      // 661-memory vault, firing on 97% of scans). Cutting relative to the
      // pool's own distribution is no better: `>= 50% of top` still fired on
      // 57% of non-collisions, because the top of a ranking is populated
      // whether or not anything collides. No cut on this axis can work.
      //
      // So the decision no longer runs on retrieval at all. A collision is a
      // claim about AUTHORED TRIGGERS — another memory declaring this same
      // situation — which is a containment question between two written
      // phrases, answered with the same primitive #238/#239 answer theirs.
      // BM25 stays what it became in #239: the candidate generator, not the
      // judge. Over 2516 scans of the real vault the generator hid nothing
      // (423 collisions via top-k, 423 via an exhaustive pool scan), and the
      // false-alarm rate against verbatim-duplicate ground truth fell from
      // 90.4% to 0.9% — a residual that is duplicates the ground truth missed,
      // not misfires.
      const k = Math.max(20, Math.min(admittedPool, COLLISION_SCAN_MAX));
      const raw = deps.search.recall(trigger, { k, scope: input.scope, type: input.type, allow_private: false });
      const hits = raw
        .filter((hit) => hit.id !== excludeId)
        .map((hit) => ({ id: hit.id, claim: claimingTrigger(trigger, deps.vault.get(hit.id)?.fm.recall_when ?? []) }))
        .filter((hit): hit is { id: string; claim: string } => hit.claim !== undefined);
      return {
        trigger,
        count: hits.length,
        examples: hits.slice(0, 3).map((h) => h.id),
        // #360: the gate decides on this, so it must NOT be the display slice.
        // `examples` is capped at three to keep the advisory readable; a gate
        // reading that cap would let a save through once its first three
        // collisions are answered while further ones stay open — measured on a
        // four-deep chain plus one outsider, where the outsider fell off the end.
        claimants: hits.map((h) => h.id),
        claim: hits[0]?.claim,
        // Bounded either by our own cap or by the pool being bigger than it.
        ...(raw.length >= k && admittedPool > k ? { at_least: true } : {}),
        admitted_pool: admittedPool,
      };
    })
    // #300: `>= 3` was the shipped defence against a count that was inflated by
    // construction. One memory that already declares this situation IS the
    // finding, and at 2.2% of scans firing there is nothing left to damp.
    .filter((collision) => collision.count >= 1);
  if (triggerCollisions.length > 0) {
    const top = triggerCollisions[0];
    const howMany = `${top.at_least ? "at least " : ""}${top.count} of ${top.admitted_pool}`;
    issues.push(
      `trigger collision: '${top.trigger}' names a situation ${top.examples[0]} already declares ('${top.claim}') — ${howMany} in this scope`,
    );
    // The old advice ("make it include a concrete action, subsystem, …") pointed
    // at the author's own wording, which is not where the conflict is: the other
    // memory will surface in this situation no matter how this trigger is
    // phrased, unless one of the two moves.
    suggestions.push(
      `consider load_memory('${top.examples[0]}') — either update that memory instead, or narrow this trigger to what is genuinely different from its situation`,
    );
    // Unchanged from #239's shape: 12 per affected trigger, capped at 30. There
    // is no strength gradient left to follow — every reported collision sits at
    // full coverage — so the only dimension is how many of this save's triggers
    // are taken.
    score -= Math.min(30, triggerCollisions.length * 12);
  }

  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  return {
    score: clamped,
    band: clamped >= 80 ? "high" : clamped >= 50 ? "medium" : "low",
    issues,
    suggestions: Array.from(new Set(suggestions)),
    duplicate_candidates: duplicateCandidates,
    trigger_collisions: triggerCollisions,
  };
}
