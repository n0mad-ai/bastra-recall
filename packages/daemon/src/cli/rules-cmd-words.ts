/**
 * The words `bastra rules cursor` prints, by language.primary (#1602):
 * English is the default and the fallback (byte-identical to before), German
 * complete. Text the product writes — never matched against user text. The
 * usage block lives in usage-block-words.ts.
 */
const en = {
  templateMissing: "error: cursor rules template missing from this installation\n",
  alreadyInstalled: (target: string) => `✓ already installed: ${target}\n`,
  wouldUpdate: (target: string) => `~ would update ${target} (differs from the shipped rules)\n`,
  backupFailed: (backup: string, message: string) =>
    `error: cannot back up the existing rules to ${backup}: ${message}\n` +
    "  refusing to overwrite your version without one\n",
  updated: (target: string, backup: string) => `✓ updated ${target}\n  previous version kept at ${backup}\n`,
  wouldWrite: (target: string) => `~ would write ${target}\n`,
  wrote: (target: string) =>
    `✓ wrote ${target}\n` +
    "  Cursor picks it up on the next chat — the rule applies to every session in this project.\n" +
    "  It is a normal project file: commit it and your team gets the same behaviour.\n",
  notPresent: (target: string) => `✓ not present: ${target}\n`,
  wouldRemove: (target: string) => `~ would remove ${target}\n`,
  removed: (target: string) => `✓ removed ${target}\n`,
  noLayer: (surface: string, supported: string) =>
    `error: no rules layer for '${surface}' — supported: ${supported}\n` +
    "  (Claude Code and Claude Desktop use the skill, installed by 'bastra install'.)\n",
  noSuchDir: (dir: string) => `error: no such directory: ${dir}\n`,
  /** `bastra rules proposals | confirm | reject`; the daemon's own error text stays as it came. */
  proposalError: (message: string) => `error: ${message}\n`,
  unknownProposalOperation: "Unknown rulebook proposal operation",
  proposalsChanged: "Proposal list changed; run bastra rules proposals again.",
};
export type RulesCmdWords = typeof en;

const de: RulesCmdWords = {
  templateMissing: "Fehler: die Vorlage der Cursor-Regeln fehlt in dieser Installation\n",
  alreadyInstalled: (target: string) => `✓ schon installiert: ${target}\n`,
  wouldUpdate: (target: string) => `~ würde ${target} aktualisieren (weicht von den mitgelieferten Regeln ab)\n`,
  backupFailed: (backup: string, message: string) =>
    `Fehler: die vorhandenen Regeln lassen sich nicht nach ${backup} sichern: ${message}\n` +
    "  ohne Sicherung wird deine Fassung nicht überschrieben\n",
  updated: (target: string, backup: string) => `✓ aktualisiert ${target}\n  die vorige Fassung liegt unter ${backup}\n`,
  wouldWrite: (target: string) => `~ würde ${target} schreiben\n`,
  wrote: (target: string) =>
    `✓ geschrieben ${target}\n` +
    "  Cursor übernimmt sie im nächsten Chat — die Regel gilt für jede Sitzung in diesem Projekt.\n" +
    "  Es ist eine normale Projektdatei: committe sie, dann verhält sich dein Team genauso.\n",
  notPresent: (target: string) => `✓ nicht vorhanden: ${target}\n`,
  wouldRemove: (target: string) => `~ würde ${target} entfernen\n`,
  removed: (target: string) => `✓ entfernt ${target}\n`,
  noLayer: (surface: string, supported: string) =>
    `Fehler: keine Regelschicht für '${surface}' — unterstützt: ${supported}\n` +
    "  (Claude Code und Claude Desktop nutzen den Skill, den 'bastra install' einrichtet.)\n",
  noSuchDir: (dir: string) => `Fehler: kein solcher Ordner: ${dir}\n`,
  proposalError: (message: string) => `Fehler: ${message}\n`,
  unknownProposalOperation: "Unbekannte Aktion für Regelvorschläge",
  proposalsChanged: "Die Liste der Vorschläge hat sich geändert; bastra rules proposals erneut ausführen.",
};

export const RULES_CMD_WORDS: Readonly<Record<string, RulesCmdWords>> = { en, de };
/** The words in `language`; English for an unset or unlisted one. */
export function rulesCmdWordsIn(language: string | undefined): RulesCmdWords {
  return RULES_CMD_WORDS[language ?? "en"] ?? en;
}
