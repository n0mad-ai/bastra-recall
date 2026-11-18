/**
 * The words of `formatPreflight` — how `bastra update` shows the preflight in
 * front of an in-place install (#268) — by language.primary (#1602). English
 * is the default and the fallback, byte-identical to before; German complete.
 * Only the frame is worded here: the notes and the refusal are part of the
 * verdict, which is also saved for the next session, and keep their text.
 * Text the product writes — never matched against user text.
 */

const en = {
  note: (n: string) => `  note: ${n}`,
  modified: (n: number) => `  locally modified (${n}):`,
  missing: "missing ",
  changed: "changed ",
  andMore: (n: number) => `    … and ${n} more`,
  backedUp: (dir: string) => `  backed up to: ${dir}`,
  notBackedUp: (n: number) => `  NOT backed up (${n}) — no copy exists of:`,
  failed: (path: string) => `    failed   ${path}`,
};
export type UpdatePreflightWords = typeof en;

const de: UpdatePreflightWords = {
  note: (n) => `  Hinweis: ${n}`,
  modified: (n) => `  lokal geändert (${n}):`,
  missing: "fehlt   ",
  changed: "geändert",
  andMore: (n) => `    … und ${n} weitere`,
  backedUp: (dir) => `  gesichert nach: ${dir}`,
  notBackedUp: (n) => `  NICHT gesichert (${n}) — es gibt keine Kopie von:`,
  failed: (path) => `    fehlgeschlagen ${path}`,
};

export const UPDATE_PREFLIGHT_WORDS: Readonly<Record<string, UpdatePreflightWords>> = { en, de };
/** The words in `language`; English for an unset or unlisted one. */
export function updatePreflightWordsIn(language: string | undefined): UpdatePreflightWords {
  return UPDATE_PREFLIGHT_WORDS[language ?? "en"] ?? en;
}
