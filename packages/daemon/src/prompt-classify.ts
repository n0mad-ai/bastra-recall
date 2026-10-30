/**
 * UserPromptSubmit lane — prompt classification (split out of prompt-lane.ts,
 * #680): mode detection (retrieval / assertion), the trivial-prompt gate, the
 * per-mode score floor and prompt extraction from the hook payload. Pure and
 * deterministic; runs before any recall work.
 */
import {
  approvedCopyCues,
  sendPersonCues,
  recipientFollowupCues,
  targetCopyCues,
  copyRevisionCues,
  composeVerbCues,
  correspondenceCues,
  cueRegex,
  draftReplyCues,
  outwardArtifactCues,
  projectStateCues,
  previousConventionCues,
  quoteHeaderCues,
  retrievalLeadCues,
  stateQuestionCues,
  taskApprovalCues,
  translateOnlyCues,
} from "./lexicon.js";

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

// Retrieval leads — how a lookup opens (the spec in Issue #33). #765: the
// leads are per-language data in lexicon.ts (de/en/ru, user-extensible),
// anchored at the start of the prompt and closed by a Unicode boundary (`\b`
// is ASCII-only). A prompt in a language without a list takes the NEUTRAL
// path: it is not labelled `retrieval`, and recalls as an ordinary prompt,
// gated by the must-load score (#677: recall is not gated on the mode).
//
// The label is not cosmetic, so a lead has to be tight: `retrieval` halves
// the score floor (effectiveScoreFloor), asks for k=5 instead of 3, is exempt
// from the backoff, still delivers when the recall ran unfused, and words the
// block as the answer to a lookup.
export function detectRetrieval(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (trimmed.length === 0) return false;
  return detectPreviousConvention(trimmed) || cueRegex(retrievalLeadCues(), true).test(trimmed);
}

/** #1307: only the user's own instruction can force a previous-rule lookup. */
export function detectPreviousConvention(prompt: string): boolean {
  return cueRegex(previousConventionCues()).test(splitQuoted(prompt).own);
}

/** Mode selection belongs with classification, independently of the pipeline. */
export function classifyPromptMode(prompt: string, hookMode: "all" | "retrieval-only"): DetectedMode {
  if (detectRetrieval(prompt)) return "retrieval";
  if (detectAssertion(prompt)) return "assertion";
  return hookMode === "all" ? "generic" : "none";
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
//
// #707: the four signals are per-language data in lexicon.ts (de/en/ru,
// user-extensible), matched with Unicode letter boundaries: composing an
// artefact for someone else, that leaves this machine; asking for a state,
// that this project has measured or recorded. A prompt in a language without
// a list takes the NEUTRAL path: it is not labelled `assertion`, and recalls
// as an ordinary prompt, gated by the must-load score.

/** `#123` is an outward artefact in any script: naming an issue is outward. */
const ISSUE_REFERENCE = /(?<![\p{L}\p{N}_])#\d+(?![\p{L}\p{N}_])/u;

/**
 * #252: does the prompt ask for an ASSERTION — outbound text, or a claim about
 * this project's measured state? Both end in sentences someone else reads, and
 * neither edits a file, so no other lane fires for them.
 */
export function detectAssertion(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (trimmed.length === 0) return false;
  const has = (cues: readonly string[]): boolean => cueRegex(cues).test(trimmed);
  if (has(composeVerbCues()) && (ISSUE_REFERENCE.test(trimmed) || has(outwardArtifactCues()))) return true;
  return has(stateQuestionCues()) && has(projectStateCues());
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

// ─── task contract (#1306) ───────────────────────────────────────────────────
//
// The correspondence workflow a session is in: translate the incoming text
// only, draft a reply for the user's review, or deliver the copy the user
// approved. The state lives in the session (session-state.ts `activeTask`);
// this part only reads the prompt. Pure and deterministic like the rest.

export type TaskKind = "translate-only" | "draft-for-review" | "approved-copy" | "none";

const PASTED_CONTENT = /<pasted_content\b[^>]*>[\s\S]*?(?:<\/pasted_content>|$)/giu;
const BLOCKQUOTE_LINE = /^\s*>/u;

/**
 * Split the prompt into the user's own text and quoted incoming text. Quoted
 * is a `<pasted_content>` block, a blockquote line, and everything from a
 * "… schrieb:" / "Am …, schrieb Max <a@b>:" / "… wrote:" header line on. Only `own` is ever read for a cue:
 * an instruction inside an incoming message never changes the task state.
 */
export function splitQuoted(prompt: string): { own: string; quoted: boolean } {
  let quoted = false;
  const withoutPaste = prompt.replace(PASTED_CONTENT, (block) => {
    if (/\S/u.test(block.replace(/<\/?pasted_content\b[^>]*>/giu, ""))) quoted = true;
    return "\n";
  });
  const header = new RegExp(`(?<![\\p{L}\\p{N}])(?:${quoteHeaderCues().join("|")})(?![\\p{L}\\p{N}])[^\\n]{0,120}:\\s*$`, "iu");
  const own: string[] = [];
  let tail = false;
  for (const line of withoutPaste.split("\n")) {
    if (!tail && header.test(line)) tail = true;
    if (tail || BLOCKQUOTE_LINE.test(line)) {
      if (/\S/u.test(line.replace(/^\s*>/u, ""))) quoted = true;
      continue;
    }
    own.push(line);
  }
  return { own: own.join("\n").trim(), quoted };
}

/** What the user's own text says about the task. */
export interface TaskSignals {
  /** "nur übersetzen" / "translate only". */
  translate: boolean;
  /** "ich arbeite eine eingegangene Nachricht ab" — a correspondence workflow. */
  announce: boolean;
  /** A compose/reply verb ("antworte", "reply", "schreib"). */
  reply: boolean;
  /** An explicit request for a reply draft ("Antwortentwurf", "draft a reply"). */
  draftReply: boolean;
  /** Quoted or pasted incoming text is present (its content is never read). */
  quoted: boolean;
  /** The whole short prompt is an approval ("ok", "passt", "go", "ja"). */
  approval: boolean;
  /** The prompt opens with one ("ok, aber kürzer") — a follow-up, not a new topic. */
  ack: boolean;
  /** An explicit approval phrase ("freigegeben", "approved copy"). */
  approvedCopy: boolean;
  sendPerson?: boolean;
  recipientFollowup?: boolean;
  targetCopy?: boolean;
  revision?: boolean;
}

export function taskSignals(prompt: string): TaskSignals {
  const { own, quoted } = splitQuoted(prompt);
  const has = (cues: readonly string[]): boolean => own.length > 0 && cueRegex(cues).test(own);
  const bare = own.toLowerCase().replace(/[\s!.?…]+$/u, "").trim();
  const ack = cueRegex(taskApprovalCues(), true).exec(own);
  const copyRequest = (ack ? own.slice(ack[0].length) : own).replace(/^[\s,;:!.?…]+|[\s!.?…]+$/gu, "");
  return {
    translate: has(translateOnlyCues()),
    announce: has(correspondenceCues()),
    reply: has(composeVerbCues()),
    draftReply: has(draftReplyCues()),
    quoted,
    approval: bare.length > 0 && new RegExp(`^(?:${taskApprovalCues().join("|")})$`, "iu").test(bare),
    ack: own.length > 0 && cueRegex(taskApprovalCues(), true).test(own),
    approvedCopy: has(approvedCopyCues()),
    sendPerson: has(sendPersonCues()),
    recipientFollowup: has(recipientFollowupCues()),
    targetCopy: copyRequest.length > 0 && new RegExp(`^(?:${targetCopyCues().join("|")})$`, "iu").test(copyRequest),
    revision: has(copyRevisionCues()),
  };
}

export interface TaskContext {
  current: TaskKind;
  /** The choice line went out on the previous prompt of the same generation. */
  questionOpen: boolean;
  /** Detected mode of this prompt; "trivial" for the gated short prompts. */
  mode: DetectedMode | "trivial";
  /** This prompt's recall or reflex surfaced an active convention again. */
  hitActive: boolean;
  /** This prompt surfaced a new topic outside the active conventions. */
  hitOther?: boolean;
  /** A correspondence task or its clarification is already in progress. */
  correspondenceActive?: boolean;
  /** A standing rule alone can recover explicit compound approval, not recipient intent. */
  correspondenceHint?: boolean;
}

/** `next` null keeps the state; `unclear` asks the user with the choice line. */
export interface TaskDecision {
  next: TaskKind | null;
  unclear: boolean;
}

/**
 * The transition for one prompt. Explicit beats implicit: "translate only"
 * wins over a workflow announcement, an approval counts only while a draft is
 * under review (or as the explicit answer to the choice line), and quoted text
 * without a verb of the user's own is unclear rather than a guess. A prompt
 * with no cue, in a plain mode, that surfaced a new topic outside the active
 * conventions ends the task. A recall miss alone is not a task switch.
 */
export function decideTask(sig: TaskSignals, ctx: TaskContext): TaskDecision {
  const keep: TaskDecision = { next: null, unclear: false };
  const explicit = [sig.translate, sig.approvedCopy, sig.draftReply].filter(Boolean).length;
  if (explicit > 1) return { next: null, unclear: true };
  if (sig.translate) return { next: "translate-only", unclear: false };
  if (sig.approvedCopy && (ctx.current === "draft-for-review" || ctx.questionOpen)) return { next: "approved-copy", unclear: false };
  if (sig.approval && ctx.current === "draft-for-review" && !ctx.questionOpen && !sig.quoted) return { next: "approved-copy", unclear: false };
  if (sig.targetCopy && !sig.revision && !sig.quoted &&
      (ctx.current === "draft-for-review" || (sig.ack && (ctx.correspondenceActive || ctx.correspondenceHint)))) {
    return { next: "approved-copy", unclear: false };
  }
  if ((sig.sendPerson || sig.recipientFollowup) && (ctx.correspondenceActive || ctx.current !== "none")) return { next: "draft-for-review", unclear: false };
  if (sig.draftReply || sig.announce) return { next: "draft-for-review", unclear: false };
  if (sig.quoted) return sig.reply ? { next: "draft-for-review", unclear: false } : { next: null, unclear: true };
  if (ctx.questionOpen && sig.reply) return { next: "draft-for-review", unclear: false };
  if (ctx.mode === "trivial" || ctx.current === "none") return keep;
  const anyCue = sig.reply || sig.ack || sig.approvedCopy;
  if (!anyCue && !ctx.hitActive && ctx.hitOther === true && (ctx.mode === "none" || ctx.mode === "generic")) return { next: "none", unclear: false };
  return keep;
}
