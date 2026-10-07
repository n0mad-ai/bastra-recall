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
const AGENTS_INSTRUCTIONS = /^# AGENTS\.md instructions for \/[^\r\n]+\r?\n[ \t]*\r?\n[\s\S]*\S\s*$/;
const TURN_ABORTED = /^<turn_aborted>\r?\n[^\r\n]+\r?\n<\/turn_aborted>\s*$/;
const TASK_NOTIFICATION = /^<task-notification[\s>]/;
const AGENT_MAIL_WRAPPER = "Another Claude session sent a message:";
const AGENT_MAIL_TAG = /^<(?:teammate|agent|cross-session)-message[\s>]/;

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
const COMMAND_ECHO_PREFIXES = ["<command-name>", "<local-command-caveat>"];

function isCommandEcho(head: string): boolean {
  return COMMAND_ECHO_PREFIXES.some((p) => head.startsWith(p));
}

/** True when the turn is harness-written (notification, agent mail, Codex
 *  harness context, skill body, reminder, command echo, hand-back), not typed
 *  text. */
export function isSystemInjectedTurn(text: string): boolean {
  const head = text.trimStart();
  return (
    TASK_NOTIFICATION.test(head) ||
    isAgentMail(head) ||
    CODEX_HARNESS_TAG.test(head) ||
    AGENTS_INSTRUCTIONS.test(head) ||
    TURN_ABORTED.test(head) ||
    REMINDER_TAG_START.test(head) ||
    isCommandEcho(head) ||
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
  const head = textAfterReminders(prompt);
  if (head === null) return null;
  if (isCommandEcho(head)) return head;
  return isSystemInjectedTurn(head) ? null : head;
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
