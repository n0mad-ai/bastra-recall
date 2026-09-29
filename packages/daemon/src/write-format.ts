/**
 * PreToolUse Write/Edit lane — the hint block (split out of write-lane.ts,
 * #680): the recall hit shape and the `<recall-hints>` formatting.
 */
import { RRF_K, RRF_SCALE } from "@bastra-recall/core/rrf";
import { HINT_FRAME_NOTE, stripFenceMarkers } from "@bastra-recall/core/scrub";
import { requiredHeadline, unfusedHeadline, unfusedReasonFor, CANDIDATES_ONLY_NOTICE } from "./band-wording.js";
import { envInt } from "./env.js";

// Hits at/above this are non-negotiable loads. #9 Stage C: env-tunable so we
// can lift the REQUIRED band from telemetry without a rebuild.
export const MUST_LOAD_SCORE = envInt("BASTRA_MUST_LOAD_SCORE", 100);

export interface RecallHit {
  id: string;
  title: string;
  type: string;
  scope: string;
  summary: string;
  score: number;
  /** #148: matchte der Hit auf seinem hand-geschriebenen `recall_when`?
   *  Lässt starke, absichtliche Cross-Scope-Hits durch den #110-Filter. */
  matched_recall_when?: boolean;
  /** P0: Tragfähigkeit dieses Ankers — der Cross-Scope-Bypass verlangt
   *  `"strong"` (zwei exakte Trigger-Terme oder einen seltenen). */
  anchor_strength?: "strong" | "weak";
}

// ─── formatting ─────────────────────────────────────────────────────────────

function formatHintLine(h: RecallHit, hideScore = false): string {
  // Truncate summary to keep total payload small.
  const summary = h.summary.length > 220 ? h.summary.slice(0, 217) + "…" : h.summary;
  // Auf der unfused Skala ist die Zahl weder mit den Bändern noch zwischen
  // zwei Aufrufen vergleichbar — dieselbe Regel wie in den anderen Lanes.
  return hideScore
    ? `- ${h.id} (${h.type}): ${summary}`
    : `- ${h.id} (${h.type}, score ${Math.round(h.score)}): ${summary}`;
}

export function formatHintBlock(
  required: RecallHit[],
  optional: RecallHit[],
  project: string | null,
  weak = false,
  noHome = false,
  unfused = false,
  surface = "claude-code",
  // #565: der `degraded`-Grund der Antwort — ohne ihn behauptete der Block
  // „semantic search is off", wo der Arm lief und nur diesen Aufruf nicht
  // bediente.
  degraded?: string,
): string {
  const projAttr = project ? ` project="${escapeAttr(project)}"` : "";
  const head = `<recall-hints surface="${escapeAttr(surface)}"${projAttr}>`;
  const tail = `</recall-hints>`;
  const sections: string[] = [];

  if (required.length > 0) {
    // #249: on the hybrid path a top score is high BY CONSTRUCTION — a list
    // always has a first element. Calling that "strong" when nothing lexically
    // anchored is the defect this issue is about: the daemon knows, and used to
    // keep it to itself. Annotated rather than omitted, so the agent still sees
    // that a lookup happened and came up empty instead of silently getting less.
    sections.push(
      noHome
        ? `A lookup ran for what you're about to do and this vault has NO memory of ` +
          `it — nothing anchored lexically, and the ranking found no near neighbour ` +
          `either. The lines below are the least-bad rows of an empty result. Treat ` +
          `this as "not written down yet", not as weak evidence, and do not load them.`
        : weak
        ? `Ranked matches for what you're about to do — but NONE of them anchors ` +
          `lexically (no trigger phrase, no title term matched). On the hybrid path a ` +
          `high score is rank-1-of-nothing, so treat these as "probably not relevant" ` +
          `unless one obviously fits. Do not load them just because they are listed.`
        : unfused
        ? `${unfusedHeadline("what you're about to do", unfusedReasonFor(degraded))} ` +
          `load_memory(id) the ones that bear on this edit.`
        : `${requiredHeadline("what you're about to do", MUST_LOAD_SCORE, { k: RRF_K, scale: RRF_SCALE })} ` +
          `${CANDIDATES_ONLY_NOTICE} load_memory(id) the ones that bear on this edit. ` +
          `Hints, not obligations: load only what fits, don't batch-load the list.`,
    );
    for (const h of required) sections.push(formatHintLine(h, unfused));
  }

  if (optional.length > 0) {
    if (required.length > 0) sections.push("");
    sections.push(
      unfused
        ? `FURTHER DOWN the same lexical ranking — load only if the title/summary directly relates to the pending change:`
        : // #302: the honest reading of this band. Either one path only — such
          // a hit can never clear MUST_LOAD however well it ranks, since it
          // scores half of a two-armed hit at the same rank — or both paths,
          // but further down than the REQUIRED band demands.
          `OPTIONAL — found by ONE search path only, or by both but ranked lower. ` +
          `Load only if the title/summary directly relates to the pending change:`,
    );
    for (const h of optional) sections.push(formatHintLine(h, unfused));
  }

  // #152: reference-only frame + anti-spoof — vault-derived text (titles,
  // summaries) must not carry marker fragments that break out of the block.
  return [head, HINT_FRAME_NOTE, stripFenceMarkers(sections.join("\n")), tail].join("\n");
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
