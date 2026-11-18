/**
 * #1322: the gate and task bookkeeping inside the session state — must-load
 * claims (#1303), conventions in force (#1305), the task generation (#1306)
 * and the release of claims by a successful load (#1301).
 */
import { listHookStates } from "../hook-state-database.js";
import { taskIdFor } from "../task-state.js";
import { sessionStateDir } from "./location.js";
import { loadSessionState, mutateSessionState } from "./store.js";
import type { ConventionValidator, SessionState } from "./types.js";

/** #1303: bound on waiting must-load ids — a hint block carries at most a handful. */
const PENDING_MUST_LOAD_CAP = 20;

/**
 * #1303: book must-load ids shown in hint block `block` (mutates in place).
 * An id already waiting keeps its first entry, so one hint is never claimed
 * twice for being shown twice.
 */
export function bookPendingMustLoad(
  state: SessionState,
  ids: readonly string[],
  block: string,
  now: number = Date.now(),
  revisions?: ReadonlyMap<string, string | null>
): void {
  if (ids.length === 0) return;
  // Full loads survive ordinary turns, but clearShown removes them on context loss.
  // Missing revisions cannot prove that the shown rule is the loaded source.
  const loaded = new Map((state.loadedConventions ?? []).map((e) => [e.id, e.revision]));
  const satisfied = (id: string) => typeof revisions?.get(id) === "string" && loaded.get(id) === revisions.get(id);
  const pending = (state.pendingMustLoad ?? []).filter((e) => !satisfied(e.id));
  const waiting = new Set(pending.map((e) => e.id));
  for (const id of ids) {
    if (waiting.has(id) || satisfied(id)) continue;
    waiting.add(id);
    pending.push({ id, block, at: now });
  }
  state.pendingMustLoad = pending.slice(-PENDING_MUST_LOAD_CAP);
}

/** #1305: bound on the conventions one session keeps in force. */
export const ACTIVE_CONVENTIONS_CAP = 20;
/** #1305: bound on denied must-load ids still waiting for their load. */
const CLAIMED_MUST_LOAD_CAP = 20;

/** #1305: put conventions in force (mutates in place). A convention set again
 *  moves to the newest position with its current revision. #1306: it keeps
 *  its original scope — a session-wide rule does
 *  not become task-bound because a task named it too. Validator metadata is
 *  replaced authoritatively; omission removes an earlier declaration. */
export function recordActiveConventions(
  state: SessionState,
  set: ReadonlyArray<{ id: string; revision: string | null; scope?: "task"; validator?: ConventionValidator }>,
  now: number = Date.now()
): void {
  if (set.length === 0) return;
  const before = new Map((state.activeConventions ?? []).map((e) => [e.id, e]));
  const ids = new Set(set.map((e) => e.id));
  const kept = (state.activeConventions ?? []).filter((e) => !ids.has(e.id));
  for (const e of set) {
    const old = before.get(e.id);
    const scope = old ? old.scope : e.scope;
    kept.push({
      id: e.id,
      revision: e.revision,
      setAt: now,
      ...(scope ? { scope } : {}),
      ...(e.validator ? { validator: e.validator } : {}),
    });
  }
  state.activeConventions = kept.slice(-ACTIVE_CONVENTIONS_CAP);
}

/**
 * #1306: compact, clear and fork start a new generation of the task state. The
 * task and its conventions survive (the rule kernel restores the bodies); an
 * pending correspondence context does not — it belongs to a context that is
 * gone. #1310: neither do receipts — they were validated in the old
 * generation. #1311: nor does the repair counter bound to them. Never throws.
 */
export async function bumpTaskGeneration(sessionId: string, now: number = Date.now()): Promise<void> {
  if (!sessionId) return;
  try {
    await mutateSessionState(sessionId, (state) => {
      const task = state.activeTask ?? { id: taskIdFor("none", now), kind: "none" as const, since: now, generation: 0 };
      state.activeTask = { ...task, generation: task.generation + 1 };
      delete state.correspondenceContext;
      delete state.receipts;
      delete state.repairAttempts;
      delete state.userValidatorChannel;
      delete state.activeTask.validatorChannel;
    });
  } catch {
    // A missed bump only leaves an old question answerable; it never blocks the start.
  }
}

/** #1305: remember the must-load ids a gate deny claimed (mutates in place). */
export function recordClaimedMustLoad(state: SessionState, ids: readonly string[]): void {
  if (ids.length === 0) return;
  const set = new Set(state.claimedMustLoad ?? []);
  for (const id of ids) {
    set.delete(id);
    set.add(id);
  }
  state.claimedMustLoad = [...set].slice(-CLAIMED_MUST_LOAD_CAP);
}

/** #1623: whether a kernel reservation marker belongs to a subagent. */
function subagentDelivery(marker: string | undefined): boolean {
  try {
    return typeof (JSON.parse(marker ?? "null") as { agent?: unknown } | null)?.agent === "string";
  } catch {
    return false;
  }
}

/** #1305: a user prompt starts a new count for the rule kernel's re-delivery.
 *  #1623: the main agent's count only — subagents keep theirs.
 *  One read when nothing is counted, never throws. */
export async function resetToolCalls(sessionId: string): Promise<void> {
  if (!sessionId) return;
  try {
    const current = await loadSessionState(sessionId);
    if (
      !current.toolCalls &&
      !current.constants?.["rule-kernel-delivery"] &&
      !current.constants?.["rule-kernel-retry-at"]
    )
      return;
    await mutateSessionState(sessionId, (state) => {
      delete state.toolCalls;
      if (state.constants) {
        // #1623: a subagent's reservation keeps its own count; the prompt reaches only the main agent.
        if (!subagentDelivery(state.constants["rule-kernel-delivery"])) delete state.constants["rule-kernel-delivery"];
        delete state.constants["rule-kernel-retry-at"];
      }
    });
  } catch {
    // A missed reset re-delivers the kernel early; it never blocks the prompt.
  }
}

/**
 * #1301/#1303: a successful `load_memory(id)` releases `id` in EVERY session
 * state that still holds it — the caller's session is not reliably known on
 * every transport. Fail-open by design: another session's load releases this
 * session's claim without proving this session read the body. Never throws.
 *
 * #1305: when the load answers a must-load — still pending, or already denied
 * for — and is a real load (`activate`, not a lean dismissal), the memory
 * becomes an active convention of that session with `revision`.
 */
export async function clearPendingMustLoad(
  memId: string,
  activate?: { revision: string | null; validator?: ConventionValidator },
  loadedSessionId?: string | null
): Promise<void> {
  if (!memId) return;
  try {
    if (activate && loadedSessionId)
      await mutateSessionState(loadedSessionId, (state) => {
        state.loadedConventions = [
          ...(state.loadedConventions ?? []).filter((c) => c.id !== memId),
          { id: memId, revision: activate.revision, loadedAt: Date.now() },
        ].slice(-200);
      });
    const dir = sessionStateDir();
    const needle = JSON.stringify(memId);
    for (const [sessionId, raw] of await listHookStates(dir)) {
      // Cheap pre-check before the lock: most sessions never held this id.
      if (!raw.includes(needle)) continue;
      await mutateSessionState(sessionId, (state) => {
        const pending = state.pendingMustLoad?.some((e) => e.id === memId) ?? false;
        const claimed = state.claimedMustLoad?.includes(memId) ?? false;
        if (pending) {
          const rest = state.pendingMustLoad!.filter((e) => e.id !== memId);
          if (rest.length > 0) state.pendingMustLoad = rest;
          else delete state.pendingMustLoad;
        }
        if (claimed) {
          const rest = state.claimedMustLoad!.filter((id) => id !== memId);
          if (rest.length > 0) state.claimedMustLoad = rest;
          else delete state.claimedMustLoad;
        }
        if ((pending || claimed || state.activeConventions?.some((c) => c.id === memId)) && activate)
          recordActiveConventions(state, [{ id: memId, ...activate }]);
      });
    }
  } catch {
    // Missing directory or an unreadable state: nothing to release.
  }
}
