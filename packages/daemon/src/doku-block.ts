/**
 * Produkt-Doku-Anweisungsblock (docs.mode) — von session-hook.ts injiziert,
 * wenn docs.mode != "off" und ein Projekt erkannt wurde. Eigenes Modul, weil
 * session-hook.ts beim Import main() startet und damit untestbar ist.
 *
 * "suggest" lässt den Agent erst fragen, "auto" schreibt ohne Rückfrage.
 */
import type { DocsMode } from "./settings.js";
import type { DetectedProject } from "@bastra-recall/core/topics";

/**
 * Verdient diese Projekterkennung einen Doku-Block? (#511)
 *
 * `detectProject()` liefert für JEDEN nichtleeren Pfad einen Namen: ein
 * Container-Root wie `~/Projekte` matcht ein bekanntes Wurzelsegment
 * (`root-match`), ein beliebiges Verzeichnis fällt auf sein letztes Segment
 * zurück (`fallback`). Der Doku-Block gatete früher auf `if (project)` und
 * zahlte damit 239 Tokens/Start „wie dokumentiere ich dieses Projekt" für
 * Verzeichnisse, die gar keins sind. Getroffen werden davon tatsächlich die
 * `root-match`-Verzeichnisse ohne `.git` — unter `~/Projekte` auf dieser
 * Maschine 15 von 29 (nachgezählt 2026-09-11). `fallback` war hier schon
 * vorher aus — `projectForLane` setzt ihn seit §20.5 auf null, und `~/Projekte`
 * selbst ist `fallback`, nicht `root-match`.
 *
 * Doku ist per-Projekt-Doku; sie wird aus dem Repo heraus geschrieben.
 * `git-root` ist die einzige Confidence, die wirklich ein Repository benennt
 * — dieselbe Auskunft, der `projectForFilter` für die Gegenrichtung traut.
 * `root-match` und `fallback` sind kein Beleg für ein Projekt und bekommen
 * keinen Block. (Der geratene Name bleibt für Query und Recall-Scope
 * brauchbar — nur zum Bezahlen von Doku-Tokens taugt er nicht.)
 */
export function isDokuProject(confidence: DetectedProject["confidence"]): boolean {
  return confidence === "git-root";
}

export function formatDokuBlock(
  mode: Exclude<DocsMode, "off">,
  language: string,
  project: string,
): string {
  const modeLine =
    mode === "auto"
      ? `Mode is "auto": update the doc autonomously, then ack in one line (→ doc updated: <area>).`
      : `Mode is "suggest": propose the doc update to the user first (one line, what would change) and only write after they agree.`;
  return (
    `\n<bastra-product-docs mode="${mode}">\n` +
    `Product-documentation capture is ON for this vault. When a USER-FACING feature area of ` +
    `"${project}" is completely finished in this session (works end-to-end, user confirmed or the ` +
    `commit landed), keep its product doc current via the save_product_doc tool:\n` +
    `- One doc per feature area (project="${project}", area=<feature area>), stored under ` +
    `dokumentationen/${project}/ — update-in-place, the body you send REPLACES the doc.\n` +
    `- First find_document/read_document the existing doc for the area; merge and send the COMPLETE updated markdown.\n` +
    `- Write for the END USER (what the feature does, how to use it, tips, quirks) in language "${language}". ` +
    `No code internals, no file paths — developer state stays in save_memory type 'project-fact'.\n` +
    `- Only on completion — never for work in progress, refactors, or internal-only changes.\n` +
    `${modeLine}\n` +
    `</bastra-product-docs>`
  );
}
