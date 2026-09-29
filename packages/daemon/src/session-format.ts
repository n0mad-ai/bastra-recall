/**
 * SessionStart lane — merging the per-scope recalls and formatting the
 * session block (split out of session-lane.ts, #680).
 */
import { RRF_K, RRF_SCALE } from "@bastra-recall/core/rrf";
import { HINT_FRAME_NOTE, stripFenceMarkers } from "@bastra-recall/core/scrub";
import { bandHits, requiredHeadline, unfusedHeadline, CANDIDATES_ONLY_NOTICE, type UnfusedReason } from "./band-wording.js";
import type { ConventionLean, RecallHit } from "./session-hook-http.js";

export const SCORE_FLOOR = 30;

const MUST_LOAD_SCORE = 100;

/**
 * Dedup + Reihenfolge über die (bis zu drei) scope-gefilterten Antworten.
 *
 * P0: `unfused` entscheidet, ob überhaupt gerechnet werden darf. Fusioniert
 * bleibt alles wie bisher — gemeinsame Skala, Floor, absteigend sortiert.
 * Unfusioniert stammen die Zahlen aus einer offenen Skala und aus getrennten
 * Aufrufen: 405585 schlägt 160 immer, ohne besser zu sein. Dann wird REIHUM
 * genommen, jede Query behält ihren eigenen Rang, und der Floor entfällt, weil
 * 30 auf dieser Skala keinen Punkt markiert.
 */
export function mergeSessionHits(
  responses: Array<{ scope: string; resp: { hits: RecallHit[] } | null }>,
  unfused: boolean,
  floor: number,
): RecallHit[] {
  const seen = new Set<string>();
  const lists = responses.filter((r) => r.resp !== null).map((r) => r.resp!.hits);

  if (unfused) {
    const merged: RecallHit[] = [];
    const depth = Math.max(0, ...lists.map((l) => l.length));
    for (let i = 0; i < depth; i++) {
      for (const list of lists) {
        const h = list[i];
        if (!h || seen.has(h.id)) continue;
        seen.add(h.id);
        merged.push(h);
      }
    }
    return merged;
  }

  const merged: RecallHit[] = [];
  for (const list of lists) {
    for (const h of list) {
      if (h.score < floor) continue;
      if (seen.has(h.id)) continue;
      seen.add(h.id);
      merged.push(h);
    }
  }
  merged.sort((a, b) => b.score - a.score);
  return merged;
}

export function formatBlock(
  hits: RecallHit[],
  project: string | null,
  source: string | null,
  weak = false,
  unfused = false,
  surface = "claude-code",
  /** #490: WARUM einarmig. `cold-model` nur, wenn der Koordinator das Modell
   *  als nicht resident gemeldet hat — sonst bleibt es bei der alten Aussage. */
  unfusedReason: UnfusedReason = "off",
): string {
  const projAttr = project ? ` project="${escapeAttr(project)}"` : "";
  const srcAttr = source ? ` source="${escapeAttr(source)}"` : "";
  const head = `<session-context surface="${escapeAttr(surface)}"${projAttr}${srcAttr}>`;
  const tail = `</session-context>`;

  // P0: zentrale Bandzuweisung. Ohne Fusion vergibt sie kein Band — die Cuts
  // 30/100 sind Punkte auf der Rang-Summen-Skala und selektieren auf rohen
  // BM25-Werten nichts.
  const { required, optional, unbanded } = bandHits(hits, MUST_LOAD_SCORE, unfused);
  const sections: string[] = [];

  if (unbanded.length > 0) {
    sections.push(
      `${unfusedHeadline(`the ${project ?? "current"} session`, unfusedReason)} ${CANDIDATES_ONLY_NOTICE} ` +
        `load_memory(id) the ones relevant to what the user actually asks for. ` +
        `These are hints, not obligations.`,
    );
    for (const h of unbanded) sections.push(formatHintLine(h, true));
  }

  if (required.length > 0) {
    // #249: see hook.ts — the honesty flag decides how this block is framed.
    sections.push(
      weak
        ? `Ranked matches, but NONE anchors lexically (no trigger phrase, no title term matched) — on the hybrid path a high score is rank-1-of-nothing. Treat these as probably-not-relevant unless one obviously fits; do not load them just because they are listed.`
        : `${requiredHeadline(`the ${project ?? "current"} session`, MUST_LOAD_SCORE, { k: RRF_K, scale: RRF_SCALE })} ` +
          `${CANDIDATES_ONLY_NOTICE} ` +
          `load_memory(id) the ones relevant to what the user actually asks for. ` +
          `These are hints, not obligations: load only what fits, don't batch-load the list, ` +
          `and if the user requested a specific number or scope, honor that over this list.`,
    );
    for (const h of required) sections.push(formatHintLine(h));
  }

  if (optional.length > 0) {
    if (required.length > 0) sections.push("");
    sections.push(
      `OPTIONAL (score ${SCORE_FLOOR}–${MUST_LOAD_SCORE - 1}) — load only when the user prompt directly touches the topic:`,
    );
    for (const h of optional) sections.push(formatHintLine(h));
  }

  return [head, HINT_FRAME_NOTE, stripFenceMarkers(sections.join("\n")), tail].join("\n");
}

function formatHintLine(h: RecallHit, hideScore = false): string {
  const summary = h.summary.length > 220 ? h.summary.slice(0, 217) + "…" : h.summary;
  // P0: Auf der unfused Skala ist die Zahl weder mit den Bändern noch zwischen
  // zwei Aufrufen vergleichbar — gleiche Wahl wie in prompt-lane.ts.
  return hideScore
    ? `- ${h.id} (${h.type}/${h.scope}): ${summary}`
    : `- ${h.id} (${h.type}/${h.scope}, score ${Math.round(h.score)}): ${summary}`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Konventions-Block (#66). Kompakt: Id + Titel pro Konvention, dazu die
 * Anweisung, sie beim Speichern zu BEFOLGEN (Details via load_memory). Cap 6 —
 * mehr Konventionen heißt das Vault braucht eher eine Meta-Aufräumrunde als
 * mehr Kontext. #509: keine Summary mehr — der Rahmen verweist ohnehin auf
 * load_memory(id), und die Summaries waren gemessen 440 von 605 Tokens der
 * sechs Zeilen (Vault des Owners, 28.09.2026).
 */
export function formatTaxonomyBlock(conventions: ConventionLean[]): string {
  if (conventions.length === 0) return "";
  // #152: anti-spoof strip only — deliberately NO reference-only note here,
  // conventions are meant to be BINDING instructions.
  const lines = conventions
    .slice(0, 6)
    .map((c) => stripFenceMarkers(`- [${c.id}] ${c.title}`));
  return (
    `\n<vault-taxonomy>\n` +
    `Self-learned vault conventions — BINDING when saving memories in these clusters. ` +
    `Follow the convention's folder/topic_path/tags exactly (load_memory(id) for the full rule) ` +
    `instead of inventing variant tags that fragment recall:\n` +
    lines.join("\n") +
    // #232: the gate carries the read-hint for its own reference file. Applying
    // a listed convention needs nothing extra; establishing a new one does, and
    // this block is the only moment that distinction is visible.
    `\nSaving into a recurring cluster that NO convention above covers is the ` +
    `establish case — read the skill's taxonomy.md before inventing a home for it.` +
    `\n</vault-taxonomy>`
  );
}
