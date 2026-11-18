/**
 * `bastra trash list|restore <id>` (#1471) — the vault trash that
 * archive_memory fills, listed and undone from the terminal through the
 * running daemon's restore_memory. Not `bastra archive`: that one is the
 * archive behind the agent's `rm`, files outside the vault.
 */
import { rulebookCliCall } from "./helpers.js";
import type { ParsedArgs } from "./types.js";
import { taskCliLanguage } from "./task-cli-words.js";
import { usageBlocksIn } from "./usage-block-words.js";

/** The words `bastra trash` prints by language.primary (#1602), English when
 *  unset or unlisted. Text the product writes — never matched against user text. */
export const TRASH_WORDS = {
  en: {
    empty: "nothing archived to restore",
    more: (n: number) => `… ${n} more not shown`,
    restoreWith: "restore with: bastra trash restore <id>",
    restored: (id: string, to: string) => `restored ${id} → ${to}`,
    failed: (sub: string | null, message: string) => `bastra trash ${sub}: ${message}`,
  },
  de: {
    empty: "nichts Archiviertes zum Wiederherstellen",
    more: (n: number) => `… ${n} weitere nicht angezeigt`,
    restoreWith: "wiederherstellen mit: bastra trash restore <id>",
    restored: (id: string, to: string) => `wiederhergestellt ${id} → ${to}`,
    failed: (sub: string | null, message: string) => `bastra trash ${sub}: Fehler: ${message}`,
  },
};
export const trashWordsIn = (language: string | undefined) =>
  TRASH_WORDS[(language ?? "en") as keyof typeof TRASH_WORDS] ?? TRASH_WORDS.en;

interface Listed {
  archived: { id: string; title: string; archived_at: string; from: string | null }[];
  total: number;
}

export async function cmdTrash(args: ParsedArgs): Promise<number> {
  const sub = args.surface;
  const language = await taskCliLanguage().catch(() => "en");
  const w = trashWordsIn(language);
  const usage = usageBlocksIn(language).trash;
  try {
    if (sub === "list") {
      const out = (await rulebookCliCall("restore_memory", { limit: 100 })) as Listed;
      if (args.json) console.log(JSON.stringify(out));
      else if (out.archived.length === 0) console.log(w.empty);
      else {
        for (const m of out.archived)
          console.log(`${m.archived_at.slice(0, 16).replace("T", " ")}  ${m.id}  ${m.title}`);
        if (out.total > out.archived.length) console.log(w.more(out.total - out.archived.length));
        console.log(w.restoreWith);
      }
      return 0;
    }
    if (sub === "restore") {
      const id = args.positional[2];
      if (!id) {
        console.error(usage);
        return 2;
      }
      const out = (await rulebookCliCall("restore_memory", { id })) as { restored_to: string; warning?: string };
      console.log(w.restored(id, out.restored_to));
      if (out.warning) console.error(out.warning);
      return 0;
    }
  } catch (e) {
    console.error(w.failed(sub, (e as Error).message));
    return 1;
  }
  console.error(usage);
  return 2;
}
