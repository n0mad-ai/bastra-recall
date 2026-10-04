/**
 * Statusline feed of the MCP forwarder — split out of mcp-forwarder.ts
 * (file-size convention, #680). Owns the in-memory `liveStatusline` copy and
 * its disk feed; mcp-forwarder.ts and mcp-forwarder-calls.ts mutate it.
 */
import * as fs from "node:fs";
import { claudeSessionPid, sessionFeedPath, STATUSLINE_DIR } from "./statusline-session.js";
import {
  adoptTurn,
  defaultStatuslineState,
  type StatuslineState,
} from "./statusline-feed.js";

// Feed is namespaced by the CC session (claude ancestor PID) so concurrent
// sessions don't clobber each other (CC sends no session id — #41836).
// Computed once at startup; the forwarder lives for the whole session.
const STATUSLINE_FEED_PATH = sessionFeedPath(claudeSessionPid());

/**
 * Statusline state — aggregated per Assistant-Turn. Read live by the
 * @bastra-recall/statusline `bastra` segment which renders it next to the
 * user's powerline. Claude Code does NOT render MCP notifications/progress
 * (issue #51713), so this file is the out-of-band channel.
 *
 * Ownership: this forwarder process owns the authoritative copy IN MEMORY
 * (single-threaded JS → concurrent recalls mutate it serially, no race).
 * The disk file is write-only from here, plus a single read at recall-start
 * to detect the prompt-hook's turn boundary (see `adoptTurn` / Issue #51).
 * State shape + the turn-boundary decision live in `statusline-feed.ts`.
 */
export let liveStatusline: StatuslineState = defaultStatuslineState();

/**
 * At recall start: adopt a fresh turn iff the prompt-hook stamped a new
 * `turn_id` (Issue #51 — replaces the old `state === "idle"` trigger that
 * let late idle markers clobber parallel-recall counts). This is the only
 * disk READ in the hot path. Keeps the latest vault_size across the reset.
 */
export function syncStatuslineTurn(): void {
  try {
    const onDisk = JSON.parse(
      fs.readFileSync(STATUSLINE_FEED_PATH, "utf8"),
    ) as Partial<StatuslineState>;
    liveStatusline = adoptTurn(liveStatusline, onDisk);
  } catch {
    // no file / unreadable — keep in-memory state
  }
}

let statuslineDirEnsured = false;

/** Flush in-memory state to disk (atomic). Write-only — never reads. */
export function flushStatusline(): void {
  try {
    if (!statuslineDirEnsured) {
      fs.mkdirSync(STATUSLINE_DIR, { recursive: true });
      statuslineDirEnsured = true;
    }
    liveStatusline.ts = Date.now();
    const tmp = `${STATUSLINE_FEED_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(liveStatusline), { encoding: "utf8" });
    fs.renameSync(tmp, STATUSLINE_FEED_PATH);
  } catch {
    // Best-effort — never fail the recall over a statusline write.
  }
}
