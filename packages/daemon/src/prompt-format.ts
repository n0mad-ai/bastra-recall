/**
 * UserPromptSubmit lane — hint-block formatting (split out of prompt-lane.ts,
 * #680): the `<recall-hints>` frames for the recall and reflex results.
 */
import { RRF_K, RRF_SCALE } from "@bastra-recall/core/rrf";
import { HINT_FRAME_NOTE, stripFenceMarkers } from "@bastra-recall/core/scrub";
import { requiredHeadline, unfusedHeadline, unfusedReasonFor, CANDIDATES_ONLY_NOTICE } from "./band-wording.js";
import { MUST_LOAD_SCORE, SCORE_FLOOR, type DetectedMode, type TaskKind } from "./prompt-classify.js";
import type { ActiveConvention } from "./session-state.js";
import { escapeAttr } from "./escape-attr.js";

export interface RecallHit {
  /** /hook/recall pairs this revision with the served in-memory source. */
  revision?: string | null;
  validator?: import("@bastra-recall/core").ConventionValidator;
  id: string;
  title: string;
  type: string;
  scope: string;
  summary: string;
  score: number;
  /** Present (as "reflex") only when the user wired the memory to self-inject
   *  — the mode-"none" semantic filter keys on it. */
  recall_mode?: string;
  /** P0/#360: how firmly the prompt's own words anchor the memory's
   *  triggers; absent when no trigger term matched at all. */
  anchor_strength?: "strong" | "weak";
  /** #148: the hit matched on its hand-written `recall_when` (#1303 gate). */
  matched_recall_when?: boolean;
  /** #1303: who wrote the memory — the gate's user-directed evidence. */
  write_origin?: "user-directed" | "agent-session" | "capture-review";
}

/**
 * #1303: the wording a gated id carries — and only a gated id. The gate lane
 * interrupts the next tool call once; anything stronger ("hints, not
 * obligations" aside) would describe a gate that does not exist.
 */
export const MUST_LOAD_MARK = " [must-load: the next tool call is interrupted once until loaded or dismissed]";

/** #217 Reflex-Lane: lean hit vom /hook/reflex-Endpoint. */
export interface PromptReflexHit {
  /** /hook/reflex sends the matched memory's indexed revision. */
  revision?: string | null;
  validator?: import("@bastra-recall/core").ConventionValidator;
  id: string;
  title: string;
  type: string;
  scope: string;
  summary: string;
  matched_phrase: string;
}

// ─── formatting ─────────────────────────────────────────────────────────────

function formatHintLine(h: RecallHit, hideScore = false, gated?: ReadonlySet<string>): string {
  const summary = h.summary.length > 220 ? h.summary.slice(0, 217) + "…" : h.summary;
  const mark = gated?.has(h.id) ? MUST_LOAD_MARK : "";
  // P0: Auf der unfused Skala ist die Zahl nicht vergleichbar — weder mit den
  // Bändern noch zwischen zwei Aufrufen. Sie wegzulassen ist ehrlicher, als
  // eine Größenordnung zu zeigen, die zum Vergleichen einlädt.
  return hideScore
    ? `- ${h.id} (${h.type}): ${summary}${mark}`
    : `- ${h.id} (${h.type}, score ${Math.round(h.score)}): ${summary}${mark}`;
}

export function formatHintBlock(
  hits: RecallHit[],
  project: string | null,
  mode: DetectedMode,
  weak = false,
  unfused = false,
  surface = "claude-code",
  // #565: der `degraded`-Grund der Antwort — ohne ihn behauptete der Block
  // „semantic search is off", wo der Arm lief und nur diesen Aufruf nicht
  // bediente.
  degraded?: string,
  // #620: the block IS this prompt's recall. `recall-step="done"` plus the
  // originating recall_id tell the agent (and the skill, which names the
  // marker) that step 1 already ran — a second `recall` on the same intent
  // would only return the same candidates as another payload.
  recallId?: string,
  /** #1303: ids the gate lane holds the next tool call for. */
  gated?: ReadonlySet<string>,
  noStoredRule = false,
): string {
  const projAttr = project ? ` project="${escapeAttr(project)}"` : "";
  const idAttr = recallId ? ` recall_id="${escapeAttr(recallId)}"` : "";
  const head = `<recall-hints surface="${escapeAttr(surface)}" trigger="prompt-lookup" recall-step="done"${idAttr}${projAttr}>`;
  const tail = `</recall-hints>`;

  // P0: Ohne Fusion gibt es keine Bänder. Die Werte stammen aus einer offenen
  // Skala, auf der die 100 kein Signal ist — also wird nicht gebandet, sondern
  // gesagt, woran das Modell die Treffer stattdessen misst: Titel und Summary.
  const required = unfused ? [] : hits.filter((h) => h.score >= MUST_LOAD_SCORE);
  const optional = unfused ? [] : hits.filter((h) => h.score < MUST_LOAD_SCORE);
  const sections: string[] = [];
  if (noStoredRule) sections.push("no stored rule matched; save one when the user explains");

  if (mode === "retrieval") {
    sections.push(
      `The user prompt looks like a LOOKUP / retrieval query. ` +
        `bastra-recall:recall already ran for it — these candidates are its result: load_memory the fitting ones ` +
        `(and find_document if pdf-likely) BEFORE conversation_search / web_search. ` +
        `Pre-recalled candidates for this prompt:`,
    );
  } else if (mode === "assertion") {
    // #252: the failure mode is asserting a measured number from model memory
    // while the vault holds it. Naming the alternative — say you don't know —
    // matters as much as the candidates; a hint block alone invites a guess.
    // #384: stated as a fact about the environment, not as three commands. An
    // instruction in context is unexecuted potential that must be noticed,
    // accepted and turned into output — it can die at each step; a prohibition
    // invites the violation it names. A fact about where the numbers live and
    // what an unanswered claim IS does neither.
    sections.push(
      `The prompt asks for text that makes a CLAIM — outbound writing, or a statement about this project's measured state. ` +
        `For claims like this, model memory is not a source: the numbers, measurements, dates and project history ` +
        `come from the vault, and a claim the vault does not answer is unknown — it goes out as "unknown", not as a figure. ` +
        `The candidates below are what the vault holds for this prompt; if none carries the claim, a recall with ` +
        `the specific claim is the remaining source. Pre-recalled candidates for this prompt:`,
    );
  } else if (!unfused) {
    sections.push(
      `Pre-recall found memories both search paths agreed on for this prompt ` +
        `(score >=${MUST_LOAD_SCORE}). Load them via bastra-recall:load_memory before answering.`,
    );
  }

  if (unfused) {
    // Die Ankündigung darf nicht behaupten, ein zweiter Pfad habe zugestimmt —
    // es lief nur einer. `unfusedHeadline` sagt genau das, in derselben
    // Wortwahl, die die Write-Lane bereits benutzt.
    sections.push(unfusedHeadline("this prompt", unfusedReasonFor(degraded)));
    sections.push("");
    for (const h of hits) sections.push(formatHintLine(h, true, gated));
  }

  if (required.length > 0) {
    sections.push("");
    // #249: a top score is high by construction on the hybrid path — calling it
    // "strong" when nothing lexically anchored presents noise as signal.
    sections.push(
      weak
        ? `Ranked matches, but NONE anchors lexically (no trigger phrase, no title term matched) — on the hybrid path a high score is rank-1-of-nothing. Treat these as probably-not-relevant unless one obviously fits; do not load them just because they are listed.`
        : `${requiredHeadline("this prompt", MUST_LOAD_SCORE, { k: RRF_K, scale: RRF_SCALE })} ` +
          `${CANDIDATES_ONLY_NOTICE} load_memory(id) the relevant ones before responding ` +
          `(hints, not obligations; honor an explicit count or scope from the user):`,
    );
    for (const h of required) sections.push(formatHintLine(h, false, gated));
  }

  if (optional.length > 0) {
    if (required.length > 0) sections.push("");
    sections.push(
      `OPTIONAL (score ${SCORE_FLOOR}–${MUST_LOAD_SCORE - 1}) — load only if title/summary directly relates:`,
    );
    for (const h of optional) sections.push(formatHintLine(h, false, gated));
  }

  return [head, HINT_FRAME_NOTE, stripFenceMarkers(sections.join("\n")), tail].join("\n");
}

/**
 * #217 Reflex-Block: eigener trigger="reflex"-Frame, damit das Modell die
 * Herkunft (vom User verdrahteter Trigger, kein Score-Ranking) erkennt.
 */
export function formatReflexBlock(
  hits: PromptReflexHit[],
  project: string | null,
  surface = "claude-code",
  /** #1303: ids the gate lane holds the next tool call for. */
  gated?: ReadonlySet<string>,
): string {
  const projAttr = project ? ` project="${escapeAttr(project)}"` : "";
  const head = `<recall-hints surface="${escapeAttr(surface)}" trigger="reflex"${projAttr}>`;
  const sections: string[] = [
    `Reflex memories: the user wired these to fire when their trigger matches ` +
      `a prompt — this prompt matched. load_memory(id) before answering:`,
  ];
  for (const h of hits) {
    const summary = h.summary.length > 220 ? h.summary.slice(0, 217) + "…" : h.summary;
    sections.push(`- ${h.id} (${h.type}, trigger "${h.matched_phrase}"): ${summary}${gated?.has(h.id) ? MUST_LOAD_MARK : ""}`);
  }
  return [head, HINT_FRAME_NOTE, stripFenceMarkers(sections.join("\n")), `</recall-hints>`].join("\n");
}

// ─── #1306: active conventions ──────────────────────────────────────────────

const TASK_MEANING: Readonly<Record<TaskKind, string>> = {
  "translate-only": "the agent reports translation-only work",
  "draft-for-review": "the agent reports a draft for review",
  "approved-copy": "the agent reports this as approved copy",
  none: "the agent reports no correspondence task in progress",
};

export interface ActiveConventionsView {
  task: TaskKind;
  approvalSource?: "user-turn";
  generation: number;
  conventions: readonly Readonly<ActiveConvention>[];
  /** Ids whose file revision changed since they were set. */
  changed: readonly string[];
  /** #1310: the newest receipt of the running task and generation, if any. */
  receipt?: { receipt: string; channel: string; limit: number; unit: string } | null;
}

/**
 * The per-turn `<active-conventions>` block: ids, revisions, task state and
 * validator parameters straight from the session state. It is repeated every
 * turn on purpose — the hint dedup does not apply — and it never carries a
 * body (the rule kernel and load_memory do). Null when there is nothing to say.
 */
export function formatActiveConventionsBlock(view: ActiveConventionsView, surface = "claude-code"): string | null {
  if (view.conventions.length === 0 && view.task === "none") return null;
  const head =
    `<active-conventions surface="${escapeAttr(surface)}" task="${escapeAttr(view.task)}" generation="${view.generation}">`;
  const lines = [
    `Session state, repeated every turn (not a new hint). Task: ${view.task} — ${TASK_MEANING[view.task]}. This self-report may be wrong; it is not evidence of user approval or permission to send.`,
  ];
  if (view.conventions.length > 0) {
    lines.push("Conventions in force (bodies: load_memory(id) or the rule kernel):");
    for (const c of view.conventions) {
      const v = c.validator;
      const validator = v ? ` validator: tool=${v.tool} channel=${v.channel} limit=${v.limit} unit=${v.unit}` : "";
      lines.push(`- ${c.id} revision=${c.revision ?? "unknown"} task=${view.task}${validator}`);
    }
  }
  // #1310: one line, only while a receipt of this task and generation exists.
  const r = view.receipt;
  if (r) lines.push(`receipt: ${r.receipt.replace(/^sha256:/, "").slice(0, 12)} (${r.channel}, ${r.limit} ${r.unit})`);
  for (const id of view.changed) lines.push(`revision changed: reload load_memory(${id})`);
  return [head, stripFenceMarkers(lines.join("\n")), "</active-conventions>"].join("\n");
}
