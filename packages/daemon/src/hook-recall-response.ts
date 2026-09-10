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
  id: string;
  title: string;
  type: string;
  scope: string;
  summary: string;
  score: number;
}

export interface HookRecallResponse {
  hits: HookRecallHit[];
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
