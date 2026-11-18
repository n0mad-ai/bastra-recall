/**
 * The words `bastra map` prints, by language.primary (#1602): English is the
 * default and the fallback (byte-identical to before), German complete. Text
 * the product writes — never matched against user text.
 */
const en = {
  disabled: "vault map is disabled — enable it: bastra config set ui.enabled true\n",
  enableNow: "The vault map is disabled. Enable it now? (local only, no restart needed)",
  keptOff: "Kept off — enable later: bastra config set ui.enabled true\n",
  enabled: "✓ ui.enabled = true\n",
  starting: "· starting the daemon — first run can take a moment…\n",
  notOpening: (url: string) => `  not opening ${url} — the daemon serves the map, so the page would not load\n`,
  url: (url: string) => `vault map: ${url}\n`,
};
export type MapCmdWords = typeof en;

const de: MapCmdWords = {
  disabled: "die Vault-Karte ist aus — einschalten mit: bastra config set ui.enabled true\n",
  enableNow: "Die Vault-Karte ist aus. Jetzt einschalten? (nur lokal, kein Neustart nötig)",
  keptOff: "Bleibt aus — später einschalten: bastra config set ui.enabled true\n",
  enabled: "✓ ui.enabled = true (eingeschaltet)\n",
  starting: "· der Daemon wird gestartet — beim ersten Mal kann das einen Moment dauern …\n",
  notOpening: (url: string) =>
    `  ${url} wird nicht geöffnet — der Daemon liefert die Karte aus, die Seite würde nicht laden\n`,
  url: (url: string) => `Vault-Karte: ${url}\n`,
};

export const MAP_CMD_WORDS: Readonly<Record<string, MapCmdWords>> = { en, de };
/** The words in `language`; English for an unset or unlisted one. */
export function mapCmdWordsIn(language: string | undefined): MapCmdWords {
  return MAP_CMD_WORDS[language ?? "en"] ?? en;
}
