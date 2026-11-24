/**
 * #1461: which agent already holds which rule kernel.
 *
 * The gate lane re-delivers the kernel after 25 tool calls without a prompt,
 * counted per agent (#1623, gate-lane-claims.ts).
 * With direct context delivery it remembers, per session and agent, the
 * fingerprint of the last full kernel and sends a reminder for identical
 * text. HTTP finish confirms transport only, so HTTP hooks repeat the kernel.
 *
 * The fingerprints live in the session's `constants`, which a compact or clear
 * drops as a whole (session-state.ts:clearShown) — after a context reset every
 * agent gets the full text again. A changed rule, a changed active convention
 * or a new agent changes or misses the fingerprint and gets it too.
 */
import { createHash } from "node:crypto";
import { hookAgent } from "./hook-surface.js";
import { confirmLaneDelivery, observesLaneContextDirectly } from "./lane-delivery.js";
import { kernelFingerprint } from "./rule-kernel.js";
import { loadSessionState, mutateSessionState } from "./session-state.js";

const SEEN_PREFIX = "rule-kernel-seen:";
/** Agents a session remembers; the one delivered to longest ago is forgotten first. */
const KERNEL_SEEN_CAP = 50;

export interface KernelSeen {
  key?: string;
  fingerprint: string;
}

/** #1623: a subagent's stable identity within a session (a hash of its
 *  agent_id), or null for the main agent and unattributed callers. */
export function kernelWorker(payload: { agent_id?: unknown }): string | null {
  if (hookAgent(payload) !== "subagent") return null;
  return createHash("sha256").update(JSON.stringify(payload.agent_id)).digest("hex");
}

/** Receipt identity for an attributed actor with direct context delivery. */
export function kernelSeen(payload: { agent_id?: unknown }, text: string): KernelSeen {
  const fingerprint = kernelFingerprint(text);
  if (!observesLaneContextDirectly()) return { fingerprint };
  const actor = hookAgent(payload);
  if (actor === null) return { fingerprint };
  const agent = actor === "main" ? "main" : "worker:" + kernelWorker(payload)!;
  return { key: SEEN_PREFIX + "v3:" + agent, fingerprint };
}

/** True when this agent's last full kernel in this session is byte-identical. */
export async function kernelUnchanged(sessionId: string, seen: KernelSeen): Promise<boolean> {
  if (!sessionId || !seen.key) return false;
  return (await loadSessionState(sessionId)).constants?.[seen.key] === seen.fingerprint;
}

/**
 * #1622: the session start delivers the full kernel too. Once that delivery is
 * confirmed, it counts as this agent's last full kernel, so an unchanged
 * kernel later in the same context is answered with the short reminder. A
 * kernel the context cap dropped, or a fallback text, is not recorded.
 */
export async function rememberSessionStartKernel(
  payload: { session_id?: string; agent_id?: unknown },
  text: string,
  injected: string
): Promise<void> {
  const sessionId = payload.session_id ?? "";
  if (!sessionId || !text.startsWith("<rule-kernel") || !injected.includes(text.trim())) return;
  const seen = kernelSeen(payload, text);
  if (!seen.key) return;
  await confirmLaneDelivery(
    async (delivered) => {
      if (delivered) await mutateSessionState(sessionId, (s) => rememberKernel((s.constants ??= {}), seen));
    },
    Date.now() + 5000,
    "context"
  );
}
/** Record a confirmed full delivery (mutates in place, inside the session lock). */
export function rememberKernel(constants: Record<string, string>, seen: KernelSeen): void {
  if (!seen.key) return;
  delete constants[seen.key];
  constants[seen.key] = seen.fingerprint;
  const keys = Object.keys(constants).filter((k) => k.startsWith(SEEN_PREFIX));
  for (const old of keys.slice(0, Math.max(0, keys.length - KERNEL_SEEN_CAP))) delete constants[old];
}
