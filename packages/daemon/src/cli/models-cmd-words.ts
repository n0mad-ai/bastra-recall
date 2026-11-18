/**
 * The words of `bastra models` by language.primary (#1602). English is the
 * default and the fallback, byte-identical to before; German complete.
 *
 * Not here, on purpose: `bastra models recommend` (its first line is the bare
 * model tag, read by scripts), and the recommendation texts from
 * model-recommendation.ts / hardware.ts, which the session hook and the MCP
 * notice hand to the model as well. The answer keys of the question stay
 * s / l / n in every language — the reply is matched on them. Text the
 * product writes — never matched against user text.
 */

const en = {
  generationModel: (model: string, isDefault: boolean) => `generation model: ${model}${isDefault ? " (default)" : ""}`,
  machine: (ramGB: string, chip: string, platform: string) =>
    `machine: ${ramGB} GB${chip ? `, ${chip}` : ""} (${platform})`,
  recommended: (model: string | null, tier: string) => `recommended: ${model ?? "— none —"}  [${tier}]`,
  optInAlternative: (model: string, note: string) => `  opt-in alternative: ${model} — ${note}`,
  toSwitch: (model: string) => `\nto switch: bastra models set ${model}`,
  alternative: (model: string) => `alternative: bastra models set ${model}`,
  setting: (model: string) => `Setting the generation model to ${model} …`,
  nothingToDecide: "Nothing to decide: there is no model recommendation open for this machine.",
  notOfThisVersion: (answered: string) =>
    `✗ ${answered} is not a recommendation of this bastra version for this machine.`,
  nothingChanged: "Nothing was changed.",
  sayWhich: (command: string) =>
    `Say which recommendation you are answering — the full command is:\n  ${command}\nNothing was changed.\n`,
  notCurrent: (answered: string, model: string, id: string, sizeGB: string) =>
    `✗ ${answered} is not the current recommendation. This bastra version recommends ${model} (${id}, about ${sizeGB} GB download).`,
  nothingChangedSee: "Nothing was changed. 'bastra models' shows the current recommendation and its commands.",
  later: (current: string) =>
    `OK — the generation model stays ${current}. You will be asked again in 7 days; until then 'bastra models' shows the recommendation.`,
  dismissed: (current: string, warning: string) =>
    `OK — the generation model stays ${current}. From now on ${warning}.`,
  stillOpen: (open: string) => `Still open to you: ${open}.`,
  switching: (model: string, sizeGB: string) =>
    `Switching the generation model to ${model} (about ${sizeGB} GB download if it is not present yet) …`,
  switchFailed: (current: string) => `Nothing was changed — the generation model stays ${current}.`,
  previousKept: (previous: string) =>
    `The previous model ${previous} is still installed. Switch back any time: bastra models set ${previous}`,
  note: (note: string) => `Note: ${note}`,
  aboutNever: (warning: string, open: string) => `About [n]: ${warning}; ${open}.`,
  question:
    "[s] switch now   [l] later (ask again in 7 days)   [n] never ask again for this recommendation — your choice [s/l/n]: ",
};
export type ModelsCmdWords = typeof en;

const de: ModelsCmdWords = {
  generationModel: (model, isDefault) => `Generierungsmodell: ${model}${isDefault ? " (Standard)" : ""}`,
  machine: (ramGB, chip, platform) => `Rechner: ${ramGB} GB${chip ? `, ${chip}` : ""} (${platform})`,
  recommended: (model, tier) => `empfohlen: ${model ?? "— keines —"}  [${tier}]`,
  optInAlternative: (model, note) => `  wählbare Alternative: ${model} — ${note}`,
  toSwitch: (model) => `\nzum Wechseln: bastra models set ${model}`,
  alternative: (model) => `Alternative: bastra models set ${model}`,
  setting: (model) => `Das Generierungsmodell wird auf ${model} gesetzt …`,
  nothingToDecide: "Nichts zu entscheiden: für diesen Rechner ist keine Modellempfehlung offen.",
  notOfThisVersion: (answered) => `✗ ${answered} ist keine Empfehlung dieser bastra-Version für diesen Rechner.`,
  nothingChanged: "Es wurde nichts geändert.",
  sayWhich: (command) =>
    `Gib an, auf welche Empfehlung du antwortest — der vollständige Befehl lautet:\n  ${command}\nEs wurde nichts geändert.\n`,
  notCurrent: (answered, model, id, sizeGB) =>
    `✗ ${answered} ist nicht die aktuelle Empfehlung. Diese bastra-Version empfiehlt ${model} (${id}, etwa ${sizeGB} GB Download).`,
  nothingChangedSee: "Es wurde nichts geändert. 'bastra models' zeigt die aktuelle Empfehlung und ihre Befehle.",
  later: (current) =>
    `OK — das Generierungsmodell bleibt ${current}. In 7 Tagen wirst du erneut gefragt; bis dahin zeigt 'bastra models' die Empfehlung.`,
  dismissed: (current, warning) => `OK — das Generierungsmodell bleibt ${current}. Ab jetzt gilt: ${warning}.`,
  stillOpen: (open) => `Weiterhin möglich: ${open}.`,
  switching: (model, sizeGB) =>
    `Das Generierungsmodell wechselt zu ${model} (etwa ${sizeGB} GB Download, falls es noch nicht vorhanden ist) …`,
  switchFailed: (current) => `Es wurde nichts geändert — das Generierungsmodell bleibt ${current}.`,
  previousKept: (previous) =>
    `Das bisherige Modell ${previous} bleibt installiert. Zurück wechseln jederzeit mit: bastra models set ${previous}`,
  note: (note) => `Hinweis: ${note}`,
  aboutNever: (warning, open) => `Zu [n]: ${warning}; ${open}.`,
  question:
    "[s] sofort wechseln   [l] später (in 7 Tagen erneut fragen)   [n] nie wieder nach dieser Empfehlung fragen — deine Wahl [s/l/n]: ",
};

export const MODELS_CMD_WORDS: Readonly<Record<string, ModelsCmdWords>> = { en, de };
/** The words in `language`; English for an unset or unlisted one. */
export function modelsCmdWordsIn(language: string | undefined): ModelsCmdWords {
  return MODELS_CMD_WORDS[language ?? "en"] ?? en;
}
