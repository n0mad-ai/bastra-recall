/**
 * <pinned-memories>-Block (#141/#142) für den SessionStart-Hook.
 *
 * Recall ist pull-by-relevance; die Floor-Registry (floors.ts) ist
 * push-by-state: was eine Governance-Surface gefloort hat, wird bei jedem
 * Session-Start injiziert — VOR den score-gated Hints und unabhängig davon,
 * was der Turn für relevant hält. Eigenes Modul (Pattern doku-block.ts),
 * damit session-hook.ts dünn bleibt und das Formatting ohne CLI-Seiteneffekte
 * testbar ist.
 *
 * Frame wie die anderen recalled-content-Blöcke (#152): reference-only-Note
 * als erste Zeile + stripFenceMarkers auf allem vault-/surface-stämmigen Text
 * (Titel, reason, affirmed_by), damit kein Eintrag aus dem Block ausbrechen
 * oder einen Harness-Block fälschen kann.
 */
import { HINT_FRAME_NOTE, stripFenceMarkers } from "@bastra-recall/core/scrub";

/** Lean-Shape eines /hook/floors-Eintrags, wie der Hook ihn konsumiert. Der
 *  Daemon joint id→title/summary via vault.get; ein nicht (mehr) auflösbarer
 *  Eintrag kommt ohne title — er wird trotzdem gerendert (id-only), damit ein
 *  stale Floor sichtbar bleibt statt still Kontext-Budget zu reservieren. */
export interface PinnedFloorLean {
  memory_id: string;
  title?: string;
  summary?: string;
  reason: string;
  scope?: string;
  floored_at: string;
  last_affirmed: string;
  affirmed_by?: string;
}

/**
 * Zeichen-Budget für den GESAMTEN Block (~300 Tokens). Die Registry-Kappe
 * (MAX_FLOORS = 12) begrenzt die Menge, dieses Budget die Kontext-Kosten pro
 * Session-Start — beides zusammen ist die Rationierung aus #141 ("capped,
 * small by design — it's rationing the context window, not flooding it").
 */
export const PINNED_BLOCK_CHAR_BUDGET = 1200;

const REASON_MAX = 200;

function formatPinnedLine(e: PinnedFloorLean): string {
  const since = e.floored_at.slice(0, 10);
  const title = e.title ?? "(id not resolvable — stale floor?)";
  // Affirm-Teil nur, wenn je affirmed wurde (addFloor stampt last_affirmed =
  // floored_at, erst affirm() setzt affirmed_by).
  const affirmed = e.affirmed_by
    ? `, last affirmed ${e.last_affirmed.slice(0, 10)} by ${e.affirmed_by}`
    : "";
  const reason = e.reason.length > REASON_MAX ? e.reason.slice(0, REASON_MAX - 1) + "…" : e.reason;
  return `- [${e.memory_id}] ${title} — floored since ${since}${affirmed}: ${reason}`;
}

export interface FormattedPinnedBlock {
  text: string;
  /** Entries that actually made it into `text` — a strict prefix of
   *  `entries`, since the loop below breaks at the first one that does not
   *  fit. Truncated-out entries are NOT in here, on purpose: they were never
   *  shown, so they must stay eligible for a normal ranked hint slot instead
   *  of being dropped from both surfaces at once. */
  included: PinnedFloorLean[];
}

/**
 * Formatiert die Floor-Einträge als <pinned-memories>-Block. Leere Liste →
 * leerer String (kein Block). Einträge über dem Zeichen-Budget werden
 * abgeschnitten und als Truncation-Zeile ausgewiesen — die Kuration (was
 * zuerst fliegt) bleibt oberhalb des Engines; hier gilt Registry-Reihenfolge.
 */
export function formatPinnedBlock(entries: PinnedFloorLean[]): FormattedPinnedBlock {
  if (entries.length === 0) return { text: "", included: [] };
  const head = `<pinned-memories surface="claude-code">`;
  const intro =
    `Pinned memories — push-by-state (#141/#142): a governance surface floored these ` +
    `because a hard constraint or killed option looks least relevant exactly when it ` +
    `would have saved you. They are guaranteed-present, independent of relevance ` +
    `ranking. load_memory(id) when one bears on the work; membership and release are ` +
    `owned by the pinning surface, not by you.`;

  const lines: string[] = [];
  const included: PinnedFloorLean[] = [];
  let used = head.length + HINT_FRAME_NOTE.length + intro.length + `</pinned-memories>`.length;
  let truncatedCount = 0;
  for (const e of entries) {
    // #152 anti-spoof: title/reason/affirmed_by sind vault-/surface-stämmig.
    const line = stripFenceMarkers(formatPinnedLine(e));
    if (used + line.length + 1 > PINNED_BLOCK_CHAR_BUDGET) {
      truncatedCount = entries.length - lines.length;
      break;
    }
    lines.push(line);
    included.push(e);
    used += line.length + 1;
  }
  if (truncatedCount > 0) {
    lines.push(
      `… ${truncatedCount} more pinned ${truncatedCount === 1 ? "entry" : "entries"} truncated — ` +
        `the pinned set exceeds the ${PINNED_BLOCK_CHAR_BUDGET}-char context budget.`,
    );
  }
  const text = [head, HINT_FRAME_NOTE, intro, lines.join("\n"), `</pinned-memories>`].join("\n");
  return { text, included };
}

/**
 * Entfernt gepinnte Ids aus der score-gated Hint-Liste — der Dedup greift
 * IMMER auf der ranked Seite, nie auf der gepinnten: ein Eintrag im
 * <pinned-memories>-Block ist bereits garantiert präsent, die Hint-Liste soll
 * kein Kontext-Budget doppelt auf ihn ausgeben. Die Gegenrichtung (Pinned
 * fliegt raus, weil ranked ihn auch hat) existiert nicht — das wäre genau der
 * Drop, den #141 verbietet.
 */
export function dropPinnedFromRanked<T extends { id: string }>(
  hits: T[],
  pinned: readonly { memory_id: string }[],
): T[] {
  if (pinned.length === 0) return hits;
  const pinnedIds = new Set(pinned.map((p) => p.memory_id));
  return hits.filter((h) => !pinnedIds.has(h.id));
}
