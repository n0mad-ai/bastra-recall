/** #1328: a review draft the assistant actually emitted binds the correspondence task. */
import { assistantReviewCues, cueRegex } from "./lexicon.js";
import { loadSessionState, mutateSessionState, recordActiveConventions, taskIdFor } from "./session-state.js";
import { expireReceipts } from "./receipt-store.js";
import type { TranscriptTurn } from "./stop-transcript.js";
import { ownerPromptText } from "./system-turn.js";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

/** A fence is a command only when its first word names an executable on
 * this host. Shell syntax alone also accepts ordinary natural language. */
function commandFence(body: string): boolean {
  const first = /^\s*(?:\$\s+)?([\w./-]+)(?:\s|$)/u.exec(body)?.[1];
  if (!first) return false;
  const paths = first.includes("/") ? [first] : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map(path => join(path, first));
  return paths.some(path => { try { accessSync(path, constants.X_OK); return true; } catch { return false; } });
}

/** Output evidence is independent of repair being enabled and of declaration
 * time: a declaration can follow the draft in the same owner turn. */
export async function recordDraftPresentation(sessionId: string | undefined, turns: readonly TranscriptTurn[]): Promise<void> {
  if (!sessionId) return;
  const snapshot = await loadSessionState(sessionId);
  const task = snapshot.activeTask;
  if (task?.kind !== "draft-for-review") return;
  let start = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    const owner = !turn.isMeta && !turn.stop_hook_active && [turn.source, turn.origin].every(source => {
      if (source === undefined) return true;
      const kind = typeof source === "object" ? source.kind : source;
      return kind === "user" || kind === "human" || kind === "typed";
    });
    if (turn.ownerBoundary || (turn.role === "user" && owner && (ownerPromptText(turn.content) !== null || !turn.content.trim()))) { start = i + 1; break; }
  }
  const texts = turns.slice(start).filter(t => t.role === "assistant" && t.content.trim()).map(t => t.content);
  if (!texts.length) return;
  const presented = texts.some(text => hasReviewDraft(text));
  await mutateSessionState(sessionId, s => {
    if (s.activeTask?.id === task.id && s.activeTask.generation === task.generation && s.activeTask.kind === "draft-for-review") s.activeTask.draftPresented = presented;
  }, { noQueue: true, deadline: Date.now() + 100 });
}

export async function recordReviewDraft(sessionId: string | undefined, turns: readonly TranscriptTurn[]): Promise<void> {
  if (!sessionId) return;
  const latest = turns.at(-1);
  // A prior assistant turn or quoted user text is not evidence of this answer.
  if (latest?.role !== "assistant") return;
  if (!hasReviewDraft(latest.content, true)) return;
  const snapshot = await loadSessionState(sessionId);
  if (snapshot.activeTask && snapshot.activeTask.kind !== "none") return;
  const hasConvention = (snapshot.activeConventions ?? []).some(c => c.validator) ||
    (snapshot.loadedConventions ?? []).some(c => c.validator) ||
    (snapshot.correspondenceContext?.generation === (snapshot.activeTask?.generation ?? 0) &&
      (snapshot.correspondenceContext.conventions?.length ?? 0) > 0);
  if (!hasConvention) return;
  const now = Date.now();
  await mutateSessionState(sessionId, s => {
    if (s.activeTask && s.activeTask.kind !== "none") return;
    const question = s.correspondenceContext?.generation === (s.activeTask?.generation ?? 0) ? s.correspondenceContext : undefined;
    if (!(s.activeConventions ?? []).some(c => c.validator) &&
        !(s.loadedConventions ?? []).some(c => c.validator) && !question?.conventions?.length) return;
    s.activeTask = { id: taskIdFor("draft-for-review", now), kind: "draft-for-review", since: now, draftPresented: true,
      generation: s.activeTask?.generation ?? 0, ...(s.userValidatorChannel?{validatorChannel:s.userValidatorChannel}:{}) };
    expireReceipts(s);
    const asked = question?.conventions ?? [];
    if (asked.length) recordActiveConventions(s, asked.map(c => ({
      ...s.activeConventions?.find(active => active.id === c.id), ...c, scope: "task" as const,
    })), now);
    delete s.correspondenceContext;
  }, { noQueue: true, deadline: now + 100 });
}

/** In an active review task ordinary substantive prose counts too. A command
 * or clarification question is not a draft. Labels only discover new tasks. */
export function hasReviewDraft(text: string, requireLabel = false): boolean {
  if (requireLabel && !cueRegex(assistantReviewCues()).test(text)) return false;
  const fences = [...text.matchAll(/^\s*(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)^\s*\1\s*$/gmu)];
  const fenced = fences.some(m => !["bash", "sh", "zsh", "shell", "console", "powershell", "cmd"].includes(m[2].trim().toLowerCase()) &&
    !commandFence(m[3]) && m[3].trim().length >= 8);
  const fencePattern = /^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1\s*$/gmu;
  const prose = text.replace(fencePattern, "").trim();
  const lines = text.split("\n");
  const reviewLabel = new RegExp(`^(?:${assistantReviewCues().join("|")})$`, "iu");
  const heading = lines.findIndex(line => {
    const trimmed = line.trim();
    // Markdown already marks the heading boundary; it needs no colon.
    // Plain text still needs one. Match the complete lexicon caption so a
    // progress sentence mentioning a draft cannot attest its delivery.
    const markdown = /^#{1,6}\s+(.+?)(?:\s+#+)?$/u.exec(trimmed)?.[1] ??
      /^(\*\*|__)(.+?)\1$/u.exec(trimmed)?.[2];
    const caption = markdown ?? /^(.*?)[：:]$/u.exec(trimmed)?.[1];
    return caption !== undefined && reviewLabel.test(caption.replace(/[：:]\s*$/u, "").trim());
  });
  const bodyProse = heading >= 0 ? lines.slice(heading + 1).join("\n").replace(fencePattern, "") : prose;
  const plainBody = bodyProse.split("\n").filter(line => !/^\s*(?:#{1,6}\s|(?:\*\*|__)[^\n]+(?:\*\*|__)\s*$)/u.test(line)).join("\n").trim();
  const labelledBody = heading >= 0 && /\p{L}/u.test(plainBody);
  // A lone opening question is clarification even under a draft caption.
  // A draft may still contain a question after its greeting or other prose.
  const questionOnlyOpening = /^[^\n.!?？]*[?？](?:\s|$)/u.test(plainBody);
  if (!fenced && questionOnlyOpening) return false;
  return fenced || labelledBody || (!requireLabel && plainBody.length >= (fences.length ? 24 : 8) && /\s/u.test(plainBody));
}
