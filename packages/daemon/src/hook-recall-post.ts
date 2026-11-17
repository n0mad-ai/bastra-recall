/**
 * #448: the one loopback call the write and plan lanes make to `/hook/recall`,
 * with the one body type (hook-surface.ts:HookRecallRequest). Both lanes used
 * to carry their own copy of the HTTP request; this goes through the shared
 * `postLane` transport the Bash lane already uses for the same route — hard
 * deadline, errors to the caller, which decides.
 */
import type { HookRecallRequest } from "./hook-surface.js";
import { postLane } from "./thin-client.js";

export async function postHookRecall<T>(baseUrl: string, body: HookRecallRequest, timeoutMs: number): Promise<T> {
  const raw = await postLane(baseUrl, "/hook/recall", body, timeoutMs);
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error("invalid JSON response from daemon");
  }
}
