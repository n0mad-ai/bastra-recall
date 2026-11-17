/**
 * `bastra trash list|restore <id>` (#1471) — the vault trash that
 * archive_memory fills, listed and undone from the terminal through the
 * running daemon's restore_memory. Not `bastra archive`: that one is the
 * archive behind the agent's `rm`, files outside the vault.
 */
import { rulebookCliCall } from "./rulebook-proposals-cmd.js";
import type { ParsedArgs } from "./types.js";

const USAGE =
  "usage: bastra trash list              archived memories that can be restored (newest first)\n" +
  "       bastra trash restore <id>      put an archived memory back where it lived";

interface Listed {
  archived: { id: string; title: string; archived_at: string; from: string | null }[];
  total: number;
}

export async function cmdTrash(args: ParsedArgs): Promise<number> {
  const sub = args.surface;
  try {
    if (sub === "list") {
      const out = (await rulebookCliCall("restore_memory", { limit: 100 })) as Listed;
      if (args.json) console.log(JSON.stringify(out));
      else if (out.archived.length === 0) console.log("nothing archived to restore");
      else {
        for (const m of out.archived)
          console.log(`${m.archived_at.slice(0, 16).replace("T", " ")}  ${m.id}  ${m.title}`);
        if (out.total > out.archived.length) console.log(`… ${out.total - out.archived.length} more not shown`);
        console.log("restore with: bastra trash restore <id>");
      }
      return 0;
    }
    if (sub === "restore") {
      const id = args.positional[2];
      if (!id) {
        console.error(USAGE);
        return 2;
      }
      const out = (await rulebookCliCall("restore_memory", { id })) as { restored_to: string; warning?: string };
      console.log(`restored ${id} → ${out.restored_to}`);
      if (out.warning) console.error(out.warning);
      return 0;
    }
  } catch (e) {
    console.error(`bastra trash ${sub}: ${(e as Error).message}`);
    return 1;
  }
  console.error(USAGE);
  return 2;
}
