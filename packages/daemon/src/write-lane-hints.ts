/**
 * Write/Edit lane — the memory-hint steps (split out of `runWriteLane`,
 * #1525): the recall self-call, the score and scope filters, the per-session
 * dedup, the choice of what is presented and the empty-streak backoff.
 */
import { isAbsolute, resolve } from "node:path";
import { envInt } from "./env.js";
import { applyLaneScopeFilter } from "./scope-filter.js";
import { laneRepoRoot } from "./code-graph/git-paths.js";
import { hookCaller } from "./hook-surface.js";
import { postHookRecall } from "./hook-recall-post.js";
import { classifyTransportError } from "./hook-transport.js";
import {
  formatCompactHint,
  isBindingAnchored,
  pretoolAreaKey,
  pretoolLegacyShape,
  type PretoolHintReason,
} from "./pretool-shape.js";
import {
  decideBackoff,
  getLoadedMarkerMtime,
  shouldDropHit,
  wasEmitConsumed,
  type ReadonlySessionState,
} from "./session-state.js";
import { MUST_LOAD_SCORE, formatHintBlock, type RecallHit } from "./write-format.js";
import type { HookStatus } from "./write-lane-telemetry.js";

const SCORE_FLOOR = envInt("BASTRA_RECALL_FLOOR", 30); // mirror SKILL.md: <30 is noise
// #161: backoff source key — write-edit hints back off independently of the
// other hook sources (bash-tripwire, bash-fail, prompt-lookup, todo-plan).
export const BACKOFF_SOURCE = "write-edit";

export interface RecallResponse {
  hits: RecallHit[];
  vault_size: number;
  latency_ms: number;
  recall_id: string;
  /** #249: no returned hit lexically anchors. Absent means "not weak". */
  weak_result?: boolean;
  /** #230: stricter subset of weak_result — the fact has no home in this vault. */
  no_home?: boolean;
  /** #302: no vector arm, so no RRF ran and the score is raw BM25 — an
   *  unbounded scale with no ceiling. The band cuts describe nothing there. */
  unfused?: boolean;
  /** Codex-Gegenreview: Kennt der VAULT den mitgeschickten Projektnamen als
   *  Scope (oder Familienmitglied)? Nur der Daemon kann das beantworten — die
   *  Lane sieht den Vault nicht. `false` heißt: nicht filtern. */
  project_known?: boolean;
  /** #342/#565: warum die Fusion ausfiel — `vector-arm-timeout` |
   *  `vector-arm-error` | `vector-arm-empty`; ohne Feld gab es keinen Arm. */
  degraded?: string;
}

export interface WriteRecall {
  resp: RecallResponse | null;
  status: HookStatus;
  errMsg: string | null;
}

/** Recall — loopback self-call, any failure → silent degrade. */
export async function recallForWrite(
  selfBaseUrl: string,
  payload: Parameters<typeof hookCaller>[0],
  request: { query: string; topics: string[]; project: string | null; toolName: string; excerpt: string },
  remainingMs: number
): Promise<WriteRecall> {
  try {
    const resp = await postHookRecall<RecallResponse>(
      selfBaseUrl,
      {
        query: request.query,
        topics: request.topics,
        project: request.project,
        tool_name: request.toolName,
        tool_input_excerpt: request.excerpt,
        k: 3,
        // #445: die Lane weist sich aus. `pre-tool` ist ihr Allowlist-Wert —
        // sie ist die PreToolUse-Lane für Write/Edit.
        ...hookCaller(payload),
        hook_source: "pre-tool",
      },
      remainingMs
    );
    return { resp, status: "ok", errMsg: null };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    const status = classifyTransportError(e);
    return { resp: null, status, errMsg: status === "error" ? (e.message ?? String(err)) : null };
  }
}

/**
 * Score-floor filter + Scope-Hard-Filter (#107, #110, #148): Hints aus
 * fremden Projekt-Scopes fliegen raus — seit #110 auch im REQUIRED-Band.
 * #148: nur ein Hit, der auf seinem HAND-geschriebenen recall_when matchte
 * UND im REQUIRED-Band sitzt, passiert cross-scope (passesScopeFilter).
 *
 * Diese Lane filtert seit #110 hart und tut es weiter — sie läuft deshalb
 * fest im enforce-Modus. Der gemeinsame Pfad bringt ihr zwei Dinge, die sie
 * vorher nicht hatte: die Reflex-Ausnahme und den Beleg-Schutz (ein Filter,
 * der seinen eigenen Projektnamen im Ergebnis nicht wiederfindet, wirft
 * nichts weg). Die Anker-Ausnahme aus #148 bleibt unverändert.
 */
export function filterWriteHits(resp: RecallResponse | null, filterProject: string | null) {
  const aboveFloor: RecallHit[] = [];
  if (resp && Array.isArray(resp.hits)) {
    for (const h of resp.hits) {
      if (h.score < SCORE_FLOOR) continue;
      aboveFloor.push(h);
    }
  }
  return applyLaneScopeFilter(
    aboveFloor,
    filterProject,
    {
      allowAnchoredCrossScope: true,
      mustLoadScore: MUST_LOAD_SCORE,
      unfused: resp?.unfused === true,
      exemptReflex: true,
      projectKnown: resp?.project_known,
    },
    "enforce"
  );
}

/** Per-session dedup (#32): a hit this session already saw stays out. */
export async function dedupWriteHits(
  hits: readonly RecallHit[],
  sessionState: ReadonlySessionState,
  dedupActive: boolean
): Promise<{ survivingHits: RecallHit[]; droppedDedupCount: number }> {
  const survivingHits: RecallHit[] = [];
  let droppedDedupCount = 0;
  for (const h of hits) {
    if (!dedupActive) {
      survivingHits.push(h);
      continue;
    }
    const entry = sessionState.shown[h.id];
    const loadedMtime = await getLoadedMarkerMtime(h.id);
    if (shouldDropHit(entry, loadedMtime)) {
      droppedDedupCount++;
      continue;
    }
    survivingHits.push(h);
  }
  return { survivingHits, droppedDedupCount };
}

export interface WritePresentation {
  legacyShape: boolean;
  unfused: boolean;
  hintReason: PretoolHintReason | null;
  compactHit: RecallHit | null;
  areaKey: string | null;
  presentedHits: RecallHit[];
  requiredHits: RecallHit[];
  optionalHits: RecallHit[];
}

/**
 * #621: compact first-touch shape (pretool-shape.ts). Ranking and filters
 * above are unchanged; this only decides which (at most one) surviving hit
 * is presented. `legacy` presents every surviving hit as before.
 *
 * Codex-Gegenreview: Diese Lane teilte rohe BM25-Werte weiter bei 100 in
 * REQUIRED/OPTIONAL — die dritte Stelle derselben P0-Sache, nachdem Prompt-
 * und Todo-Lane sie schon behandeln. Ohne Fusion gibt es keine Bänder: Alle
 * Treffer stehen dann in EINER Liste unter der ehrlichen Überschrift, statt
 * an einer Schwelle geteilt zu werden, die auf dieser Skala nichts bedeutet.
 */
export function presentWriteHits(
  survivingHits: RecallHit[],
  resp: RecallResponse | null,
  sessionState: ReadonlySessionState,
  target: { first: string | undefined; filePath: string; cwd: string }
): WritePresentation {
  const unfused = resp?.unfused === true;
  const legacyShape = pretoolLegacyShape();
  const compact =
    !legacyShape && survivingHits.length > 0
      ? compactChoice(survivingHits, resp, sessionState, target, unfused)
      : { hintReason: null, compactHit: null, areaKey: null };
  const presentedHits = legacyShape ? survivingHits : compact.compactHit ? [compact.compactHit] : [];
  const requiredHits: RecallHit[] = [];
  const optionalHits: RecallHit[] = [];
  for (const h of presentedHits) {
    if (unfused) requiredHits.push(h);
    else if (h.score >= MUST_LOAD_SCORE) requiredHits.push(h);
    else optionalHits.push(h);
  }
  return { legacyShape, unfused, ...compact, presentedHits, requiredHits, optionalHits };
}

/** Which one surviving hit the compact shape presents, and why (#621). */
function compactChoice(
  survivingHits: RecallHit[],
  resp: RecallResponse | null,
  sessionState: ReadonlySessionState,
  target: { first: string | undefined; filePath: string; cwd: string },
  unfused: boolean
): Pick<WritePresentation, "hintReason" | "compactHit" | "areaKey"> {
  const file = target.first ?? (isAbsolute(target.filePath) ? target.filePath : resolve(target.cwd, target.filePath));
  const areaKey = pretoolAreaKey(laneRepoRoot(file, target.cwd), file);
  if (resp?.weak_result === true || resp?.no_home === true) return { hintReason: "weak", compactHit: null, areaKey };
  if (sessionState.shown[areaKey] === undefined)
    return { hintReason: "first-touch", compactHit: survivingHits[0]!, areaKey };
  const compactHit = survivingHits.find((h) => isBindingAnchored(h, MUST_LOAD_SCORE, unfused)) ?? null;
  return { hintReason: compactHit ? "binding-anchored" : "repeat-area", compactHit, areaKey };
}

/** The hint block for what is presented, or null when nothing is. */
export function writeHintsBlock(
  p: WritePresentation,
  resp: RecallResponse | null,
  project: string | null,
  client: string
): string | null {
  if (p.requiredHits.length + p.optionalHits.length === 0) return null;
  if (p.compactHit)
    return formatCompactHint(p.compactHit, project, client, p.hintReason as "first-touch" | "binding-anchored");
  return formatHintBlock(
    p.requiredHits,
    p.optionalHits,
    project,
    resp?.weak_result === true,
    resp?.no_home === true,
    resp?.unfused === true,
    client,
    resp?.degraded
  );
}

/**
 * Empty-streak backoff (#161): unconsumed injection streaks widen the
 * cadence. REQUIRED-band hits bypass suppression — see decideBackoff.
 * Der Backoff-Bypass hängt am REQUIRED-Band — das es ohne Fusion nicht
 * gibt. Sonst hörte er genau dann auf zu greifen, wenn der Recall am
 * wenigsten weiß (wortgleich zu prompt-lane.ts).
 */
export async function writeBackoff(
  sessionState: ReadonlySessionState,
  p: WritePresentation
): Promise<{ streak: number; suppress: boolean; consumed: boolean }> {
  const entry = sessionState.sources?.[BACKOFF_SOURCE];
  const consumed = await wasEmitConsumed(entry);
  const decision = decideBackoff(entry, consumed, !p.unfused && p.requiredHits.length > 0);
  return { streak: decision.streak, suppress: decision.suppress, consumed };
}
