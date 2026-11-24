import {
  DISMISS_STILL_OPEN,
  DISMISS_WARNING,
  MODEL_COMPARISON_URL,
  decisionCommand,
  envOverrideNote,
  formatModelNotice,
  modelOfferFacts,
} from "../model-recommendation.js";

const en = {
  warning: DISMISS_WARNING,
  stillOpen: DISMISS_STILL_OPEN,
  facts: modelOfferFacts,
  environment: envOverrideNote,
  notice: formatModelNotice,
};

const de: typeof en = {
  warning:
    "Diese Frage erscheint für diese Empfehlung nicht mehr. Du verzichtest möglicherweise auf bessere Suchergebnisse",
  stillOpen: "'bastra models' zeigt die Empfehlung weiterhin an und du kannst später jederzeit wechseln",
  facts: (offer) => [
    `Recall empfiehlt für diesen Rechner ein anderes lokales Textmodell: ${offer.model} (derzeit nutzt du ${offer.current}).`,
    `Was besser wird: ${offer.improvesDe ?? offer.improves}`,
    `Download: etwa ${offer.sizeGB} GB. Vergleich: ${MODEL_COMPARISON_URL}`,
  ],
  environment: (offer) => {
    if (!offer.envOverride) return null;
    return `Die Umgebungsvariable ${offer.envOverride} hat Vorrang vor der gespeicherten Auswahl. Der Wechsel greift erst, wenn du die Variable entfernst und den Daemon neu startest.`;
  },
  notice: (offer) => {
    const env = de.environment(offer);
    return [
      ...de.facts(offer),
      ...(env ? [`Hinweis: ${env}`] : []),
      "Du entscheidest mit:",
      `  ${decisionCommand("switch", offer)}   jetzt wechseln`,
      `  ${decisionCommand("later", offer)}   aktuelles Modell behalten, in 7 Tagen wieder fragen`,
      `  ${decisionCommand("dismiss", offer)}   nicht mehr fragen — ${de.warning}. ${de.stillOpen}.`,
    ].join("\n");
  },
};

/** Only CLI screens select these words. The assistant receives the canonical English notice. */
export function modelNoticeWordsIn(language?: string): typeof en {
  return language === "de" ? de : en;
}
