/**
 * `max_tokens` — das Kontextbudget EINES recall-Aufrufs (#487).
 *
 * DAS PROBLEM. `k` ist eine Stückzahl, und was Kontext kostet, ist Text: eine
 * `k=5`-Antwort schwankt je nach Summary-Länge um mehr als den Faktor zwei.
 * Ein Agent, der weiß, wie viel Fenster ihm bleibt, kann das mit einer
 * Stückzahl nicht ausdrücken. `max_tokens` ist die Größe, in der er rechnet.
 *
 * DIE REGEL. Nach Ranking, Score-Floor und Evidenzentscheid werden die Treffer
 * in RANGFOLGE ausgegeben, bis das geschätzte Payload das Budget überschritte.
 * Der letzte, der nicht mehr hineinpasst, fällt ganz — gekürzt wird kein
 * Treffer (dieselbe Linie wie `fitsBudget` im Governor: ein halber Beleg ist
 * keiner). `k` bleibt die harte Obergrenze; das Budget kann nur zusätzlich
 * streichen, nie zusätzlich liefern.
 *
 * DER SCHÄTZER ist der des Governors (`estimateTokens`, #266/#458) — nicht ein
 * zweiter daneben. Beide Budgets müssen dieselbe Zahl meinen, sonst hält der
 * Aufrufer seine Grenze ein und das Sitzungsbudget zählt eine andere.
 *
 * GEMESSEN WIRD DAS FERTIGE PAYLOAD, nicht die Summe der Treffer: Der Umschlag
 * (query, score_arms, Flags) kostet Kontext wie alles andere, und die beiden
 * Budgetfelder, die eine Kürzung selbst hinzufügt, kosten ihn auch. Deshalb
 * baut diese Funktion das Ergebnis in jeder Runde neu und misst es, statt eine
 * Schätzung zu addieren — bei k ≤ 20 sind das höchstens 20 kleine
 * Serialisierungen, und dafür gilt die Zusage exakt statt ungefähr.
 *
 * Ohne Budget (`0`/fehlend) wird EINMAL mit allen Treffern gebaut und nichts
 * gemessen: Das Ergebnis ist dann byte-gleich zu dem ohne dieses Modul.
 */
import { estimateTokens, fitsBudget } from "./context-governor.js";

/** Misst das Payload so, wie MCP und Forwarder es in den Transkript-Text
 *  schreiben (pretty JSON) — dieselbe Form, die `payload_chars` (#457) zählt,
 *  und derselbe Token-Schätzer wie im Governor. */
export function measurePayload(payload: unknown): { chars: number; tokens: number } {
  const text = JSON.stringify(payload, null, 2);
  return { chars: text.length, tokens: estimateTokens(text) };
}

export interface BudgetedPayload<R> {
  payload: R;
  /** Wie viele gerankte Treffer das Budget weggelassen hat. `0` = keiner. */
  dropped: number;
}

/**
 * Baut das Antwort-Payload so groß, wie das Budget es zulässt.
 *
 * `build` bekommt die auszugebenden Treffer und die Zahl der weggelassenen —
 * es gehört dem Aufrufer, weil nur er weiß, wie seine Antwort aussieht. Die
 * Budgetfelder (`truncated_by_budget`, `dropped_by_budget`) setzt er anhand
 * des zweiten Arguments; bei `0` darf sich an seiner Antwort nichts ändern.
 */
export function fitRecallToBudget<H, R>(
  hits: H[],
  budget: number | undefined,
  build: (emitted: H[], droppedByBudget: number) => R,
): BudgetedPayload<R> {
  const tokens = budget ?? 0;
  if (tokens <= 0) return { payload: build(hits, 0), dropped: 0 };
  for (let emitted = hits.length; ; emitted--) {
    const dropped = hits.length - emitted;
    const payload = build(hits.slice(0, emitted), dropped);
    // Der leere Fall endet die Schleife: Ist schon der Umschlag zu groß, ist
    // das die ehrliche Antwort — mehr kann kein Budget einsparen.
    if (emitted === 0 || fitsBudget(0, measurePayload(payload).tokens, tokens)) {
      return { payload, dropped };
    }
  }
}
