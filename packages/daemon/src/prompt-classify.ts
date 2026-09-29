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

export function detectRetrieval(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (trimmed.length === 0) return false;
  return RETRIEVAL_DE.test(trimmed) || RETRIEVAL_EN.test(trimmed);
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
export function detectAssertion(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (trimmed.length === 0) return false;
  if (COMPOSE_VERB.test(trimmed) && OUTWARD_ARTIFACT.test(trimmed)) return true;
  return STATE_QUESTION.test(trimmed) && PROJECT_STATE_NOUN.test(trimmed);
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
