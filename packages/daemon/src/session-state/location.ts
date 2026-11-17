/**
 * #1322: where a session's state and the load markers live — the state
 * directory and the sanitized keys every reader and writer agrees on.
 */
import * as path from "node:path";
import { resolveStatePath } from "../state-path.js";
import { defaultHookStateDir } from "../private-state-dir.js";

/** Cleanup: drop session files older than this (mtime). #354: this has to
 *  outlive a working day. At the old 4h it deleted the state of a session that
 *  was still running and re-opened exactly the hole the dedup closes. */
export const STATE_MAX_AGE_MS = 36 * 60 * 60 * 1000;

export function sessionStateDir(): string {
  return process.env.BASTRA_HOOK_STATE_DIR || defaultHookStateDir();
}

export function sessionFile(sessionId: string, dir = sessionStateDir()): string {
  // sanitize — defensive; session ids should be UUIDs but a stray slash
  // would let an attacker write outside the dir.
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return resolveStatePath(dir, path.join(dir, `${safe}.json`));
}

export function loadedMarkerFile(memId: string, dir = sessionStateDir()): string {
  const safe = memId.replace(/[^a-zA-Z0-9_.\-]/g, "_");
  return resolveStatePath(dir, path.join(dir, `loaded-${safe}.touch`));
}

export function stateKey(sessionId: string, dir = sessionStateDir()): string {
  return path.basename(sessionFile(sessionId, dir), ".json");
}
