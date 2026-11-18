/**
 * The words of `formatApplyOutcome` — how `bastra patches status` and
 * `bastra update` report a reapplied patch series (#269) — by
 * language.primary (#1602). English is the default and the fallback,
 * byte-identical to before; German complete. Only the terminal reads these
 * lines (the saved last-run record keeps its own, unchanged text). Text the
 * product writes — never matched against user text.
 */

const en = {
  applied: (id: string, subject: string) => `  ✓ applied   ${id} — ${subject}`,
  kept: (id: string) => `  = kept      ${id} — already present on this install; kept in the series`,
  retired: (id: string) => `  ↩ retired   ${id} — merged upstream, dropped from the series`,
  setAside: (id: string, subject: string) => `  ⚠ set aside ${id} — ${subject}`,
  rolledBack: "  ✗ the patched install did not boot — every patch from this run was reversed",
  unrestored: "  ✗ the patched install did not boot, and the reversal did not put everything back:",
};
export type PatchReportWords = typeof en;

const de: PatchReportWords = {
  applied: (id, subject) => `  ✓ angewendet ${id} — ${subject}`,
  kept: (id) => `  = behalten  ${id} — in dieser Installation schon vorhanden; bleibt in der Reihe`,
  retired: (id) => `  ↩ entfernt  ${id} — upstream übernommen, aus der Reihe genommen`,
  setAside: (id, subject) => `  ⚠ zurückgestellt ${id} — ${subject}`,
  rolledBack: "  ✗ die gepatchte Installation startete nicht — jeder Patch dieses Laufs wurde zurückgenommen",
  unrestored: "  ✗ die gepatchte Installation startete nicht, und das Zurücknehmen hat nicht alles wiederhergestellt:",
};

export const PATCH_REPORT_WORDS: Readonly<Record<string, PatchReportWords>> = { en, de };
/** The words in `language`; English for an unset or unlisted one. */
export function patchReportWordsIn(language: string | undefined): PatchReportWords {
  return PATCH_REPORT_WORDS[language ?? "en"] ?? en;
}
