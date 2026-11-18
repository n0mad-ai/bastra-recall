/**
 * `bastra archive put|list|restore <path>|reconcile [--yes]` — the other half
 * of the archiving `rm` (rm-archive.ts): put a path in by hand, what went
 * where, put it back, and let the archive go of what it no longer needs to keep.
 */
import {
  applyReconcile,
  archiveCap,
  archiveMaxItem,
  manifestRows,
  reconcilePlan,
  restore,
  retainDays,
  runRmShim,
} from "../rm-archive.js";
import { getArchiveCap, getArchiveMaxItem, getArchiveRetain } from "../settings.js";
import type { ParsedArgs } from "./types.js";
import { taskCliLanguage } from "./task-cli-words.js";
import { usageBlocksIn } from "./usage-block-words.js";

/** The words `bastra archive` prints by language.primary (#1602), English when
 *  unset or unlisted. Text the product writes — never matched against user text. */
export const ARCHIVE_WORDS = {
  en: {
    putBack: "put back with: bastra archive restore <path>",
    noneRecent: "nothing archived in the last 30 days",
    restored: (target: string) => `restored ${target}`,
    removed: "removed",
    wouldRemove: "would remove",
    fine: "archive is fine: nothing to let go",
    restoreFailed: (message: string) => `bastra archive restore: ${message}`,
  },
  de: {
    putBack: "zurücklegen mit: bastra archive restore <pfad>",
    noneRecent: "in den letzten 30 Tagen nichts archiviert",
    restored: (target: string) => `zurückgelegt ${target}`,
    removed: "entfernt",
    wouldRemove: "würde entfernen",
    fine: "Archiv ist in Ordnung: nichts freizugeben",
    restoreFailed: (message: string) => `bastra archive restore: Fehler: ${message}`,
  },
};
export const archiveWordsIn = (language: string | undefined) =>
  ARCHIVE_WORDS[(language ?? "en") as keyof typeof ARCHIVE_WORDS] ?? ARCHIVE_WORDS.en;

export async function cmdArchive(args: ParsedArgs): Promise<number> {
  const sub = args.surface;
  const language = await taskCliLanguage().catch(() => "en");
  const w = archiveWordsIn(language);
  const usage = usageBlocksIn(language).archive;
  if (sub === "put") {
    // #1383: the archiving rm's own move, as a verb of its own — a user who
    // denies `Bash(rm:*)` can allow `Bash(bastra archive put:*)` on its own.
    const targets = args.positional.slice(2);
    if (targets.length === 0) {
      console.error(usage);
      return 2;
    }
    // The shim reads no settings file; the stored per-target limit rides along as for the lane.
    const maxItem = archiveMaxItem(process.env, await getArchiveMaxItem().catch(() => undefined));
    const env = maxItem === null ? process.env : { ...process.env, BASTRA_ARCHIVE_MAX_ITEM: `${maxItem}B` };
    let moved = 0;
    const rc = runRmShim(["-r", "-v", "--", ...targets], {
      env,
      archiveTemp: true,
      out: (s) => {
        moved++;
        console.log(s);
      },
      err: (s) => console.error(s.replace(/^rm: /, "bastra archive put: ")),
    });
    if (moved > 0) console.log(w.putBack);
    return rc;
  }
  if (sub === "list") {
    const cut = Date.now() - 30 * 86_400_000;
    const rows = manifestRows().filter((r) => new Date(r.ts).getTime() >= cut);
    if (args.json) console.log(JSON.stringify(rows));
    else if (rows.length === 0) console.log(w.noneRecent);
    else for (const r of rows) console.log(`${r.ts}  ${r.action.padEnd(8)}  ${r.orig}${r.dest ? `  → ${r.dest}` : ""}`);
    return 0;
  }
  if (sub === "restore") {
    const target = args.positional[2];
    if (!target) {
      console.error(usage);
      return 2;
    }
    try {
      console.log(w.restored(restore(target)));
      return 0;
    } catch (e) {
      console.error(w.restoreFailed((e as Error).message));
      return 1;
    }
  }
  if (sub === "reconcile") {
    const cap = archiveCap(process.env, await getArchiveCap());
    const drop = reconcilePlan(new Date(), cap, process.env, retainDays(process.env, await getArchiveRetain()));
    if (args.yes) applyReconcile(drop);
    const verb = args.yes ? w.removed : w.wouldRemove;
    console.log(drop.map((d) => `${verb}  ${d.orig}  (${d.why})`).join("\n") || w.fine);
    return 0;
  }
  console.error(usage);
  return 2;
}
