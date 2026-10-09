import { INJECTED_BLOCK_TAGS, scrubInjectedBlocks } from "@bastra-recall/core/scrub";
/**
 * Turns Claude Code and Codex deliver with role "user" although nobody typed
 * them (#639, #649, #703, #701). One predicate for every reader of user turns —
 * the Stop lane (transcript heuristics, and through it the after-session
 * harvest), the prompt lane (recall on UserPromptSubmit) and the bridge
 * harvest's query origin — so the lists cannot drift apart again.
 *
 * Only the START of the turn counts. An owner prompt that quotes one of these
 * tags mid-text, or in backticks, is still an owner prompt.
 */

/**
 * A background task or subagent finishing is delivered as a user-role turn
 * that opens with `<task-notification>` (#639), with or without attributes.
 * Its body is the subagent's own report.
 *
 * Agent-to-agent mail is delivered as a user-role turn too (#649); its body is
 * another agent's prose. Shapes seen in real Claude Code transcripts:
 * `<teammate-message teammate_id="…">` and `<agent-message from="…">`, either
 * at the start or after the line "Another Claude session sent a message:".
 * `<cross-session-message from="…">` is the form the SendMessage tool
 * documents for other sessions; no received sample was on disk.
 */
/**
 * Codex writes harness context as user-role rollout rows (#701). Seen on disk:
 * `<environment_context>` (date, timezone, workspace roots),
 * `<recommended_plugins>`, `<codex_internal_context source="goal">` (the
 * harness re-sending the thread goal) and `<send_user_message_question_reply>`
 * (a JSON array of `{question, answer}` — the answer is the user's, the row
 * is not a statement they typed).
 */
const CODEX_HARNESS_TAG = /^<(?:environment_context|recommended_plugins|codex_internal_context|send_user_message_question_reply)[\s>]/;
// Observed in local Codex rollouts: repository instructions are harness rows.
const AGENTS_INSTRUCTIONS = /^# AGENTS\.md instructions for (?:\/|\\|~|\.|[A-Za-z]:)[^\r\n]*\r?\n[ \t]*\r?\n[\s\S]*\S\s*$/;
const TURN_ABORTED = /^<turn_aborted>\r?\n[^\r\n]+\r?\n<\/turn_aborted>\s*$/;
const TASK_NOTIFICATION = /^<task-notification[\s>]/;
const AGENT_MAIL_WRAPPER = "Another Claude session sent a message:";
const AGENT_MAIL_TAG = /^<(?:teammate|agent|cross-session)-message(?:[\s>]|$)/i;

function isAgentMail(head: string): boolean {
  const body = head.startsWith(AGENT_MAIL_WRAPPER) ? head.slice(AGENT_MAIL_WRAPPER.length).trimStart() : head;
  return AGENT_MAIL_TAG.test(body);
}

/**
 * Other harness-written turns: the skill body (it documents the frustration
 * triggers itself — the second structural defect behind #48), system
 * reminders, slash-command echoes and a subagent's hand-back.
 */
const INJECTED_PREFIXES = ["Base directory for this skill:", "[Subagent hand-back]"];
const REMINDER_OPEN = "<system-reminder>";
const REMINDER_CLOSE = "</system-reminder>";
// Non-canonical tag spellings are harness-shaped too. Only the exact pair
// above may be stripped to recover owner text; other spellings fail closed.
const REMINDER_TAG_START = /^<\s*system(?:\s*-\s*|&#(?:x0*2d|0*45);?|&hyphen;?)\s*reminder(?=[\s/>])/i;
const REMINDER_TAG_ANY = /<\s*\/?\s*system(?:\s*-\s*|&#(?:x0*2d|0*45);?|&hyphen;?)\s*reminder(?=[\s/>])/gi;
// Raw CLI/tool output sometimes arrives as a user-role text wrapper (#1106).
const TOOL_WRAPPER_START = /^<(local-command-stdout|local-command-stderr|bash-input|bash-stdout|bash-stderr|command-message)(?=[\s/>])/i;
const TOOL_WRAPPER_TAG = /<\s*\/?\s*(?:local-command-stdout|local-command-stderr|bash-input|bash-stdout|bash-stderr|command-message)(?=[\s/>])/i;
const COMMAND_ECHO_PREFIXES = ["<command-name>", "<local-command-caveat>"];

function isCommandEcho(head: string): boolean {
  return COMMAND_ECHO_PREFIXES.some((p) => head.startsWith(p));
}

/** True when the turn is harness-written (notification, agent mail, Codex
 *  harness context, skill body, reminder, command echo, hand-back), not typed
 *  text. */
export function isSystemInjectedTurn(text: string): boolean {
  const head = text.trimStart().replace(/^[\u200b\u200d\u2060]+/,"");
  return (
    /^<draft-hints\b/i.test(head) ||
    TASK_NOTIFICATION.test(head) ||
    isAgentMail(head) ||
    CODEX_HARNESS_TAG.test(head) ||
    AGENTS_INSTRUCTIONS.test(head) ||
    TURN_ABORTED.test(head) ||
    REMINDER_TAG_START.test(head) ||
    isCommandEcho(head) ||
    TOOL_WRAPPER_START.test(head) ||
    INJECTED_PREFIXES.some((p) => head.startsWith(p))
  );
}

/**
 * The prompt lane's reading of a submitted prompt: the text the owner typed,
 * or null when the harness wrote all of it. Two shapes are read differently
 * from the transcript and log readers above:
 *
 * - A command echo is the expanded form of a slash command the owner typed.
 *   It is the owner's turn and comes back unchanged; the trivial gate skips
 *   the recall and still hands over a parked task-boundary block (#572).
 * - A leading `<system-reminder>` block is harness text, but a harness may
 *   put it in front of what the owner typed. The text after its closing tag
 *   is the prompt; a reminder with nothing after it, or one that
 *   never closes, is a harness turn.
 */
export function ownerPromptText(prompt: string): string | null {
  const head = textAfterToolWrappers(prompt);
  if (head === null) return null;
  if (isCommandEcho(head)) return head;
  if (isSystemInjectedTurn(head)) return null;
  const owner = textBeforeAgentBand(head);
  if (owner === null || isSystemInjectedTurn(owner)) return null;
  if (!carriesInjectedBlock(owner)) return owner;
  // A block the daemon injected can hide a band behind it. Only then is the
  // prompt cut; a block the owner quotes comes back as they typed it.
  const scrubbed = scrubInjectedBlocks(owner).text;
  const typed = textBeforeAgentBand(scrubbed);
  if (typed === null || isSystemInjectedTurn(typed)) return null;
  return typed === scrubbed.trim() ? owner : typed;
}

/**
 * Linear gate in front of `scrubInjectedBlocks`: its block pattern rescans the
 * rest of the text for every opening tag that never closes, which is quadratic
 * on a megabyte of them. No closing tag after an opening one, nothing to remove.
 */
export function carriesInjectedBlock(text: string): boolean {
  const lower = text.toLowerCase();
  if (!lower.includes("</")) return false;
  return INJECTED_BLOCK_TAGS.some((tag) => {
    const open = lower.indexOf(`<${tag}`);
    return open >= 0 && lower.indexOf(`</${tag}>`, open) >= 0;
  });
}

/**
 * Complete backtick quotations blanked to spaces; offsets and line breaks are
 * kept. A run of backticks closes at the next run of the same length, a run
 * without one is literal. A scanner, not a back-referencing pattern: that one
 * took 47 s on a megabyte of shrinking runs.
 */
function maskBacktickQuotes(text: string): string {
  const runs: Array<{ start: number; length: number }> = [];
  for (let i = text.indexOf("`"); i >= 0; ) {
    let end = i + 1;
    while (text[end] === "`") end++;
    runs.push({ start: i, length: end - i });
    i = text.indexOf("`", end);
  }
  if (runs.length < 2) return text;
  const sameLength = new Map<number, number[]>();
  runs.forEach((run, r) => {
    const list = sameLength.get(run.length);
    if (list) list.push(r);
    else sameLength.set(run.length, [r]);
  });
  // Per length, the position in its list only moves forward.
  const cursor = new Map<number, number>();
  const parts: string[] = [];
  let last = 0;
  for (let r = 0; r < runs.length; r++) {
    const { start, length } = runs[r];
    const list = sameLength.get(length)!;
    let c = cursor.get(length) ?? 0;
    while (c < list.length && list[c] <= r) c++;
    cursor.set(length, c);
    if (c === list.length) continue;
    const close = runs[list[c]];
    parts.push(text.slice(last, start), text.slice(start, close.start + length).replace(/[^\r\n]/g, " "));
    last = close.start + length;
    r = list[c];
  }
  parts.push(text.slice(last));
  return parts.join("");
}

// An attribute or the end of the text (cut delivery) makes the tag a band on
// its own. A bare tag followed by a space and more words, never closed, is a
// sentence about the tag.
const AGENT_BAND = /(^|\r?\n)([ \t\u200b\u200d\u2060]*)<(?:agent|teammate|cross-session)-message(?:(?=(\s+[\w-]+=|\s*$))|(?=[\s>]))/gi;
const AGENT_BAND_PROSE = />[ \t]+\S/y;
const AGENT_BAND_CLOSE = /<\/(?:agent|teammate|cross-session)-message\s*>/gi;

/** Four columns of indentation after a blank line: a Markdown code block. */
function isIndentedCode(text: string, lineBreak: number, indent: string): boolean {
  if (!indent.includes("\t") && indent.split(" ").length <= 4) return false;
  let i = lineBreak - 1;
  while (i >= 0 && (text[i] === " " || text[i] === "\t" || text[i] === "\r")) i--;
  return i >= 0 && text[i] === "\n";
}

/**
 * A line-start agent band ends owner evidence. The line start is the one in
 * the text as written: a tag after a backtick quotation on the same line, or
 * inside one, is data, and so is one in an indented code block.
 */
export function textBeforeAgentBand(text: string): string | null {
  let unquoted: string | undefined;
  let lastClose: number | undefined;
  let marker: number | undefined;
  for (const match of text.matchAll(AGENT_BAND)) {
    const tag = match.index + match[1].length + match[2].length;
    if (match[1] && isIndentedCode(text, match.index, match[2])) continue;
    unquoted ??= maskBacktickQuotes(text);
    if (unquoted[tag] !== "<") continue;
    AGENT_BAND_PROSE.lastIndex = match.index + match[0].length;
    if (match[3] === undefined && AGENT_BAND_PROSE.test(text)) {
      if (lastClose === undefined) {
        lastClose = -1;
        for (const close of unquoted.matchAll(AGENT_BAND_CLOSE)) lastClose = close.index;
      }
      if (lastClose < tag) continue;
    }
    marker = match.index;
    break;
  }
  const owner = (marker === undefined ? text : text.slice(0, marker)).trimStart();
  return owner.trim() && !(marker !== undefined && owner.trim() === AGENT_MAIL_WRAPPER) ? owner.trimEnd() : null;
}

/** Recover owner prose after complete leading tool wrappers. Never use the
 * wrapper body as evidence. Broken/noncanonical/nested wrappers fail closed;
 * inline/backtick tag quotes are untouched. Bounded to avoid a parsing budget hole. */
export function textAfterToolWrappers(text: string): string | null {
  let rest = textAfterReminders(text);
  let stripped = false;
  for (let i = 0; i < 16 && rest !== null; i++) {
    const match = TOOL_WRAPPER_START.exec(rest);
    if (!match) {
      // A printed closing delimiter must not promote the rest of tool output.
      // Complete backtick quotations in a genuine suffix remain ordinary text.
      return stripped && TOOL_WRAPPER_TAG.test(rest) && TOOL_WRAPPER_TAG.test(maskBacktickQuotes(rest)) ? null : rest;
    }
    const tag = match[1];
    // Detection is case-insensitive, but only canonical pairs can recover prose.
    const open = new RegExp(`^<${tag}(?:[ \t]+[^>\r\n]*)?>`).exec(rest);
    if (!open || tag !== tag.toLowerCase()) return null;
    const close = `</${tag}>`;
    const end = rest.indexOf(close, open[0].length);
    if (end < 0 || TOOL_WRAPPER_TAG.test(rest.slice(open[0].length, end))) return null;
    stripped = true;
    rest = textAfterReminders(rest.slice(end + close.length));
  }
  return null;
}

/**
 * The text after ONE leading `<system-reminder>` block, or null when nothing
 * follows it, it never closes, or the rest still carries a reminder tag. A
 * reminder's inner content is not typed by the owner (hook output, file
 * contents), so a fake closing tag inside it must not promote what follows to
 * the owner's words: several or nested tags make the whole turn harness text
 * (#994). Text without a leading block comes back trimmed at the start only.
 */
export function textAfterReminders(text: string): string | null {
  const head = text.trimStart();
  if (!head.startsWith(REMINDER_OPEN)) return head.length === 0 || REMINDER_TAG_START.test(head) ? null : head;
  const end = head.indexOf(REMINDER_CLOSE);
  if (end === -1) return null;
  const tags = [...head.matchAll(REMINDER_TAG_ANY)];
  if (tags.length !== 2 || tags[0].index !== 0 || tags[1].index !== end) return null;
  const rest = head.slice(end + REMINDER_CLOSE.length).trimStart();
  if (rest.length === 0) return null;
  return rest;
}


/** A line-start band appended to typed owner prose is never owner evidence,
 * even if delivery was cut before its closing tag. Inline quoted tags stay prose. */
export function textBeforeDraftBand(text: string): string {
  const start = /(?:^|\r?\n)[ \t]*<draft-hints\b[^>\r\n]*(?:>|$)/i.exec(text);
  return start ? text.slice(0, start.index).trimEnd() : text;
}
