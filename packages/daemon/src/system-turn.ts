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
 * that opens with `<task-notification>` (#639). Its body is the subagent's own
 * report.
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
const TASK_NOTIFICATION = "<task-notification>";
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
const INJECTED_PREFIXES = [
  "Base directory for this skill:",
  "<system-reminder>",
  "<command-name>",
  "<local-command-caveat>",
  "[Subagent hand-back]",
];

/** True when the turn is harness-written (notification, agent mail, Codex
 *  harness context, skill body, reminder, command echo, hand-back), not typed
 *  text. */
export function isSystemInjectedTurn(text: string): boolean {
  const head = text.trimStart();
  return (
    head.startsWith(TASK_NOTIFICATION) ||
    isAgentMail(head) ||
    CODEX_HARNESS_TAG.test(head) ||
    INJECTED_PREFIXES.some((p) => head.startsWith(p))
  );
}
