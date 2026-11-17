/**
 * Write/Edit lane — the code-graph step (split out of `runWriteLane`, #1525):
 * which files the call targets, the change-impact and applies-to blocks for
 * them, and the touched-file bookings the Stop lane reads at the task
 * boundary. The blocks are candidates only; which of them fit the pre-tool
 * budget is decided by the lane once the recall hints are known.
 */
import { isAbsolute, resolve } from "node:path";
import { impactNote, type ImpactNote, type ImpactResult } from "./code-graph/impact-block.js";
import { appliesToNote, type AppliesToNote } from "./code-graph/applies-to-note.js";
import { laneRepoRoot } from "./code-graph/git-paths.js";
import { codeGraphCache, repoRelative } from "./code-graph/dependents-block.js";
import { logDeliveredBlock } from "./code-delivered-telemetry.js";
import { recordTouched, type ReadonlySessionState, type SessionState } from "./session-state.js";

export interface TargetNotes {
  repoRoot: string;
  impact: ImpactResult;
  applies: AppliesToNote | null;
}

export interface WriteCodeNotes {
  targets: string[];
  perTarget: TargetNotes[];
  candidateCodeNotes: ImpactNote[];
  candidateMemoryCodeNotes: AppliesToNote[];
}

/**
 * #577/#606: the code-graph change-impact block. It joins the other two
 * deterministic notes but is computed here, because it needs the session
 * snapshot for its own dedupe — the same rule as the memory hints (§16.2),
 * so the same answer is not repeated on every edit. Silent on a cold or
 * missing graph (see impact-block.ts), and it never marks a memory
 * required (§13.1).
 * #606: the query is no longer the FILE's dependents but the dependents of
 * the SYMBOLS this very call changes, derived from the tool input. Same
 * lane, same silence rules, a measurably sharper answer — and it is the
 * answer `find_affected_files` gives, delivered rather than offered, because
 * v3 measured the tool being called 0 times in 44 of 44 runs.
 * The FILE decides the repository, not the working directory: an edit from
 * a subdirectory would otherwise miss the graph entirely (#577). Falls back
 * to `cwd`, so nothing that worked before stops working.
 * #578: memories that declare this file via `affects_files`, plus memories
 * on files that depend on it. A deterministic block of its own rather than
 * recall hits, because these candidates carry no score — the reasoning, and
 * the fact that it is a reversible assumption, is in applies-to-note.ts.
 * Same dedupe rule, same silence on anything missing.
 * #584: every target of the call, as an absolute path. Codex' apply_patch
 * names repo-relative paths, often several; both blocks need an absolute
 * one, so before this they were silent on every Codex patch.
 * In target order, whichever finishes first: the blocks read top-down.
 *
 * The touched-file bookings go into `stateDeltas` (#539: replayed under the
 * session lock at the end of the lane).
 */
export async function collectCodeNotes(
  toolName: string,
  toolInput: Record<string, unknown>,
  filePath: string,
  cwd: string,
  sessionState: ReadonlySessionState,
  stateDeltas: Array<(s: SessionState) => void>
): Promise<WriteCodeNotes> {
  const targets = codeTargets(toolInput, filePath, cwd);
  const perTarget = await Promise.all(
    targets.map(async (target): Promise<TargetNotes> => {
      const repoRoot = laneRepoRoot(target, cwd);
      const [impact, applies] = await Promise.all([
        impactNote({
          filePath: target,
          repoRoot,
          toolName,
          toolInput,
          session: sessionState,
        }).catch((): ImpactResult => ({ note: null, dedupeHit: false })),
        appliesToNote({ filePath: target, repoRoot, session: sessionState }).catch(() => null),
      ]);
      return { repoRoot, impact, applies };
    })
  );
  // #1460: candidates only — which of them fit the pre-tool budget is decided
  // once the recall hints are known; only those are logged and booked.
  const candidateCodeNotes = perTarget.map((t) => t.impact.note).filter((n): n is ImpactNote => n !== null);
  const candidateMemoryCodeNotes = perTarget.map((t) => t.applies).filter((n): n is AppliesToNote => n !== null);
  bookTouched(perTarget, targets, sessionState, stateDeltas);
  // Targets past MAX_CODE_TARGETS get no impact block (#584's cap), but they
  // are written all the same. Booked unplaced, so the boundary neither loses
  // them nor counts their dependents as forgotten files.
  for (const target of uncappedTargets(toolInput, filePath, cwd).slice(targets.length)) {
    const repoRoot = laneRepoRoot(target, cwd);
    const rel = repoRelative(repoRoot, target);
    if (rel === null || !codeGraphCache().allows(repoRoot)) continue;
    stateDeltas.push((s) => recordTouched(s, repoRoot, rel, null));
  }
  return { targets, perTarget, candidateCodeNotes, candidateMemoryCodeNotes };
}

/**
 * #572: book what this call is about to write, block or no block. The
 * per-edit answer dedupes by design, so the session-wide union can only come
 * from an accumulator — the Stop lane reads it at the task boundary. Booked
 * WITH the dependents of this moment: the watcher reindexes after the edit,
 * and the next graph no longer knows who called a symbol this edit removed.
 */
function bookTouched(
  perTarget: readonly TargetNotes[],
  targets: readonly string[],
  sessionState: ReadonlySessionState,
  stateDeltas: Array<(s: SessionState) => void>
): void {
  perTarget.forEach((t, i) => {
    const repoRoot = t.repoRoot;
    const booking = t.impact.booking;
    if (booking === undefined) {
      // The impact module never reached the file — a tool it cannot read a
      // change out of, or it threw. The write happens anyway, so it is booked
      // unplaced rather than not at all. (NotebookEdit used to be the example
      // here, and it was the wrong one: it names its target `notebook_path`,
      // so the lane returned before this line ever ran. `hook-write-input.ts`
      // normalizes it now.)
      const rel = repoRelative(repoRoot, targets[i]!);
      if (rel !== null && codeGraphCache().allows(repoRoot)) {
        stateDeltas.push((s) => recordTouched(s, repoRoot, rel, null));
      }
      return;
    }
    // A dedupe hit books no hits on the claim that the delivery it repeats
    // already booked them. That holds only if this session HAS such an entry;
    // a `shown` counter without one (state written before #572) proves
    // nothing, and the edit is booked as one the lane could not look at.
    const vouched = sessionState.touched?.get(repoRoot)?.get(booking.file) !== undefined;
    const hits = t.impact.dedupeHit && !vouched ? null : booking.hits;
    stateDeltas.push((s) => recordTouched(s, repoRoot, booking.file, hits, booking.truncated));
  });
}

/**
 * #606: one `code_tool_call` row per delivered block, and one per dedupe hit —
 * the two silences that are worth telling apart. #1460: a block the budget
 * left out was not delivered and gets no row. Fire-and-forget: the row is the
 * measurement, not part of the answer.
 */
export function logImpactBlocks(
  sessionId: string | null,
  perTarget: readonly { repoRoot: string; impact: ImpactResult }[],
  delivered: ReadonlySet<ImpactNote | AppliesToNote>
): void {
  for (const t of perTarget) {
    const note = t.impact.note !== null && delivered.has(t.impact.note) ? t.impact.note : null;
    if (note === null && !t.impact.dedupeHit) continue;
    void logDeliveredBlock({
      sessionId,
      lane: "write",
      repo: t.repoRoot,
      dedupeHit: t.impact.dedupeHit,
      ...(note !== null
        ? {
            basis: note.basis,
            files: note.files,
            truncated: note.truncated,
            tokensEst: note.tokensEst,
            tookMs: note.tookMs,
          }
        : {}),
    });
  }
}

/**
 * Most targets of one call that get code blocks. A Codex patch can touch a
 * dozen files; two blocks each for all of them would bury the edit under
 * context nobody asked for, so the first few are covered and the rest are not.
 */
export const MAX_CODE_TARGETS = 4;

/**
 * The files a Write/Edit/apply_patch call targets, absolute and de-duplicated
 * (#584). Relative paths — Codex' apply_patch writes them — are resolved
 * against the session's `cwd`, which is what they are relative to.
 */
export function codeTargets(toolInput: Record<string, unknown>, filePath: string, cwd: string): string[] {
  return uncappedTargets(toolInput, filePath, cwd).slice(0, MAX_CODE_TARGETS);
}

/** Every target of the call, in order. `codeTargets` is its first four. */
function uncappedTargets(toolInput: Record<string, unknown>, filePath: string, cwd: string): string[] {
  const listed = Array.isArray(toolInput.file_paths)
    ? toolInput.file_paths.filter((p): p is string => typeof p === "string" && p.length > 0)
    : [];
  const all = listed.length > 0 ? listed : [filePath];
  const seen = new Set<string>();
  for (const p of all) {
    seen.add(isAbsolute(p) ? p : resolve(cwd, p));
  }
  return [...seen];
}
