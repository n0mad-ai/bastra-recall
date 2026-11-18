/**
 * The words `bastra recall` and `bastra save` print, by language.primary
 * (#1602): English is the default and the fallback (byte-identical to
 * before), German complete. Text the product writes — never matched against
 * user text. The usage lines themselves live in usage-words.ts.
 */
import { taskCliLanguage } from "./task-cli-words.js";
import { usageWordsIn } from "./usage-words.js";

const en = {
  givenTwice: (flag: string) => `${flag} given twice`,
  limitRange: "--limit must be a whole number from 1 to 20",
  required: "--title, --type and --scope are required",
  typeOneOf: (types: string) => `--type must be one of ${types}`,
  textMissing: "the memory text is missing: give it as words or pipe it in",
  noMatches: "no matching memories",
  weakResult: "(weak result: no hit matches the question's words or triggers)",
  dryRunUnconfirmed: "bastra save: daemon did not confirm a dry-run; it may have saved the memory",
  claimed: (dryRun: boolean) =>
    `${dryRun ? "would not be saved" : "not saved"}: another memory already covers this situation`,
  saved: (id: string, path: string | undefined) => `saved ${id}${path ? ` → ${path}` : ""}`,
  previewOnly: "preview only: nothing was saved",
  previewId: "  id:       ",
  previewFile: "  file:     ",
  previewKind: "  kind:     ",
  previewRedacted: "  redacted: ",
  nothing: "nothing",
};
export type MemoryCmdWords = typeof en & { usage: ReturnType<typeof usageWordsIn> };

const de: typeof en = {
  givenTwice: (flag: string) => `${flag} doppelt angegeben`,
  limitRange: "--limit muss eine ganze Zahl von 1 bis 20 sein",
  required: "--title, --type und --scope sind Pflicht",
  typeOneOf: (types: string) => `--type muss einer dieser Werte sein: ${types}`,
  textMissing: "der Text des Memorys fehlt: als Wörter angeben oder per Pipe übergeben",
  noMatches: "keine passenden Memories",
  weakResult: "(schwaches Ergebnis: kein Treffer passt zu den Wörtern oder Auslösern der Frage)",
  dryRunUnconfirmed:
    "bastra save: der Daemon hat den Probelauf nicht bestätigt; das Memory wurde möglicherweise gespeichert",
  claimed: (dryRun: boolean) =>
    `${dryRun ? "würde nicht gespeichert" : "nicht gespeichert"}: ein anderes Memory deckt diese Situation schon ab`,
  saved: (id: string, path: string | undefined) => `gespeichert ${id}${path ? ` → ${path}` : ""}`,
  previewOnly: "nur Vorschau: nichts wurde gespeichert",
  previewId: "  id:        ",
  previewFile: "  Datei:     ",
  previewKind: "  Art:       ",
  previewRedacted: "  geschwärzt: ",
  nothing: "nichts",
};

export const MEMORY_CMD_WORDS: Readonly<Record<string, typeof en>> = { en, de };
/** The words in `language`, with its usage lines; English for an unset or unlisted one. */
export function memoryCmdWordsIn(language: string | undefined): MemoryCmdWords {
  return { ...(MEMORY_CMD_WORDS[language ?? "en"] ?? en), usage: usageWordsIn(language) };
}
/** The words in language.primary, read once per command (English when unset or unreadable). */
export async function memoryCmdWords(): Promise<MemoryCmdWords> {
  return memoryCmdWordsIn(await taskCliLanguage().catch(() => "en"));
}
