/** Local draft administration (#1084). No daemon or vault connection needed. */
import { listDrafts, purgeDrafts } from "../draft-store.js";
import type { ParsedArgs } from "./types.js";

export async function cmdDrafts(args: ParsedArgs): Promise<number> {
  const sub = args.positional[1] ?? "list";
  if (!["list", "purge"].includes(sub) || args.positional.length > 2) {
    process.stderr.write("usage: bastra drafts [list|purge] [--json]\n");
    return 2;
  }
  try {
    if (sub === "purge") {
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
  } catch {
    // Do not echo malformed file content or a secret-bearing override path.
    process.stderr.write("error: cannot access local drafts\n");
    return 1;
  }
}
