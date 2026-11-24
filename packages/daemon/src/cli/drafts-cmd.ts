/** Local draft administration (#1084). Local store operations; undo resolves a vault without contacting the daemon. */
import { PendingRelayAccessError } from "../pending-suggestions.js";
import { Vault } from "@bastra-recall/core";
import { undoDraftPromotion } from "../draft-promote.js";
import { resolveVault } from "./helpers.js";
import { DRAFT_MAX_ROWS, listDrafts, purgeDrafts } from "../draft-store.js";
import { rejectDrafts } from "../draft-review.js";
import type { ParsedArgs } from "./types.js";
import { usageWordsIn } from "./usage-words.js";
import { draftsCmdWordsIn, type DraftsCmdWords } from "./drafts-cmd-words.js";
import { taskCliLanguage } from "./task-cli-words.js";

/** #1592: at the row cap the oldest confirmed drafts make room for new
 *  captures; say so where the user looks at the store. */
function writeFullStoreNotice(rows: number, w: DraftsCmdWords): void {
  if (rows < DRAFT_MAX_ROWS) return;
  process.stdout.write(w.storeFull(rows, DRAFT_MAX_ROWS));
}

export async function cmdDrafts(args: ParsedArgs): Promise<number> {
  const sub = args.positional[1] ?? "list";
  const language = await taskCliLanguage().catch(() => "en");
  const w = draftsCmdWordsIn(language);
  if (
    !["list", "purge", "undo", "reject"].includes(sub) ||
    (sub !== "reject" && args.positional.length > (sub === "undo" ? 3 : 2)) ||
    ((sub === "undo" || sub === "reject") && !args.positional[2])
  ) {
    process.stderr.write(usageWordsIn(language).drafts);
    return 2;
  }
  try {
    if (sub === "undo") {
      const resolved = await resolveVault(args);
      if ("error" in resolved) {
        process.stderr.write(w.noVault);
        return 1;
      }
      const vault = new Vault(resolved.path);
      try {
        await vault.init();
        const memoryId = await undoDraftPromotion(vault, args.positional[2], Date.now(), args.force);
        process.stdout.write(args.json ? JSON.stringify({ undone: memoryId }) + "\n" : w.undone(memoryId));
      } finally {
        await vault.stop();
      }
    } else if (sub === "reject") {
      const results = await rejectDrafts(args.positional.slice(2));
      if (args.json) process.stdout.write(JSON.stringify({ results }) + "\n");
      else
        for (const r of results) {
          if (r.outcome === "rejected") process.stdout.write(w.rejected(r.id));
          else if (r.outcome === "already_rejected") process.stdout.write(w.alreadyRejected(r.id));
          else if (r.outcome === "promoted") process.stderr.write(w.alreadyPromoted(r.id));
          else process.stderr.write(w.noOpenDraft(r.id));
        }
      // An already rejected draft is closed; only promoted and unknown ids fail.
      return results.every((r) => r.outcome === "rejected" || r.outcome === "already_rejected") ? 0 : 1;
    } else if (sub === "purge") {
      const { pendingRelay } = await purgeDrafts();
      const cleared = ["drafts", "vectors", "decisions", ...(pendingRelay ? ["pending-relay"] : [])];
      process.stdout.write(
        args.json
          ? JSON.stringify({ purged: true, cleared, ...(!pendingRelay ? { pending_relay: "absent" } : {}) }) + "\n"
          : w.purged(pendingRelay)
      );
    } else {
      const rows = await listDrafts();
      if (args.json) process.stdout.write(JSON.stringify(rows) + "\n");
      else if (!rows.length) process.stdout.write(w.noDrafts);
      else {
        for (const row of rows) {
          process.stdout.write(
            `${row.id}  ${row.state}  ${new Date(row.last_touched).toISOString()}\n  ${row.quote.replace(/[\r\n\x00-\x1f\x7f]/g, " ")}\n`
          );
        }
        writeFullStoreNotice(rows.length, w);
      }
    }
    return 0;
  } catch (error) {
    let message = error instanceof Error ? error.message : "";
    if (message === "note changed since promotion") message += "; review it and use --force to undo";
    const known = [
      "draft is not a promoted note",
      "draft belongs to a different or unconfirmed vault",
      "note no longer matches draft provenance",
      "promotion receipt missing; review the note and use --force to undo",
      "note changed since promotion; review it and use --force to undo",
    ];
    process.stderr.write(
      w.error(
        error instanceof PendingRelayAccessError || (sub === "undo" && known.includes(message))
          ? message
          : w.cannotAccess
      )
    );
    return 1;
  }
}
