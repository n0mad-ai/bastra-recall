/** #1391: one ordinary-note advisory packet per session. Rule claims stay separate. */
import { randomUUID } from "node:crypto";
import { confirmLaneDelivery } from "./lane-delivery.js";
import { mutateSessionState } from "./session-state.js";

export async function githubAdvisoryOnce(sessionId: string, text: string, deadline: number): Promise<string> {
  if (!text) return "";
  try {
    const token = randomUUID();
    let claimed = false;
    const persisted = await mutateSessionState(sessionId, state => {
      const prior = state.githubAdvisory;
      if (prior && ("delivered" in prior || prior.deadline > Date.now())) return;
      state.githubAdvisory = { token, deadline };
      claimed = true;
    }, { noQueue: true, deadline });
    if (!persisted || !claimed) return "";
    await confirmLaneDelivery(async delivered => {
      await mutateSessionState(sessionId, state => {
        const current = state.githubAdvisory;
        if (!current || !("token" in current) || current.token !== token) return;
        if (delivered) state.githubAdvisory = { delivered: true };
        else delete state.githubAdvisory;
      });
    }, deadline, "context");
    return text;
  } catch { return ""; } // Optional advice must never suppress the rule result.
}
