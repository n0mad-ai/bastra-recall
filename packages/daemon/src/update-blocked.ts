import { bastraDataDir } from "./platform-paths.js";
/**
 * #268 — the report channel for an update that was held back.
 *
 * The unattended path has no reader. `spawnStagedUpdate()` (update-check.ts)
 * starts `bastra update --staged` detached with `stdio: "ignore"`, so every
 * line the preflight prints on a refusal goes nowhere — while the SessionStart
 * hook has ALREADY told the agent "bastra-recall is updating in the background:
 * X → Y … tell the user an update to Y is being applied". If the preflight then
 * refuses, the user has been told something that did not happen, the day
 * throttle is spent, and nothing in the system ever corrects the record.
 *
 * So the staged run leaves its verdict on disk. The next SessionStart reads it
 * and reports the truth instead of repeating the claim; a `bastra update` that
 * actually installs removes it again.
 *
 * Deliberately its own module rather than part of update-preflight.ts: the
 * writer is the CLI, the readers are the SessionStart hook and the daemon's
 * auto-trigger, and the hook runs on a 500 ms budget — it should not pull in
 * the hashing/spawn machinery of the preflight just to read one small JSON file.
 */
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { PreflightResult } from "./cli/update-preflight.js";

/** What the last unattended refusal was about. Written once, read until an
 *  update really runs. */
export interface BlockedUpdate {
  /** Version that was installed while the attempt was held back. */
  version: string;
  /** The refusal — already one user-facing line, straight from the verdict. */
  reason: string;
  /** The findings behind it, pre-rendered ("changed dist/index.js"). Empty when
   *  the refusal was not about files (a failed provenance check). */
  files: string[];
  /** Where the local versions were copied before the refusal. Absent when
   *  nothing was copied. */
  backup_dir?: string;
  /** ISO timestamp of the refusal. */
  blocked_at: string;
}

export function blockedUpdatePath(home = homedir()): string {
  return join(bastraDataDir(home), "update-blocked.json");
}

/**
 * Persist an unattended refusal. Best-effort by design: a report channel that
 * cannot be written must not turn a refusal into a crash — the worst case is
 * the silence we had before.
 */
export async function recordBlockedUpdate(
  verdict: PreflightResult,
  version: string,
  home = homedir(),
): Promise<void> {
  const record: BlockedUpdate = {
    version,
    reason: verdict.refusal ?? "the update preflight refused without naming a reason",
    files: verdict.dirty.map((d) => `${d.kind === "missing" ? "missing" : "changed"} ${d.path}`),
    ...(verdict.backupDir ? { backup_dir: verdict.backupDir } : {}),
    blocked_at: new Date().toISOString(),
  };
  try {
    const p = blockedUpdatePath(home);
    await mkdir(dirname(p), { recursive: true, mode: 0o700 });
    await writeFile(p, JSON.stringify(record, null, 2) + "\n", "utf8");
  } catch {
    // Best-effort — see above.
  }
}

/** The standing block, or null when there is none. A half-written or hand-edited
 *  file reads as "no block": a malformed record must not silence auto-updates. */
export async function readBlockedUpdate(home = homedir()): Promise<BlockedUpdate | null> {
  try {
    const parsed = JSON.parse(await readFile(blockedUpdatePath(home), "utf8")) as BlockedUpdate;
    if (typeof parsed.reason !== "string" || typeof parsed.blocked_at !== "string") return null;
    return { ...parsed, files: Array.isArray(parsed.files) ? parsed.files : [] };
  } catch {
    return null;
  }
}

/** Called by the update that actually installed something — the one event that
 *  resolves a block, whatever its cause was. */
export async function clearBlockedUpdate(home = homedir()): Promise<void> {
  try {
    await rm(blockedUpdatePath(home), { force: true });
  } catch {
    // A block that cannot be cleared costs one extra "run bastra update" hint,
    // never a failed update.
  }
}

/**
 * The body of the SessionStart notice. Lives next to the writer so the report
 * can never describe something the record does not hold — and states plainly
 * that nothing was installed, because the block file exists precisely to
 * replace a message that claimed the opposite.
 */
export function formatBlockedUpdate(b: BlockedUpdate): string {
  const lines = [
    `An automatic update was held back on ${b.blocked_at} (while running ${b.version}) and was NOT applied.`,
    `Reason: ${b.reason}`,
  ];
  if (b.files.length > 0) {
    const shown = b.files.slice(0, 10).join(", ");
    lines.push(`Affected: ${shown}${b.files.length > 10 ? `, … and ${b.files.length - 10} more` : ""}`);
  }
  if (b.backup_dir) lines.push(`Copies of the local versions: ${b.backup_dir}`);
  lines.push(
    "No further automatic update will be attempted until `bastra update` has run successfully — " +
      "the reason above does not resolve itself, so retrying it unattended would only reproduce it.",
  );
  return lines.join("\n");
}
