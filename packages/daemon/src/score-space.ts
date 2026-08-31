/**
 * In welchem Zahlenraum ein ausgelieferter Recall-Score liegt — die eine
 * Antwort für alle Pfade (MCP, Hook, Batch).
 *
 * Codex-Gegenreview (P0): `score_kind: "rrf"` bezeichnet seit dem Commons-Arm
 * MEHRERE verschiedene Zahlen. Die persönlichen Arme reichen bis 163.934, mit
 * Commons als drittem Arm bis 241.803, auf dem degradierten Kollaps-Pfad nur
 * bis 147.541. `>= 100` konnte damit vier verschiedene Dinge bedeuten, und der
 * Batch-Merge stellte einen Dreiarm-Wert vor einen Zweiarm-Wert — weil seine
 * Skala höher reicht, nicht weil er besser passte.
 *
 * Zwei Scores sind deshalb nur innerhalb DERSELBEN Armmenge und derselben
 * Formelversion vergleichbar. Wer über diese Grenze hinweg zusammenführt, muss
 * über die RÄNGE fusionieren (siehe `recall-batch.ts`).
 *
 * Eigenes Modul, damit `recall-handler.ts` und `http-hook-routes.ts` dieselbe
 * Antwort geben, ohne voneinander abzuhängen: Zwei Kopien wären genau die Art
 * Drift, die diesen Befund erzeugt hat.
 */

/**
 * Version der Score-FORMEL. Zu erhöhen, sobald DIESELBE Armmenge eine andere
 * Zahl ergibt — sonst vergleicht ein Konsument über die Versionsgrenze hinweg
 * zwei Werte, die nichts miteinander zu tun haben.
 */
export const SCORE_VERSION = "rrf-1";

/**
 * Die Armmenge, aus der der ausgelieferte Score gebildet wurde, sortiert.
 *
 * `personal-rank` steht bewusst NICHT für „bm25": Auf dem Kollaps-Pfad (der
 * persönliche Arm ist degradiert) geht nur noch der LISTENRANG der
 * persönlichen Liste ein, nicht ihr Zahlenwert. Das ist eine andere Zahl als
 * `bm25+commons`, und sie muss auch anders heißen.
 */
export function armsOf(state: { hybridActive: boolean; commonsFused: boolean }): string[] {
  if (state.commonsFused) {
    return state.hybridActive ? ["bm25", "commons", "vector"] : ["commons", "personal-rank"];
  }
  return state.hybridActive ? ["bm25", "vector"] : ["bm25"];
}
