/** Local draft administration (#1084). Local store operations; undo resolves a vault without contacting the daemon. */
import { Vault } from "@bastra-recall/core";
import { undoDraftPromotion } from "../draft-promote.js";
import { resolveVault } from "./helpers.js";
import { listDrafts, purgeDrafts } from "../draft-store.js";
import type { ParsedArgs } from "./types.js";

export async function cmdDrafts(args: ParsedArgs): Promise<number> {
  const sub = args.positional[1] ?? "list";
  if (!["list", "purge", "undo"].includes(sub) || args.positional.length > (sub === "undo" ? 3 : 2) || sub === "undo" && !args.positional[2]) {
    process.stderr.write("usage: bastra drafts [list|purge|undo <id>] [--json] [--vault <path>] [--force]\n");
    return 2;
  }
  try {
    if (sub === "undo") {
      const resolved = await resolveVault(args);
      if ("error" in resolved) { process.stderr.write("error: configure a vault or pass --vault\n"); return 1; }
      const vault = new Vault(resolved.path);
      try {
        await vault.init();
        const memoryId = await undoDraftPromotion(vault, args.positional[2], Date.now(), args.force);
        process.stdout.write(args.json ? JSON.stringify({ undone: memoryId }) + "\n" : `Draft promotion undone: ${memoryId}\n`);
      } finally { await vault.stop(); }
    } else if (sub === "purge") {
      await purgeDrafts();
      process.stdout.write(args.json ? '{"purged":true}\n' : "Local drafts purged.\n");
    } else {
      const rows = await listDrafts();
      if (args.json) process.stdout.write(JSON.stringify(rows) + "\n");
      else if (!rows.length) process.stdout.write("No local drafts.\n");
      else for (const row of rows) {
        process.stdout.write(`${row.id}  ${row.state}  ${new Date(row.last_touched).toISOString()}\n  ${row.quote.replace(/[\r\n\x00-\x1f\x7f]/g, " ")}\n`);
      }
    }
    return 0;
  } catch (error) {
    let message = error instanceof Error ? error.message : "";
    if (message === "note changed since promotion") message += "; review it and use --force to undo";
    const known = ["draft is not a promoted note", "draft belongs to a different or unconfirmed vault", "note no longer matches draft provenance", "promotion receipt missing; review the note and use --force to undo", "note changed since promotion; review it and use --force to undo"];
    process.stderr.write(`error: ${sub === "undo" && known.includes(message) ? message : "cannot access local drafts"}\n`);
    return 1;
  }
}
