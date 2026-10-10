/** A separate UTC-day claim for the agent block; the CLI line keeps its own. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { formatModelSessionBlock, pendingModelNotice, type ModelOffer } from "./model-recommendation.js";
import { tryWithPathLock } from "./path-lock.js";

export function modelSessionHintPath(): string {
  return join(homedir(), ".bastra", "model-session-hint-shown.txt");
}

/** Only claim a day when its block is part of the prepared hook response.
 * Busy (including an orphaned lease), inaccessible or invalid output skips
 * silently. No queue, lease takeover or unlocked fallback on the hook path.
 * Like the CLI day marker, this is per user/day, not per recommendation ID. */
export async function appendModelSessionNotice(
  stdout: string,
  notice: () => Promise<ModelOffer | null> = pendingModelNotice,
  opts: { shownPath?: string; now?: number } = {},
): Promise<{ stdout: string; block: string }> {
  const skipped = { stdout, block: "" };
  try {
    const output = JSON.parse(stdout) as Record<string, unknown>;
    if (!output || typeof output !== "object" || Array.isArray(output)) return skipped;
    const existing = output.hookSpecificOutput;
    if (existing !== undefined && (!existing || typeof existing !== "object" || Array.isArray(existing))) return skipped;
    const hook = (existing ?? {}) as Record<string, unknown>;
    if (hook.hookEventName !== undefined && hook.hookEventName !== "SessionStart") return skipped;
    if (hook.additionalContext !== undefined && typeof hook.additionalContext !== "string") return skipped;
    const path = opts.shownPath ?? modelSessionHintPath();
    const day = new Date(opts.now ?? Date.now()).toISOString().slice(0, 10);
    await mkdir(dirname(path), { recursive: true });
    return (await tryWithPathLock(path, async () => {
      let raw = "";
      try { raw = await readFile(path, "utf8"); }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
      const days = raw.split("\n").map(line => line.trim()).filter(Boolean);
      if (days.includes(day)) return skipped;
      const offer = await notice();
      const block = offer ? formatModelSessionBlock(offer) : "";
      if (!block) return skipped;
      const context = (String(hook.additionalContext ?? "") + block).trimStart();
      const next = JSON.stringify({ ...output, hookSpecificOutput: { ...hook, hookEventName: "SessionStart", additionalContext: context } });
      await writeFile(path, [...days, day].slice(-30).join("\n") + "\n", { encoding: "utf8", mode: 0o600 });
      return { stdout: next, block };
    }, { crossProcess: true, noQueue: true })) ?? skipped;
  } catch { return skipped; }
}
