/**
 * The decisions the gate lane takes inside its locked session-state mutation
 * (split out of `gate()`'s `mutateSessionState` callback, #1525). Each step
 * reads and changes the state it is handed and reports what it claimed; the
 * lane still runs them inside ONE locked mutation, in this order, so the
 * persisted state is exactly what the single callback wrote.
 */
import { actionRulebookScope } from "./rulebook-check.js";
import type { ReflexMatch } from "./reflex.js";
import type { indexedConventionSource } from "./convention-source.js";
import {
  recordActiveConventions,
  type ActiveConvention,
  type PendingMustLoad,
  type SessionState,
} from "./session-state.js";
import { RULE_KERNEL_TOOL_CALLS } from "./rule-kernel.js";

export const DENIED_REFLEX_CAP = 200;
export const KERNEL_DELIVERY = "rule-kernel-delivery";
export const KERNEL_RETRY_AT = "rule-kernel-retry-at";

/** Tool-specific rules delivered to this subagent, independent of its parent hints. */
export interface ActionMustLoad {
  ids: readonly string[];
  key: string;
  summaries?: ReadonlyMap<string, string>;
  origins?: ReadonlyMap<string, string | undefined>;
  revisions?: ReadonlyMap<string, string | null>;
  onClaim?: (ids: readonly string[]) => void;
}

interface KernelDelivery {
  token?: string;
  calls?: number;
  deadline: number;
}

/** Count this tool call and expire a kernel delivery reservation whose
 *  deadline passed: its calls go back on the counter. Returns the delivery
 *  still in flight, if any. */
export function countAndExpireDelivery(state: SessionState, countTool: boolean): KernelDelivery | null {
  if (countTool) state.toolCalls = (state.toolCalls ?? 0) + 1;
  let delivery: KernelDelivery | null | undefined;
  try {
    delivery = JSON.parse(state.constants?.[KERNEL_DELIVERY] ?? "null");
  } catch {
    /* invalid marker */
  }
  if (delivery && Date.now() >= delivery.deadline) {
    delete state.constants![KERNEL_DELIVERY];
    state.toolCalls = (state.toolCalls ?? 0) + (delivery.calls ?? RULE_KERNEL_TOOL_CALLS);
    delivery = null;
  }
  return delivery ?? null;
}

/** The pending must-load ids this call claims — none for a subagent, which
 *  never saw the main thread's hint block. Claiming removes them. */
export function claimPendingMustLoad(state: SessionState, subagent: boolean): PendingMustLoad[] | null {
  if (subagent || state.pendingMustLoad === undefined || state.pendingMustLoad.length === 0) return null;
  const claimed = state.pendingMustLoad;
  delete state.pendingMustLoad;
  return claimed;
}

export interface ActionClaimInput {
  action: ActionMustLoad;
  requiredActionIds: readonly string[];
  actionScope: string;
  rulebookDenied: boolean;
  /** This call's must-load claims; action ids are appended when C denied. */
  claimedMustLoad: PendingMustLoad[];
  token: string;
  deadline: number;
}

/**
 * Reserve the concrete action rules this call delivers. A new rulebook scope
 * starts a fresh history; a changed revision or an abandoned reservation
 * makes an id deliverable again. Returns the ids reserved now and those that
 * are new must-load claims.
 */
export function claimActionRules(state: SessionState, c: ActionClaimInput): { ids: string[]; newClaims: string[] } {
  const { action } = c;
  if (state.constants?.[`${action.key}:scope`] !== c.actionScope) resetActionScope(state, action, c.actionScope);
  const seen = liveActionHistory(state, action);
  // C has already resolved actual full loads and accepted exceptions for
  // this actor/revision. Applicability alone never answers an action rule.
  const pending = new Set(c.requiredActionIds);
  const ids = action.ids.filter((id) => pending.has(id) && !seen.has(id)).slice(0, 20);
  const newClaims = c.rulebookDenied
    ? ids.filter((id) => !state.claimedMustLoad?.includes(id) && !c.claimedMustLoad.some((e) => e.id === id))
    : [];
  const alreadyClaimed = new Set(c.claimedMustLoad.map((e) => e.id));
  for (const id of ids) {
    seen.add(id);
    if (c.rulebookDenied && !alreadyClaimed.has(id)) c.claimedMustLoad.push({ id, block: action.key, at: Date.now() });
  }
  if (ids.length) {
    (state.constants ??= {})[action.key] = JSON.stringify([...seen].slice(-200));
    for (const old of [...seen].slice(0, -200)) delete state.constants[`${action.key}:attempt:${old}`];
    for (const id of ids)
      state.constants[`${action.key}:attempt:${id}`] = JSON.stringify({
        token: c.token,
        deadline: c.deadline,
        delivered: false,
        revision: action.revisions?.get(id) ?? null,
        newClaim: newClaims.includes(id),
      });
  }
  action.onClaim?.(ids);
  return { ids, newClaims };
}

/** A new rulebook scope: drop every reservation of the old one (and the
 *  must-load claims they created) and start an empty history. */
function resetActionScope(state: SessionState, action: ActionMustLoad, actionScope: string): void {
  const prefix = `${action.key}:attempt:`;
  for (const key of Object.keys(state.constants ?? {}))
    if (key.startsWith(prefix)) {
      try {
        if (JSON.parse(state.constants![key]).newClaim)
          state.claimedMustLoad = state.claimedMustLoad?.filter((id) => id !== key.slice(prefix.length));
      } catch {}
      delete state.constants![key];
    }
  (state.constants ??= {})[action.key] = "[]";
  state.constants[`${action.key}:revisions`] = "{}";
  state.constants[`${action.key}:scope`] = actionScope;
}

/** The ids already delivered in this scope, minus those whose revision
 *  changed and those whose reservation was abandoned. */
function liveActionHistory(state: SessionState, action: ActionMustLoad): Set<string> {
  const seen = new Set<string>(JSON.parse(state.constants?.[action.key] ?? "[]"));
  dropChangedRevisions(state, action, seen);
  dropAbandonedAttempts(state, action, seen);
  return seen;
}

/** A delivered id whose rule changed revision since is deliverable again. */
function dropChangedRevisions(state: SessionState, action: ActionMustLoad, seen: Set<string>): void {
  const revisions = JSON.parse(state.constants?.[`${action.key}:revisions`] ?? "{}");
  for (const id of seen)
    if (Object.hasOwn(revisions, id) && action.revisions?.has(id) && revisions[id] !== action.revisions.get(id)) {
      seen.delete(id);
      delete revisions[id];
    }
  if (state.constants?.[`${action.key}:revisions`])
    state.constants[`${action.key}:revisions`] = JSON.stringify(revisions);
}

/** A process crash or dropped response leaves a reservation, not a spent
 *  delivery: an expired undelivered or outdated reservation is released. */
function dropAbandonedAttempts(state: SessionState, action: ActionMustLoad, seen: Set<string>): void {
  for (const id of seen) {
    const key = `${action.key}:attempt:${id}`,
      raw = state.constants?.[key];
    if (!raw) continue;
    try {
      const marker = JSON.parse(raw);
      if (
        (!marker.delivered && Date.now() >= marker.deadline) ||
        (action.revisions?.has(id) && marker.revision !== action.revisions.get(id))
      ) {
        seen.delete(id);
        delete state.constants![key];
        if (marker.newClaim) state.claimedMustLoad = state.claimedMustLoad?.filter((value) => value !== id);
      }
    } catch {
      /* legacy marker */
    }
  }
}

/** The delivered reflex rules not yet denied in this session; each claimed
 *  one is denied once and in force from here on, at its revision (#1305). */
export function claimReflex(
  state: SessionState,
  candidates: readonly ReflexMatch[],
  revisions: ReadonlyMap<string, ReturnType<typeof indexedConventionSource>>
): ReflexMatch[] {
  if (candidates.length === 0) return [];
  const denied = new Set(state.deniedReflex ?? []);
  const claimed = candidates.filter((m) => !denied.has(m.memory.fm.id));
  if (claimed.length > 0) {
    for (const m of claimed) denied.add(m.memory.fm.id);
    state.deniedReflex = [...denied].slice(-DENIED_REFLEX_CAP);
    recordActiveConventions(
      state,
      claimed.map((m) => ({
        id: m.memory.fm.id,
        ...(revisions.get(m.memory.fm.id) ?? { revision: null }),
      }))
    );
  }
  return claimed;
}

/**
 * Reserve the rule kernel's re-delivery when it is due: nothing else is said
 * in this call (a deny or action context carries its own message; the kernel
 * waits), no delivery is in flight, the retry pause is over and enough tool
 * calls have passed. Returns the active conventions to deliver, or null.
 */
export function reserveKernel(
  state: SessionState,
  quiet: boolean,
  delivery: KernelDelivery | null,
  token: string,
  deadline: number
): ActiveConvention[] | null {
  if (
    !quiet ||
    delivery ||
    Date.now() < Number(state.constants?.[KERNEL_RETRY_AT] ?? 0) ||
    (state.toolCalls ?? 0) < RULE_KERNEL_TOOL_CALLS
  )
    return null;
  const active = [...(state.activeConventions ?? [])];
  const calls = state.toolCalls ?? 0;
  state.toolCalls = 0;
  (state.constants ??= {})[KERNEL_DELIVERY] = JSON.stringify({ token, calls, deadline });
  delete state.constants[KERNEL_RETRY_AT];
  return active;
}

/** Whether this call's action rules may be claimed: the rulebook named
 *  them for the scope the state is in, and the budget is not spent. */
export function actionClaimable(
  state: SessionState,
  action: ActionMustLoad | undefined,
  requiredActionIds: readonly string[],
  actionScope: string,
  expired: boolean
): action is ActionMustLoad {
  return !!action && requiredActionIds.length > 0 && actionScope === actionRulebookScope(state) && !expired;
}
