/**
 * #289 — ein Dokument-Trigger muss das Dokument unterscheiden.
 *
 * Gemessen an einem echten Vault: die Phrase `"sonstiges"` stand als
 * `recall_when` von 19 Dokumenten, `"foto bild unsortiert"` von 4. Beide sagen
 * nichts über das einzelne Dokument — sie beanspruchen auf dem Feld mit
 * Gewicht 5 eine Situation, die sie nicht auflösen können, und ziehen bei jeder
 * Anfrage, die sie trifft, den ganzen Stapel hoch.
 *
 * Die Regel greift bewusst UNABHÄNGIG davon, wer den Trigger geschrieben hat.
 * Der abgeleitete Default (`tags.slice(0,3).join(" ")`) erzeugt das Muster, aber
 * der gemessene Schaden kam über den anderen Weg: ein Agent hat beim Massen-
 * import dieselbe Form von Hand mitgeschickt (`"nach Dokument suchen <Name>"` /
 * `"<Kategorie>"` / `"file <Name>"`). Eine Regel, die nur den Default absichert,
 * hätte genau den Vorfall nicht verhindert, der sie nötig macht.
 *
 * Eng gefasst, damit sie keinen echten Autorentrigger anfasst: generisch heißt
 * hier, dass der Trigger AUSSCHLIESSLICH aus Kategorie- und Tag-Wörtern besteht.
 * "Stromrechnung Januar nachschlagen" bleibt unangetastet, "sonstiges" nicht.
 */

/** Wortmenge, kleingeschrieben, ohne Satzzeichen — nur zum Vergleichen. */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * Trägt dieser Trigger nichts über das einzelne Dokument?
 *
 * Wahr, wenn jedes seiner Wörter aus der Kategorie oder den Tags stammt. Ein
 * leerer Trigger zählt nicht als generisch, sondern wird vom Aufrufer ohnehin
 * verworfen.
 */
export function isGenericDocumentTrigger(
  trigger: string,
  ctx: { category: string; tags: string[] },
): boolean {
  const own = words(trigger);
  if (own.length === 0) return false;
  const vocabulary = new Set([...words(ctx.category), ...ctx.tags.flatMap(words)]);
  return own.every((w) => vocabulary.has(w));
}

/**
 * Qualifiziert generische Trigger mit dem Titel und lässt alle anderen in Ruhe.
 *
 * Der Titel ist das, was zwei Dokumente derselben Kategorie unterscheidet —
 * deshalb wird er angehängt statt den Trigger zu verwerfen: die thematische
 * Situation ("sonstiges", "foto bild unsortiert") bleibt auffindbar, sie wird
 * nur eindeutig. Ein Trigger, der den Titel schon enthält, bleibt unverändert.
 */
export function qualifyDocumentTriggers(
  triggers: string[],
  ctx: { title: string; category: string; tags: string[] },
): string[] {
  const titleWords = words(ctx.title);
  return triggers.map((trigger) => {
    if (!isGenericDocumentTrigger(trigger, ctx)) return trigger;
    const own = new Set(words(trigger));
    if (titleWords.length > 0 && titleWords.every((w) => own.has(w))) return trigger;
    return `${trigger} ${ctx.title}`.trim();
  });
}
