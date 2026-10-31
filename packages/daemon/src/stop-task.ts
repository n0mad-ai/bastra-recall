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
  if (!cueRegex(assistantReviewCues()).test(latest.content)) return;
  const fenced = /```[^\n]*\n[\s\S]*?\S[\s\S]*?\n```/u.test(latest.content);
  const lines = latest.content.split("\n");
  const heading = lines.findIndex(line => cueRegex(assistantReviewCues(), true).test(line.replace(/^[#*\s]+/u, "")) && /[:：][*\s]*$/u.test(line));
  const labelledBody = heading >= 0 && /\p{L}/u.test(lines.slice(heading + 1).join("\n"));
  if (!fenced && !labelledBody) return;
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
    s.activeTask = { id: taskIdFor("draft-for-review", now), kind: "draft-for-review", since: now,
      generation: s.activeTask?.generation ?? 0, ...(s.userValidatorChannel?{validatorChannel:s.userValidatorChannel}:{}) };
    expireReceipts(s);
    const asked = question?.conventions ?? [];
    if (asked.length) recordActiveConventions(s, asked.map(c => ({
      ...s.activeConventions?.find(active => active.id === c.id), ...c, scope: "task" as const,
    })), now);
    delete s.correspondenceContext;
  }, { noQueue: true, deadline: now + 100 });
}
