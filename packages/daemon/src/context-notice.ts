/** Deduplicate generated protocol guidance, never inspect user wording.
 * The existing per-context constants store is dropped by clear/compact.
 * Failed persistence always returns the full text.
 */
import { createHash, randomUUID } from "node:crypto";
import { mutateSessionState, type SessionState } from "./session-state.js";
import { confirmLaneDelivery } from "./lane-delivery.js";

const PREFIX = "context-notice:";
export function resetContextNotices(state: SessionState): void {
  for (const key of Object.keys(state.constants ?? {})) {
    if (key.startsWith(PREFIX)) delete state.constants![key];
  }
}

export async function compactContextNotice(
  sessionId: string, key: string, binding: string, full: string, reminder: string,
): Promise<string> {
  if (!sessionId || !full) return full;
  const hash = createHash("sha256").update(binding).digest("hex");
  let unchanged = false;
  let epoch = "";
  const saved = await mutateSessionState(sessionId, state => {
    state.constants ??= {};
    epoch = state.constants[PREFIX + "epoch"] ??= randomUUID();
    unchanged = state.constants[PREFIX + key] === hash;
  });
  if (saved && !unchanged) await confirmLaneDelivery(async delivered => {
    if (!delivered) return;
    await mutateSessionState(sessionId, state => {
      if (state.constants?.[PREFIX + "epoch"] === epoch) state.constants[PREFIX + key] = hash;
    });
  }, Date.now() + 5000, "context");
  return saved && unchanged ? reminder : full;
}
