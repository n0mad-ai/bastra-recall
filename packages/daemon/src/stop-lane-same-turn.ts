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

/** #1311: the instruction a Stop without a valid receipt hands back (stop-repair.ts). */
export const REPAIR_INSTRUCTION =
  "Copy task without validated receipt: run validate_artifact on the final text before delivering; later edits need a new receipt";

const OVERLENGTH_NOTICE: Readonly<Record<string,string>> = {
 en:"bastra-recall: the copy text exceeds the rule limit — the agent is asked to shorten it.",
 de:"bastra-recall: Der Kopiertext überschreitet die Regelgrenze — der Agent soll ihn kürzen.",
 ru:"bastra-recall: текст превышает ограничение правила — агент должен сократить его.",
};
const RECEIPT_NOTICE: Readonly<Record<string,string>> = {
 en:"bastra-recall: the copy text has no validation receipt yet — the agent is asked to validate it.",
 de:"bastra-recall: Für den Kopiertext fehlt noch der Prüfbeleg — der Agent soll ihn prüfen.",
 ru:"bastra-recall: для текста копии ещё нет подтверждения проверки — агента просят его проверить.",
};
type RepairCause={reason:"overlength"|"missing-receipt";ruleIds:string[]};
export function repairNotice(language:string|undefined,cause:RepairCause):string {
 const messages=cause.reason==="overlength"?OVERLENGTH_NOTICE:RECEIPT_NOTICE;
 return (messages[language??"en"]??messages.en)+` (${cause.ruleIds.join(", ")})`;
}
export function formatRepairBlock(attempt:number,max:number,cause:RepairCause):string {
 const instruction=cause.reason==="overlength"?
  "Copy text exceeds the rule limit: shorten the copy blocks to the applicable limit, then run validate_artifact on the final text":REPAIR_INSTRUCTION;
 return [`<copy-repair source="stop-hook" attempt="${attempt}/${max}">`,`${instruction}. Rules: ${cause.ruleIds.join(", ")}`,`</copy-repair>`].join("\n");
}
