/**
 * UserPromptSubmit lane — prompt classification (split out of prompt-lane.ts,
 * #680): mode detection (retrieval / assertion), the trivial-prompt gate, the
 * per-mode score floor and prompt extraction from the hook payload. Pure and
 * deterministic; runs before any recall work.
 */

export const SCORE_FLOOR = 50; // higher than PreToolUse: prompts rarely match recall_when exactly
export const MUST_LOAD_SCORE = 100;

export interface ClaudeHookPayload {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  /** primary surface in Claude Code docs */
  prompt?: string;
  /** legacy / alternative key seen in some Claude-Code payload variants */
  user_message?: string;
}

export type DetectedMode = "retrieval" | "assertion" | "none" | "generic";

// DE + EN retrieval triggers — match the spec in Issue #33.
const RETRIEVAL_DE = /^\s*(such|finde|wo (ist|sind)|wann (war|hatte)|wieviel|wie viel|was hab(e ich)?|was war)/i;
const RETRIEVAL_EN = /^\s*(find|search|where (is|are)|when (was|did)|how much|what (did|was))/i;

// #707: further languages are data keyed by ISO-639-1 — regex fragments like
// the cue lists in lexicon.ts, matched with Unicode letter boundaries (`\b` is
// ASCII-only). An unlisted language takes the neutral path: generic mode, the
// same score-gated recall with the MUST_LOAD floor (#677: recall is not gated
// on the mode).
const RETRIEVAL_LEADS_BY_LANGUAGE: Readonly<Record<string, readonly string[]>> = {
  ru: [
    "найд[иё]\\p{L}*", "найти", "ищи", "поищи",
    "где\\s+(?:лежит|лежат|находится|находятся|был[аио]?|были)",
    "когда\\s+(?:был[аио]?|были|мы)", "сколько",
    "что\\s+(?:я|мы)\\s+(?:делал|делали|писал|писали)", "что\\s+было",
  ],
};

const leadRe = (cues: readonly string[]) => new RegExp(`^\\s*(?:${cues.join("|")})(?![\\p{L}\\p{N}])`, "iu");
const wordRe = (cues: readonly string[]) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${cues.join("|")})(?![\\p{L}\\p{N}])`, "iu");

const RETRIEVAL = [RETRIEVAL_DE, RETRIEVAL_EN, ...Object.values(RETRIEVAL_LEADS_BY_LANGUAGE).map(leadRe)];

export function detectRetrieval(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (trimmed.length === 0) return false;
  return RETRIEVAL.some((re) => re.test(trimmed));
}

// ─── assertion lane (#252) ───────────────────────────────────────────────────
//
// The PreToolUse lane is bound to a tool, so it reaches an agent that EDITS.
// Writing a sentence touches nothing: a draft reply, a changelog entry, an
// issue comment or an answer about project state makes factual claims and
// fires no hook — the claim comes out of model memory while the vault holds
// the measured answer. A finished sentence is not lexically distinguishable
// from an opinion, so the request is classified instead of the output: "draft
// a reply", "write the release notes", "what's the state of X" are all
// recognisable in the PROMPT, before the text exists.
//
// Deliberately narrow — two signals are required, never a bare verb, because
// a lane that fires on every declarative prompt is the noise that made the
// passive channel fail. Misses claims that only arise mid-draft; that is the
// known gap, tracked in #252 as the case for an outbound verification pass.

/** Composing an artefact for someone else. */
const COMPOSE_VERB =
  /\b(draft|write|compose|announce|reply|respond|publish|schreib\w*|verfass\w*|formulier\w*|entwirf|entwerfe|antworte\w*|beantworte|ver(ö|oe)ffentlich\w*)\b/i;

/** …that leaves this machine. `#123` counts: naming an issue is outward. */
const OUTWARD_ARTIFACT =
  /(\B#\d+\b|\b(release[- ]?notes?|release-?notizen|changelog|(ä|ae)nderungsprotokoll|announcement|ank(ü|ue)ndigung|blog\w*|newsletter|readme|docs?|documentation|dokumentation|issue|pr|pull[- ]?requests?|comment|kommentar|reply|antwort|thread|discord|mail|e-?mail|posting|tweet|beitrag)\b)/i;

/** Asking for a state… */
const STATE_QUESTION =
  /\b(what'?s|what is|how (far|many|much|good)|status|state|wie (ist|weit|viele?|gut)|stand|wo stehen wir)\b/i;

/** …that this project has actually measured or recorded. */
const PROJECT_STATE_NOUN =
  /\b(measured?|measurement|benchmark|eval|recall@\w*|numbers?|metrics?|coverage|latency|ceiling|zahlen|gemessen|messung|kennzahl\w*|milestone|roadmap|release|version|tests?)\b/i;

/**
 * #252: does the prompt ask for an ASSERTION — outbound text, or a claim about
 * this project's measured state? Both end in sentences someone else reads, and
 * neither edits a file, so no other lane fires for them.
 */
interface AssertionSignals<T> {
  compose: T;
  outward: T;
  state: T;
  noun: T;
}

/** #707: the same two signals for further languages, as data (see
 *  RETRIEVAL_LEADS_BY_LANGUAGE for the neutral path). */
const ASSERTION_SIGNALS_BY_LANGUAGE: Readonly<Record<string, AssertionSignals<readonly string[]>>> = {
  ru: {
    compose: ["напиши\\p{L}*", "составь\\p{L}*", "сформулируй\\p{L}*", "набросай\\p{L}*", "подготовь\\p{L}*", "ответь\\p{L}*", "ответить", "опубликуй\\p{L}*", "анонсируй\\p{L}*"],
    outward: [
      "релиз-?нот\\p{L}*", "заметк\\p{L}*\\s+к\\s+релизу", "чейнджлог\\p{L}*", "список\\s+изменений", "анонс\\p{L}*", "блог\\p{L}*",
      "рассылк\\p{L}*", "ридми", "документаци\\p{L}*", "ишью", "комментари\\p{L}*", "ответ\\p{L}*", "тред\\p{L}*",
      "дискорд\\p{L}*", "письм\\p{L}*", "почт\\p{L}*", "пост\\p{L}*", "твит\\p{L}*",
    ],
    state: ["какой", "какая", "какие", "каков\\p{L}*", "статус\\p{L}*", "состояни\\p{L}*", "как\\s+(?:дела|далеко|хорошо)", "сколько", "насколько", "где\\s+мы"],
    noun: ["замер\\p{L}*", "измер\\p{L}*", "бенчмарк\\p{L}*", "метрик\\p{L}*", "цифр\\p{L}*", "покрыти\\p{L}*", "задержк\\p{L}*", "потолок", "роадмап\\p{L}*", "вех\\p{L}*", "верси\\p{L}*", "тест\\p{L}*"],
  },
};

const ASSERTION: AssertionSignals<RegExp>[] = [
  { compose: COMPOSE_VERB, outward: OUTWARD_ARTIFACT, state: STATE_QUESTION, noun: PROJECT_STATE_NOUN },
  ...Object.values(ASSERTION_SIGNALS_BY_LANGUAGE).map((l) => ({
    compose: wordRe(l.compose), outward: wordRe(l.outward), state: wordRe(l.state), noun: wordRe(l.noun),
  })),
];

export function detectAssertion(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (trimmed.length === 0) return false;
  // A signal may come from any language: "напиши README" is a compose verb in
  // one and an artefact in the other.
  const any = (k: keyof AssertionSignals<RegExp>) => ASSERTION.some((l) => l[k].test(trimmed));
  if (any("compose") && any("outward")) return true;
  return any("state") && any("noun");
}

// #151: trivial-prompt gate. Bare acks, one-worders and slash-command
// invocations cannot act on recalled context — injecting there is pure
// context tax (and in the default mode "all" the hook otherwise fires on
// EVERY prompt). Deterministic, runs before any recall work.
//
// #707: the ack words are data per language (ISO-639-1), like the cue lists
// in lexicon.ts. Two structural rules need no list and hold in every script:
// a prompt of at most two characters ("да", "ok"), and one without any letter
// or digit ("👍", "!!", "…"). The NEUTRAL path for an ack in a language
// without a list ("tamam", "спасибо") is one ordinary recall, gated by score
// like any prompt — a missed ack costs one lookup, never a lost recall.
const TRIVIAL_ACKS_BY_LANGUAGE: Readonly<Record<string, readonly string[]>> = {
  en: [
    "ok", "okay", "k", "kk", "yes", "yep", "yeah", "no", "nope", "thx",
    "thanks", "thank you", "cool", "nice", "great", "perfect", "go",
    "continue", "proceed", "stop", "wait", "done", "sure",
  ],
  de: [
    "ja", "jo", "jep", "nein", "ne", "nö", "danke", "super", "top", "passt",
    "perfekt", "weiter", "mach", "mach weiter", "los", "gut", "genau",
    "richtig", "stimmt", "erledigt", "fertig",
  ],
};
const TRIVIAL_ACKS = new Set(Object.values(TRIVIAL_ACKS_BY_LANGUAGE).flat());

// A typed slash command: "/name" or "/name args". The first token must not
// contain a second "/" so absolute paths ("/Users/… bitte lesen") never gate.
const SLASH_COMMAND_RE = /^\/[a-z0-9][a-z0-9_-]*(?:\s|$)/i;

export function isTrivialPrompt(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (trimmed.length === 0) return true;
  // Slash-command invocations — typed directly, or already expanded by
  // Claude Code into <command-name>/<local-command-*> blocks. The retrieval
  // regex would otherwise match phrases inside the expanded command/skill
  // body instead of user intent.
  if (SLASH_COMMAND_RE.test(trimmed) && !trimmed.includes("\n")) return true;
  if (trimmed.includes("<command-name>") || trimmed.startsWith("<local-command-")) return true;
  // Bare ack / one-worder (trailing punctuation tolerated).
  const bare = trimmed.toLowerCase().replace(/[\s!.?…]+$/u, "");
  if (TRIVIAL_ACKS.has(bare)) return true;
  if (bare.length <= 2) return true;
  // #707: nothing to recall on in any language — emoji, punctuation, symbols.
  if (!/[\p{L}\p{N}]/u.test(bare)) return true;
  return false;
}

/**
 * Score floor per detected mode. "generic" floors at MUST_LOAD_SCORE — only
 * very strong matches may interrupt arbitrary prompts. #161 corollary: every
 * hit surviving the generic floor sits in the REQUIRED band, so the
 * hasRequired bypass in decideBackoff makes suppression impossible there by
 * construction (asserted in prompt-lane.test.ts instead of special-casing).
 */
export function effectiveScoreFloor(mode: DetectedMode): number {
  return mode === "generic" ? MUST_LOAD_SCORE : SCORE_FLOOR;
}

export function extractPrompt(payload: ClaudeHookPayload): string | null {
  const raw =
    typeof payload.prompt === "string"
      ? payload.prompt
      : typeof payload.user_message === "string"
        ? payload.user_message
        : null;
  if (raw === null) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}
