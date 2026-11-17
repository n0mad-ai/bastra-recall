/**
 * #1461: which agent already holds which rule kernel.
 *
 * The gate lane re-delivers the kernel after 25 tool calls without a prompt.
 * Subagents share their parent's session id and count, so one long session
 * sent the same 9,400 characters to the same agents dozens of times. The gate
 * now remembers, per session and per agent (one subagent, or the main thread),
 * the fingerprint of the last kernel it delivered in full; an identical kernel
 * goes out as a short reminder (rule-kernel.ts:renderKernelReminder).
 *
 * The fingerprints live in the session's `constants`, which a compact or clear
 * drops as a whole (session-state.ts:clearShown) — after a context reset every
 * agent gets the full text again. A changed rule, a changed active convention
 * or a new agent changes or misses the fingerprint and gets it too.
 */
import { kernelFingerprint } from "./rule-kernel.js";
import { loadSessionState } from "./session-state.js";

const SEEN_PREFIX = "rule-kernel-seen:";
/** Agents a session remembers; the one delivered to longest ago is forgotten first. */
export const KERNEL_SEEN_CAP = 50;

export interface KernelSeen {
  key: string;
  fingerprint: string;
}

/** The kernel `text` as received by `agentId` (absent: the main thread). */
export function kernelSeen(agentId: unknown, text: string): KernelSeen {
  const agent = typeof agentId === "string" && agentId ? agentId.slice(0, 200) : "main";
  return { key: SEEN_PREFIX + agent, fingerprint: kernelFingerprint(text) };
}

/** True when this agent's last full kernel in this session is byte-identical. */
export async function kernelUnchanged(sessionId: string, seen: KernelSeen): Promise<boolean> {
  if (!sessionId) return false;
  return (await loadSessionState(sessionId)).constants?.[seen.key] === seen.fingerprint;
}

/** Record a confirmed full delivery (mutates in place, inside the session lock). */
export function rememberKernel(constants: Record<string, string>, seen: KernelSeen): void {
  delete constants[seen.key];
  constants[seen.key] = seen.fingerprint;
  const keys = Object.keys(constants).filter((k) => k.startsWith(SEEN_PREFIX));
  for (const old of keys.slice(0, Math.max(0, keys.length - KERNEL_SEEN_CAP))) delete constants[old];
}
