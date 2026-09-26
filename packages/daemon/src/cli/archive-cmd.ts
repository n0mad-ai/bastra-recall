/**
 * `bastra archive list|restore <path>|reconcile [--yes]` — the other half of
 * the archiving `rm` (rm-archive.ts): what went where, put it back, and let
 * the archive go of what it no longer needs to keep.
 */
import { applyReconcile, manifestRows, reconcilePlan, restore, retainDays } from "../rm-archive.js";
import { getArchiveRetain } from "../settings.js";
import type { ParsedArgs } from "./types.js";

const USAGE =
  "usage: bastra archive list                 what the agent's rm archived (last 30 days)\n" +
  "       bastra archive restore <path>       put it back at its original path\n" +
  "       bastra archive reconcile [--yes]    show (or, with --yes, remove) what the archive can let go\n" +
  "retention: bastra config set archive.retain junk=1,in-git=2,user=2  (days; env BASTRA_ARCHIVE_RETAIN wins)";

export async function cmdArchive(args: ParsedArgs): Promise<number> {
  const sub = args.surface;
  if (sub === "list") {
    const cut = Date.now() - 30 * 86_400_000;
    const rows = manifestRows().filter((r) => new Date(r.ts).getTime() >= cut);
    if (args.json) console.log(JSON.stringify(rows));
    else if (rows.length === 0) console.log("nothing archived in the last 30 days");
    else for (const r of rows) console.log(`${r.ts}  ${r.action.padEnd(8)}  ${r.orig}${r.dest ? `  → ${r.dest}` : ""}`);
    return 0;
  }
  if (sub === "restore") {
    const target = args.positional[2];
    if (!target) {
      console.error(USAGE);
      return 2;
    }
    try {
      console.log(`restored ${restore(target)}`);
      return 0;
    } catch (e) {
      console.error(`bastra archive restore: ${(e as Error).message}`);
      return 1;
    }
  }
  if (sub === "reconcile") {
    const drop = reconcilePlan(new Date(), 10 * 2 ** 30, process.env, retainDays(process.env, await getArchiveRetain()));
    if (args.yes) applyReconcile(drop);
    const verb = args.yes ? "removed" : "would remove";
    console.log(drop.map((d) => `${verb}  ${d.orig}  (${d.why})`).join("\n") || "archive is fine: nothing to let go");
    return 0;
  }
  console.error(USAGE);
  return 2;
}
