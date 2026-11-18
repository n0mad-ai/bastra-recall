/**
 * The words of the `→ hook binary` block (#546, #547) that `bastra doctor`
 * and `bastra update` print, by language.primary (#1602). English is the
 * default and the fallback, byte-identical to before; German complete. Only
 * the terminal reads these lines. Text the product writes — never matched
 * against user text.
 */

const en = {
  builtAtFrom: (at: string, rev: string, dirty: boolean) => ` (built ${at} from ${rev}${dirty ? ", uncommitted" : ""})`,
  builtAt: (at: string) => ` (built ${at})`,
  from: (rev: string) => ` (from ${rev})`,
  rebuild: (hint: string) => ` — rebuild it with \`${hint}\``,
  ok: (binary: string, built: string) => `✓ ok: ${binary} matches the stub sources in this checkout${built}`,
  stale: (binary: string, built: string, who: string, rebuild: string) =>
    `⚠ stale hook binary: ${binary}${built} was built from different sources than the ones` +
    ` in this checkout. Every hook call on ${who} runs that older code — this is how a two-week-old` +
    ` binary wrote telemetry nobody could fold (#546)${rebuild}`,
  unstamped: (binary: string, rebuild: string) =>
    `⚠ unstamped hook binary: ${binary} answers \`version\` without a source digest, so it predates` +
    ` #546 and cannot say which sources it came from. That is not the same as current${rebuild}`,
  unknownSources: (binary: string, built: string) =>
    `· ${binary}${built} — this installation ships no stub sources, so whether the binary` +
    ` is still current cannot be decided here. Check it in a source checkout.`,
  missing: (who: string, binary: string, surface: string) =>
    `⚠ missing hook binary: ${who} registers ${binary}, and no such file exists —` +
    ` those hook lanes run nothing. Re-run \`bastra install ${surface}\``,
  unreadable: (binary: string, name: string, surface: string) =>
    `⚠ unusable hook binary: ${binary} is there but \`${name} version\` did not answer` +
    ` — an interrupted download or a binary for another architecture. Re-run \`bastra install ${surface}\``,
  staleStatusline: (binary: string, name: string, rebuild: string) =>
    `⚠ stale statusline in an otherwise current hook binary: ${binary} carries a statusline bundle built` +
    ` from different sources than \`packages/statusline/dist\` here. The hook lanes are fine; \`${name}` +
    ` statusline\` renders older code (#547)${rebuild}`,
  unstampedStatusline: (binary: string, rebuild: string) =>
    `⚠ ${binary} matches the stub sources but carries no statusline digest, so it predates #547 and cannot` +
    ` say which statusline bundle is inside it. That is not the same as current${rebuild}`,
  foreign: (who: string, binary: string, own: string, surface: string) =>
    `⚠ ${who} runs ${binary}, not this installation's ${own} —` +
    ` the hooks execute a different build than the one you are looking at.` +
    ` \`bastra install ${surface}\` re-registers this one`,
};
export type StubFreshnessWords = typeof en;

const de: StubFreshnessWords = {
  builtAtFrom: (at, rev, dirty) => ` (gebaut ${at} aus ${rev}${dirty ? ", nicht committet" : ""})`,
  builtAt: (at) => ` (gebaut ${at})`,
  from: (rev) => ` (aus ${rev})`,
  rebuild: (hint) => ` — neu bauen mit \`${hint}\``,
  ok: (binary, built) => `✓ ok: ${binary} passt zu den Stub-Quellen in diesem Checkout${built}`,
  stale: (binary, built, who, rebuild) =>
    `⚠ veraltetes Hook-Programm: ${binary}${built} wurde aus anderen Quellen gebaut als denen` +
    ` in diesem Checkout. Jeder Hook-Aufruf von ${who} führt diesen älteren Code aus — so hat ein zwei Wochen altes` +
    ` Programm Telemetrie geschrieben, die niemand zusammenführen konnte (#546)${rebuild}`,
  unstamped: (binary, rebuild) =>
    `⚠ Hook-Programm ohne Stempel: ${binary} beantwortet \`version\` ohne Quellen-Prüfwert, ist also älter als` +
    ` #546 und kann nicht sagen, aus welchen Quellen es stammt. Das ist nicht dasselbe wie aktuell${rebuild}`,
  unknownSources: (binary, built) =>
    `· ${binary}${built} — diese Installation enthält keine Stub-Quellen, ob das Programm` +
    ` noch aktuell ist, lässt sich hier nicht entscheiden. Prüfe es in einem Quell-Checkout.`,
  missing: (who, binary, surface) =>
    `⚠ fehlendes Hook-Programm: ${who} trägt ${binary} ein, doch die Datei gibt es nicht —` +
    ` diese Hooks führen nichts aus. Führe \`bastra install ${surface}\` erneut aus`,
  unreadable: (binary, name, surface) =>
    `⚠ unbrauchbares Hook-Programm: ${binary} ist da, aber \`${name} version\` hat nicht geantwortet` +
    ` — ein abgebrochener Download oder ein Programm für eine andere Architektur. Führe \`bastra install ${surface}\` erneut aus`,
  staleStatusline: (binary, name, rebuild) =>
    `⚠ veraltete Statuszeile in einem sonst aktuellen Hook-Programm: ${binary} enthält ein Statuszeilen-Paket, gebaut` +
    ` aus anderen Quellen als \`packages/statusline/dist\` hier. Die Hooks sind in Ordnung; \`${name}` +
    ` statusline\` zeigt älteren Code an (#547)${rebuild}`,
  unstampedStatusline: (binary, rebuild) =>
    `⚠ ${binary} passt zu den Stub-Quellen, trägt aber keinen Statuszeilen-Prüfwert, ist also älter als #547 und kann` +
    ` nicht sagen, welches Statuszeilen-Paket darin steckt. Das ist nicht dasselbe wie aktuell${rebuild}`,
  foreign: (who, binary, own, surface) =>
    `⚠ ${who} führt ${binary} aus, nicht ${own} dieser Installation —` +
    ` die Hooks laufen mit einem anderen Build als dem, den du gerade ansiehst.` +
    ` \`bastra install ${surface}\` trägt dieses wieder ein`,
};

export const STUB_FRESHNESS_WORDS: Readonly<Record<string, StubFreshnessWords>> = { en, de };
/** The words in `language`; English for an unset or unlisted one. */
export function stubFreshnessWordsIn(language: string | undefined): StubFreshnessWords {
  return STUB_FRESHNESS_WORDS[language ?? "en"] ?? en;
}
