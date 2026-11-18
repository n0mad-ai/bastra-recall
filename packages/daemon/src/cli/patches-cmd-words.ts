/**
 * The words `bastra patches` prints, by language.primary (#1602): English is
 * the default and the fallback (byte-identical to before), German complete.
 * Text the product writes — never matched against user text. The usage block
 * lives in usage-block-words.ts; the status-panel line stays English.
 */
import type { PatchState } from "../patch-registry.js";

const en = {
  state: {
    clean: "✓ applies cleanly",
    "already-upstream": "↩ already upstream",
    "applied-here": "✓ applied (by the last update on this install)",
    conflict: "⚠ conflicts",
    unknown: "? cannot tell",
  } as Record<PatchState, string>,
  noneRegistered: (dir: string) =>
    "No patches registered.\n\n" +
    "Register one with:  bastra patches add <file.patch>\n" +
    `They live in ${dir} and are reapplied after every update.\n`,
  series: (n: number) => `Series (${n}), in apply order:\n`,
  added: (date: string) => `added ${date}`,
  retiredHeader: (n: number) => `\nRetired (${n}) — kept as history, no longer applied:\n`,
  retired: "retired",
  addUsage: "error: bastra patches add <file>\n",
  registered: (id: string, subject: string, path: string) => `✓ registered ${id}\n    ${subject}\n    ${path}\n\n`,
  againstInstall: (label: string) => `Against the current installation: ${label}\n`,
  error: (message: string) => `error: ${message}\n`,
  removeUsage: "error: bastra patches remove <id>\n",
  noSuchPatch: (id: string) => `error: no patch with id '${id}' — 'bastra patches list' shows the series\n`,
  removed: (id: string) => `✓ removed ${id}\n`,
  nothingToCheck: "No patches registered — nothing to check.\n",
  installation: (path: string) => `Installation: ${path}\n`,
  applyFrom: (path: string) => `Patches apply from: ${path}\n`,
  nextUpdate: "\nOn the next update:\n",
  unknownSub: (sub: string) => `error: unknown sub-command '${sub}'\n\n`,
};
export type PatchesCmdWords = typeof en;

const de: PatchesCmdWords = {
  state: {
    clean: "✓ lässt sich sauber anwenden",
    "already-upstream": "↩ schon upstream",
    "applied-here": "✓ angewendet (vom letzten Update dieser Installation)",
    conflict: "⚠ Konflikte",
    unknown: "? nicht feststellbar",
  },
  noneRegistered: (dir: string) =>
    "Keine Patches registriert.\n\n" +
    "Einen registrieren mit:  bastra patches add <datei.patch>\n" +
    `Sie liegen in ${dir} und werden nach jedem Update wieder angewendet.\n`,
  series: (n: number) => `Serie (${n}), in Anwendungsreihenfolge:\n`,
  added: (date: string) => `hinzugefügt ${date}`,
  retiredHeader: (n: number) => `\nStillgelegt (${n}) — als Verlauf behalten, nicht mehr angewendet:\n`,
  retired: "stillgelegt",
  addUsage: "Fehler: bastra patches add <datei>\n",
  registered: (id: string, subject: string, path: string) => `✓ registriert ${id}\n    ${subject}\n    ${path}\n\n`,
  againstInstall: (label: string) => `Gegen die aktuelle Installation: ${label}\n`,
  error: (message: string) => `Fehler: ${message}\n`,
  removeUsage: "Fehler: bastra patches remove <id>\n",
  noSuchPatch: (id: string) => `Fehler: kein Patch mit der id '${id}' — 'bastra patches list' zeigt die Serie\n`,
  removed: (id: string) => `✓ entfernt ${id}\n`,
  nothingToCheck: "Keine Patches registriert — nichts zu prüfen.\n",
  installation: (path: string) => `Installierte Fassung: ${path}\n`,
  applyFrom: (path: string) => `Patches werden angewendet ab: ${path}\n`,
  nextUpdate: "\nBeim nächsten Update:\n",
  unknownSub: (sub: string) => `Fehler: unbekannter Unterbefehl '${sub}'\n\n`,
};

export const PATCHES_CMD_WORDS: Readonly<Record<string, PatchesCmdWords>> = { en, de };
/** The words in `language`; English for an unset or unlisted one. */
export function patchesCmdWordsIn(language: string | undefined): PatchesCmdWords {
  return PATCHES_CMD_WORDS[language ?? "en"] ?? en;
}
