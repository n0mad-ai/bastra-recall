/** #1328: a review draft the assistant actually emitted binds the correspondence task. */
import { assistantReviewCues, cueRegex } from "./lexicon.js";
import { loadSessionState, mutateSessionState, recordActiveConventions, taskIdFor } from "./session-state.js";
import { expireReceipts } from "./receipt-store.js";
import type { TranscriptTurn } from "./stop-transcript.js";

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

/** Explicit fences or a lexicon-authored review heading prove a draft-shaped
 * output. Merely having emitted progress prose does not. */
export function hasReviewDraft(text: string, requireLabel = false): boolean {
  if (requireLabel && !cueRegex(assistantReviewCues()).test(text)) return false;
  const fenced = /^\s*(?:`{3,}|~{3,})[^\n]*\n[\s\S]*?\S/mu.test(text);
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
  const labelledBody = heading >= 0 && /\p{L}/u.test(lines.slice(heading + 1).join("\n"));
  return fenced || labelledBody;
}
