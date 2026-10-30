/**
 * Die Recall-Antwort, wie jede Hook-Lane sie über `/hook/recall` sieht — EIN
 * Typ für alle Surfaces (P0).
 *
 * Vorher trug jede Lane ihre eigene Kopie. Die drei ältesten (SessionStart,
 * Bash-Pre, Bash-Fail) kannten `score_kind`/`unfused` nicht, also fiel das
 * Feld beim Parsen still weg und die Lanes banden rohe BM25-Werte mit Cuts,
 * die nur auf der fusionierten Skala existieren. Ein gemeinsamer Typ macht
 * genau dieses Vergessen unmöglich.
 *
 * Import-Disziplin wie im Rest des Hook-Pfads (#305): keine Abhängigkeiten,
 * damit der Skip-Gate-Pfad nichts dafür bezahlt.
 */

export interface HookRecallHit {
  rulebook?: "always" | "on-demand";
  applies_when?: string;
  rulebook_proposed?: import("@bastra-recall/core").Frontmatter["rulebook_proposed"];
  revision?:string|null;
  validator?: import("@bastra-recall/core").ConventionValidator;
  id: string;
  title: string;
  type: string;
  scope: string;
  summary: string;
  score: number;
  /** #148: the hit matched on its hand-written `recall_when`. */
  matched_recall_when?: boolean;
  /** P0: how strong that trigger anchor is — `strong` = two exact trigger
   *  terms or one rare one. */
  anchor_strength?: "strong" | "weak";
  /** Present only when the user wired the memory to self-inject. */
  recall_mode?: "reflex";
  /** #1303: who wrote the memory (#158). The gate books a must-load only for
   *  a rule the user dictated, wired or anchored by its own trigger. */
  write_origin?: "user-directed" | "agent-session" | "capture-review";
}

/** #1303: the hint types a must-load gate may hold an action for. */
export const GATED_HINT_TYPES: ReadonlySet<string> = new Set(["user-preference", "meta-working", "workflow"]);

/**
 * #1303: does this emitted hint become a pending must-load? Only rule-shaped
 * types, and only with evidence the rule belongs here: its own trigger
 * matched, the user wired it as reflex, or the user dictated it.
 */
export function isGatedHint(h: {
  type: string;
  matched_recall_when?: boolean;
  recall_mode?: string;
  write_origin?: string;
}): boolean {
  return (
    GATED_HINT_TYPES.has(h.type) &&
    (h.matched_recall_when === true || h.recall_mode === "reflex" || h.write_origin === "user-directed")
  );
}

export interface HookRecallResponse {
  hits: HookRecallHit[];
  draft_hits?: import("./draft-search.js").DraftHit[];
  vault_size: number;
  latency_ms: number;
  recall_id: string;
  /** #249: kein zurückgegebener Hit knüpft lexikalisch an — der Top-Score ist
   *  Rang-1-von-nichts. Abwesend heißt „nicht weak". */
  weak_result?: boolean;
  /** #230: strengere Teilmenge von weak_result — der Fakt hat hier kein Zuhause. */
  no_home?: boolean;
  /** Welche ZAHL serviert wird: `rrf` = fusionierte Rang-Summe (Obergrenze
   *  163.934, die Cuts bedeuten etwas), `bm25` = roher Wert auf offener Skala. */
  score_kind?: "rrf" | "bm25";
  /** Kurzform von `score_kind === "bm25"`. */
  unfused?: boolean;
  /** #342: WARUM nur ein Arm lief — `vector-arm-timeout` (Deadline gerissen)
   *  oder `vector-arm-empty` (der Arm hatte nichts zu sagen). Abwesend heißt
   *  „kein Arm ist ausgefallen"; das ist nicht dasselbe wie fusioniert, denn
   *  auf einer Maschine ohne Embeddings gibt es gar keinen zweiten Arm.
   *  `/hook/recall` sendet das Feld seit #342 als `degraded` — die Lanes haben
   *  es beim Parsen bisher fallen lassen. */
  degraded?: string;
}

/**
 * Fail-closed: alles, was nicht ausdrücklich als fusioniert ankommt, gilt als
 * unfused. Eine ältere Daemon-Version antwortet ohne beide Felder — dann ist
 * „kein Band" die einzige Aussage, die sicher stimmt.
 */
export function isUnfused(resp: HookRecallResponse | null | undefined): boolean {
  if (!resp) return false;
  if (resp.unfused === true) return true;
  return resp.score_kind !== "rrf";
}
