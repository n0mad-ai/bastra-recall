/**
 * Stop lane — what a same-turn save suggestion looks like (#662, #757).
 *
 * Claude Code hands a Stop hook's `hookSpecificOutput.additionalContext` to
 * the agent in the running turn, and prints it to the user in full under
 * "Stop hook feedback" (measured on 2.1.286; `suppressOutput` has no effect
 * and `decision: "block"` prints its `reason` as "Stop hook error"). There is
 * no agent-only channel, so two things keep the display bearable:
 *
 *  - `systemMessage` carries one line for the user, in their language, shown
 *    as "Stop says: …" above the feedback: what this is, and that there is
 *    nothing to do.
 *  - the agent block is as short as it can be — one instruction, one line per
 *    suggestion. The suggestion body already says what to save and when, so
 *    the wrapper does not repeat it.
 */
import type { SaveSuggestion } from "./stop-heuristics.js";

/** The user-facing line, by `language.primary`. Text the product writes — it
 *  is never matched against anything. An unlisted language gets English. */
const NOTICE_BY_LANGUAGE: Readonly<Record<string, string>> = {
  en: "bastra-recall is checking whether anything from this conversation is worth remembering — nothing for you to do.",
  de: "bastra-recall prüft, ob sich aus diesem Gespräch etwas zu merken lohnt — du musst nichts tun.",
  ru: "bastra-recall проверяет, стоит ли что-то запомнить из этого разговора — вам ничего делать не нужно.",
};

export function sameTurnNotice(language: string | undefined): string {
  return NOTICE_BY_LANGUAGE[language ?? "en"] ?? NOTICE_BY_LANGUAGE.en;
}

export function formatSameTurnBlock(suggestions: SaveSuggestion[]): string {
  return [
    `<save-eval-now source="stop-hook">`,
    `bastra-recall memory check (Stop hook). Judge each line from this conversation: ` +
      `save it via save_memory if it holds, otherwise end the turn without comment.`,
    ...suggestions.map((s) => `- ${s.heuristic}: ${s.body}`),
    `</save-eval-now>`,
  ].join("\n");
}
