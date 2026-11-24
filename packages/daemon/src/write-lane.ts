/**
 * PreToolUse Write/Edit/apply_patch lane, daemon-side (#343/#15 — stage A of #305 direction 2,
 * second half; the UserPromptSubmit lane moved in the first).
 *
 * The pipeline that lived in `hook.ts` behind the skip gate: file-size note,
 * topic/project detection, recall self-call, score/scope filters (#107/#110/
 * #148), per-session dedup (#32), empty-streak backoff (#161), formatting,
 * telemetry, usage ping. Moved verbatim behind POST /hook/write; the hook file
 * is a thin client now.
 *
 * The SKIP GATE stayed client-side on purpose. It is pure stdlib (#20/#28) and
 * it fires on the MAJORITY of tool calls — a skipped call should cost a
 * process start and nothing else: no HTTP round trip, no daemon dependency.
 * Everything that survives the gate lands here.
 *
 * Same two non-changes as prompt-lane.ts, same reasons: recall stays a
 * loopback self-call (the hook_call telemetry series keeps measuring the same
 * thing mid-migration), session state stays on the file bus.
 */
import { detectTopics, extractContentExcerpt } from "@bastra-recall/core";
import { envInt } from "./env.js";
import { recordBudgetShadow } from "./session-budget.js";
import { projectConfidence, projectForFilter, projectForLane } from "./scope-filter.js";
import { fileSizeNote } from "./file-size-check.js";
import type { ImpactNote } from "./code-graph/impact-block.js";
import type { AppliesToNote } from "./code-graph/applies-to-note.js";
import { memoryLocationNote } from "./memory-location.js";
import { reportHinted } from "./hook-hinted.js";
import { hookClient, hookAgent, hookClientEvidence } from "./hook-surface.js";
import {
  bumpShown,
  cleanupOldStates,
  loadSessionState,
  recordSourceEmit,
  recordSourceSuppressed,
  mutateSessionState,
  type ReadonlySessionState,
  type SessionState,
} from "./session-state.js";
import { writeTelemetry, type HookStatus } from "./write-lane-telemetry.js";
import { fitOptional, PRE_TOOL_CONTEXT_CHAR_BUDGET } from "./pretool-budget.js";
import { collectCodeNotes, logImpactBlocks, type WriteCodeNotes } from "./write-lane-code.js";
import {
  BACKOFF_SOURCE,
  dedupWriteHits,
  filterWriteHits,
  presentWriteHits,
  recallForWrite,
  writeBackoff,
  writeHintsBlock,
  type WritePresentation,
  type WriteRecall,
} from "./write-lane-hints.js";

// #680: formatting and the telemetry row live in their own modules; the lane's
// public surface is re-exported unchanged.
export { formatHintBlock } from "./write-format.js";
export { MAX_CODE_TARGETS, codeTargets } from "./write-lane-code.js";

// 600ms — measured rationale in the original hook header (12,966 calls,
// median 60ms, p90 225ms, 6.2% timeouts at the old 250ms budget).
const HOOK_TIMEOUT_MS = envInt("BASTRA_HOOK_TIMEOUT_MS", 600, "NEXUS_HOOK_TIMEOUT_MS");

export interface WriteHookPayload {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

const SUPPORTED_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "apply_patch"]);

type StateDelta = (s: SessionState) => void;

/** The call this lane answers, or null for anything it does not. */
function writeCall(
  payload: WriteHookPayload
): { toolName: string; toolInput: Record<string, unknown>; filePath: string } | null {
  if (payload.hook_event_name !== "PreToolUse") return null;
  const toolName = payload.tool_name ?? "";
  if (!SUPPORTED_TOOLS.has(toolName)) return null;
  const toolInput = (payload.tool_input ?? {}) as Record<string, unknown>;
  const filePath = typeof toolInput.file_path === "string" ? toolInput.file_path : null;
  if (!filePath) return null;
  return { toolName, toolInput, filePath };
}

/**
 * Run the Write/Edit pipeline and return the exact JSON string the thin
 * client writes to stdout. Never throws; every failure degrades to `{}` plus
 * telemetry, matching the CLI's fail-open contract.
 *
 * #1525: the steps live in `write-lane-hints.ts` (recall, filters, dedup,
 * presentation, backoff) and `write-lane-code.ts` (code-graph blocks and
 * touched-file bookings); this function runs them in the lane's order.
 */
export async function runWriteLane(
  payload: WriteHookPayload,
  selfBaseUrl: string,
  vaultRoot: string | null = null
): Promise<string> {
  const startedAt = Date.now();
  // #1674: the budget's remainder runs on a monotonic clock; startedAt stays the telemetry stamp.
  const startedMono = performance.now();
  const call = writeCall(payload);
  if (!call) return "{}";
  const { toolName, toolInput, filePath } = call;

  // The size and location notes are convention enforcement: always sent.
  const fixedNotes = await fixedWriteNotes(payload, call, vaultRoot, startedAt);

  const excerpt = extractContentExcerpt(toolName, toolInput);
  const topics = detectTopics({ tool_name: toolName, file_path: filePath, content_excerpt: excerpt });
  const cwd = payload.cwd ?? process.cwd();
  // §20.5: geratene Erkennung = kein Projekt. Der Filter hatte diese Regel als
  // erste Lane (`projectForFilter`), Query und Anzeige nicht — die schickten
  // den geratenen Namen weiter als `project` an /hook/recall und druckten ihn
  // als `project=` in den Hint-Block.
  const project = projectForLane(cwd);
  // Beide Namen kommen aus derselben Konfidenz-Regel, unterscheiden sich aber
  // in der Projektion: `key` (kanonisch) zum Vergleichen, `raw` zum Anzeigen.
  const filterProject = projectForFilter(cwd);
  const remainingMs = Math.max(50, HOOK_TIMEOUT_MS - (performance.now() - startedMono));

  const recall = await recallForWrite(
    selfBaseUrl,
    payload,
    { query: topics.query, topics: topics.topics, project, toolName, excerpt },
    remainingMs
  );
  const resp = recall.resp;
  const scopeFilter = filterWriteHits(resp, filterProject);

  // Per-session dedup (#32). Best-effort throughout — no error in this
  // section ever blocks the response.
  const sessionId = payload.session_id ?? "";
  const dedupActive = sessionId !== "";
  // #539: read-only on purpose — a lane's snapshot decides, it never books.
  const sessionState: ReadonlySessionState = dedupActive ? await loadSessionState(sessionId) : { shown: {} };
  // #539: this lane's own bookkeeping, queued as deltas instead of written
  // back from the snapshot — replayed under the session lock at the end.
  const stateDeltas: StateDelta[] = [];

  const code = await collectCodeNotes(toolName, toolInput, filePath, cwd, sessionState, stateDeltas);
  const { survivingHits, droppedDedupCount } = await dedupWriteHits(scopeFilter.hits, sessionState, dedupActive);
  const shown = presentWriteHits(survivingHits, resp, sessionState, { first: code.targets[0], filePath, cwd });
  const totalHints = shown.requiredHits.length + shown.optionalHits.length;
  const backoff =
    dedupActive && totalHints > 0
      ? await writeBackoff(sessionState, shown)
      : { streak: 0, suppress: false, consumed: false };

  const answer = composeWriteAnswer({
    fixedNotes,
    hintsBlock: writeHintsBlock(shown, resp, project, hookClient(payload)),
    shown,
    suppressed: backoff.suppress,
    backoffConsumed: backoff.consumed,
    code,
    sessionId: payload.session_id ?? null,
    stateDeltas,
  });

  await persistWriteState(sessionId, backoff.suppress, shown, stateDeltas);

  // #458 (shadow): den fertigen Block ans Sitzungsbudget anrechnen und den
  // Governor-Entscheid loggen — nichts wird gekürzt.
  recordBudgetShadow(sessionId || null, "hook_call", answer.hintTokensEst);
  await writeTelemetry(
    writeLaneRow({
      payload,
      call,
      selfBaseUrl,
      startedAt,
      topics,
      cwd,
      recall,
      scopeFilter,
      droppedDedupCount,
      shown,
      backoff,
      answer,
      targets: code.targets,
    })
  );
  // Usage sidecar (#154): only what was ACTUALLY injected counts as surfaced.
  await reportHinted(selfBaseUrl, answer.hintedIds, payload.session_id ?? null);

  return answer.stdout;
}

/**
 * Deterministischer Dateigrößen-Check (Daniel 19.07.2026): die
 * Größen-Konvention darf nicht am Memory-Abruf hängen — der Hook hält
 * dem Agenten die Zeilenzahl bei jedem Write/Edit hin. Läuft VOR dem
 * Recall-Call und wird in JEDEM Emit-Pfad mitgesendet. Same-machine
 * assumption is safe: daemon and hook share the filesystem by definition
 * of a loopback-only endpoint.
 * #1538: bounded by a quarter of the lane budget, so a slow disk or a busy
 * daemon cannot spend the recall's time on it; past it the note is skipped.
 *
 * #297: memory-shaped .md outside the vault root — same discipline as the
 * size note: deterministic, rides through suppression, fail-open. The two
 * combine into one deterministic block for every emit path.
 */
async function fixedWriteNotes(
  payload: WriteHookPayload,
  call: { toolInput: Record<string, unknown>; filePath: string },
  vaultRoot: string | null,
  startedAt: number
): Promise<string[]> {
  const sizeNote = await fileSizeNote(call.filePath, undefined, payload.cwd, startedAt + HOOK_TIMEOUT_MS / 4).catch(
    () => null
  );
  const locationNote = await memoryLocationNote(call.filePath, call.toolInput, vaultRoot).catch(() => null);
  return [sizeNote, locationNote].filter((n): n is string => n !== null);
}

/** The lane's `hook_call` row. */
function writeLaneRow(r: {
  payload: WriteHookPayload;
  call: { toolName: string; filePath: string };
  selfBaseUrl: string;
  startedAt: number;
  topics: { query: string; topics: string[] };
  cwd: string;
  recall: WriteRecall;
  scopeFilter: ReturnType<typeof filterWriteHits>;
  droppedDedupCount: number;
  shown: WritePresentation;
  backoff: { streak: number; suppress: boolean };
  answer: WriteAnswer;
  targets: string[];
}): Parameters<typeof writeTelemetry>[0] {
  const { resp } = r.recall;
  const { scopeFilter, shown, backoff, answer } = r;
  const totalHints = shown.requiredHits.length + shown.optionalHits.length;
  return {
    session_id: r.payload.session_id || null,
    // #507 Nachbesserung: nur für die Telemetrie-Dimension — `hookClient` bleibt
    // der surface-Default fürs Hint-Block-Attribut und den Recall-Loopback.
    client: hookClientEvidence(r.payload),
    agent: hookAgent(r.payload),
    tool_name: r.call.toolName,
    file_path: r.call.filePath,
    topics: r.topics.topics,
    query_chars: r.topics.query.length,
    daemon_url: r.selfBaseUrl,
    daemon_reachable: resp !== null,
    hint_count: backoff.suppress ? 0 : totalHints,
    required_count: backoff.suppress ? 0 : shown.requiredHits.length,
    top_score: resp?.hits?.[0]?.score ?? null,
    latency_ms_total: Date.now() - r.startedAt,
    dropped_dedup_count: r.droppedDedupCount,
    dropped_scope_count: scopeFilter.droppedCount,
    project_confidence: projectConfidence(r.cwd),
    filter_project: scopeFilter.filterProject,
    ...(scopeFilter.skipped ? { scope_filter_skipped: scopeFilter.skipped } : {}),
    ...(scopeFilter.droppedScopes.length > 0 ? { dropped_scopes: scopeFilter.droppedScopes } : {}),
    hint_tokens_est: answer.hintTokensEst,
    ...codeTelemetry(answer, r.targets),
    hinted_ids: answer.hintedIds,
    hinted_types: answer.hintedTypes,
    backoff_streak: backoff.streak,
    suppressed: backoff.suppress,
    suppressed_tokens_est: answer.suppressedTokensEst,
    pretool_shape: shown.legacyShape ? "legacy" : "compact",
    ...(shown.hintReason !== null ? { hint_reason: shown.hintReason } : {}),
    status: writeStatus(r.recall, shown, backoff.suppress),
    error: r.recall.errMsg,
  };
}

/** A transport failure keeps its status; an answer with nothing to present is
 *  `no-hits`; a suppressed one `suppressed`. */
function writeStatus(recall: WriteRecall, shown: WritePresentation, suppressed: boolean): HookStatus {
  if (suppressed) return "suppressed";
  const totalHints = shown.requiredHits.length + shown.optionalHits.length;
  if (recall.resp && totalHints === 0 && shown.hintReason === null) return "no-hits";
  return recall.status;
}

interface WriteAnswer {
  stdout: string;
  hintTokensEst: number;
  suppressedTokensEst: number;
  hintedIds: string[];
  hintedTypes: string[];
  codeNotes: ImpactNote[];
  memoryCodeNotes: AppliesToNote[];
  budgetDropped: number;
}

const envelope = (context: string): string =>
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: context,
    },
  });

/**
 * Build the stdout document. hint_tokens_est (#72): ~4 chars/token of the
 * actually injected block — the cost side of net-context ROI.
 */
function composeWriteAnswer(args: {
  fixedNotes: string[];
  hintsBlock: string | null;
  shown: WritePresentation;
  suppressed: boolean;
  backoffConsumed: boolean;
  code: WriteCodeNotes;
  sessionId: string | null;
  stateDeltas: StateDelta[];
}): WriteAnswer {
  const { fixedNotes, hintsBlock, suppressed, code, stateDeltas } = args;
  // #1460: the code-impact and applies-to blocks fill what the budget leaves
  // next to the fixed notes and the delivered hints; one that does not fit is
  // left out whole, never cut.
  const sent = [...fixedNotes, ...(hintsBlock !== null && !suppressed ? [hintsBlock] : [])];
  const fitted = fitOptional(
    Math.max(0, sent.reduce((n, t) => n + t.length + 1, 0) - 1),
    [...code.candidateCodeNotes, ...code.candidateMemoryCodeNotes],
    (n) => n.note.length,
    PRE_TOOL_CONTEXT_CHAR_BUDGET
  );
  const keptNotes = new Set<ImpactNote | AppliesToNote>(fitted.kept);
  const codeNotes = code.candidateCodeNotes.filter((n) => keptNotes.has(n));
  const memoryCodeNotes = code.candidateMemoryCodeNotes.filter((n) => keptNotes.has(n));
  logImpactBlocks(args.sessionId, code.perTarget, keptNotes);
  for (const n of fitted.kept) {
    const key = n.dedupeKey;
    stateDeltas.push((s) => bumpShown(s, key, Date.now()));
  }
  const detNote =
    [...fixedNotes, ...codeNotes.map((n) => n.note), ...memoryCodeNotes.map((n) => n.note)].join("\n") || null;
  const base = { codeNotes, memoryCodeNotes, budgetDropped: fitted.dropped };
  // Without hints, and under suppression, only the deterministic notes go
  // out: suppression is a recall-noise valve, the size and #297 location
  // notes are convention enforcement and ride through it.
  const notesOnly = {
    stdout: detNote ? envelope(detNote) : "{}",
    hintTokensEst: detNote ? Math.ceil(detNote.length / 4) : 0,
    hintedIds: [],
    hintedTypes: [],
  };
  if (hintsBlock === null) return { ...base, ...notesOnly, suppressedTokensEst: 0 };
  if (suppressed) {
    stateDeltas.push((s) => recordSourceSuppressed(s, BACKOFF_SOURCE));
    return { ...base, ...notesOnly, suppressedTokensEst: Math.ceil(hintsBlock.length / 4) };
  }
  const block = detNote ? `${detNote}\n${hintsBlock}` : hintsBlock;
  const delivered = [...args.shown.requiredHits, ...args.shown.optionalHits];
  const hintedIds = delivered.map((h) => h.id);
  stateDeltas.push((s) => recordSourceEmit(s, BACKOFF_SOURCE, hintedIds, args.backoffConsumed));
  return {
    ...base,
    stdout: envelope(block),
    hintTokensEst: Math.ceil(block.length / 4),
    suppressedTokensEst: 0,
    hintedIds,
    hintedTypes: delivered.map((h) => h.type),
  };
}

/**
 * Bump shown-counts for everything we surfaced, then persist. When
 * suppressed nothing was shown — only the backoff counter changed.
 *
 * #539: replay the deltas against the state as it is on disk now — the
 * snapshot the lane decided on is minutes of recall old and four other lanes
 * may have written since.
 *
 * The replay hangs on "are there deltas", not on `survivingHits`. Those two
 * agreed only because requiredHits/optionalHits are derived from
 * survivingHits, so `totalHints > 0` implied `survivingHits > 0` — an
 * unwritten coupling, and unwritten couplings are exactly what #539 broke.
 * The suppressed-counter delta now survives a change to that derivation.
 *
 * Without a session id there is no state to write, and no cleanup either.
 */
async function persistWriteState(
  sessionId: string,
  suppressed: boolean,
  shown: WritePresentation,
  stateDeltas: StateDelta[]
): Promise<void> {
  if (sessionId === "") return;
  if (!suppressed) bookPresented(shown, stateDeltas);
  if (stateDeltas.length > 0) {
    await mutateSessionState(sessionId, (s) => {
      for (const d of stateDeltas) d(s);
    });
  }
  // Opportunistic cleanup of stale session files — fire-and-forget.
  void cleanupOldStates().catch(() => {});
}

/** Shown-counts for every presented hit, and #621's area: it is opened by
 *  its first delivered hint, not by its first edit — an area whose first
 *  edits found nothing keeps its first touch. */
function bookPresented(shown: WritePresentation, stateDeltas: StateDelta[]): void {
  if (shown.presentedHits.length === 0) return;
  const now = Date.now();
  for (const h of shown.presentedHits) stateDeltas.push((s) => bumpShown(s, h.id, now));
  const area = shown.areaKey;
  if (shown.hintReason === "first-touch" && area !== null) stateDeltas.push((s) => bumpShown(s, area, now));
}

/** #579: die Kostenseite der Code-Awareness, getrennt von den Memory-Hints.
 *  Ohne diese Felder ist in der Telemetrie nicht unterscheidbar, ob ein
 *  teurer Hook-Aufruf Memories oder Code-Kontext geliefert hat. */
function codeTelemetry(answer: WriteAnswer, targets: string[]) {
  const { codeNotes, memoryCodeNotes } = answer;
  return {
    ...(codeNotes.length > 0
      ? {
          code_block_tokens_est: codeNotes.reduce((n, c) => n + c.tokensEst, 0),
          // #606: candidate FILES of the symbol-level answer, where this used
          // to be the dependents of the whole file. The field keeps its name
          // so the ROI series stays one series across the change — what it
          // counts is still "files this block named as possibly breaking".
          code_dependents: codeNotes.reduce((n, c) => n + c.files, 0),
          code_stale: codeNotes.some((c) => c.stale),
          code_listed: codeNotes.flatMap((c) => c.listed),
          // #606: how sharp each block was. Without it a drop in reach cannot
          // be told from a repository whose edits all land outside every symbol.
          code_basis: codeNotes.map((c) => c.basis),
        }
      : {}),
    code_targets: targets,
    ...(answer.budgetDropped > 0 ? { budget_dropped_count: answer.budgetDropped } : {}),
    ...(memoryCodeNotes.length > 0
      ? {
          applies_to_tokens_est: memoryCodeNotes.reduce((n, c) => n + Math.ceil(c.note.length / 4), 0),
          applies_to_count: memoryCodeNotes.reduce((n, c) => n + c.candidates.length, 0),
        }
      : {}),
  };
}
