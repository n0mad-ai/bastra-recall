import { requireActionRules, actionRulebookScope } from "./rulebook-check.js";
import { catalogFor, rulebookBoundary, type RulebookDenialReceipt, type CatalogProvider } from "./rulebook-check.js";
import { rulebookMutates, bastraReadTool } from "./rulebook-effects.js";
import { withRulebookDeadline, RULEBOOK_CATALOG_BUDGET_MS } from "./rulebook-catalog.js";
import { spoolRulebookFailure } from "./rulebook-spool.js";
import { confirmLaneDelivery } from "./lane-delivery.js";
/**
 * Gate lane (#1303/#1304): the catch-all PreToolUse hook, daemon-side.
 *
 * Two jobs, one state mutation per tool call:
 *
 *  · **must-load** — the prompt and session lanes book the ids of gated hints
 *    (`pendingMustLoad`, session-state.ts). The next tool call claims all of
 *    them and is denied ONCE with the ids and the load/dismiss instruction.
 *    The retry finds nothing pending and goes through, loaded or not.
 *  · **action-time reflex** — a user-directed reflex rule whose trigger matches
 *    the action itself (tool name, paths, query, Bash command) denies the call
 *    once per memory and session, carrying the rule's body.
 *
 * Fail-open, like every lane (docs/hooks.md): a deny goes out only after the
 * claim reached the disk. A failed state write, a missing session id or any
 * error answers `{}` and leaves a `non_conformance` row. The lane never reads
 * the vault on the hot path: must-load is state only, and the reflex pool is
 * cached per vault and dropped on the vault's change events.
 *
 * #1305 — **rule kernel re-delivery.** The lane counts tool calls since the last
 * user prompt (the prompt lane resets the count). At
 * {@link RULE_KERNEL_TOOL_CALLS} calls without a deny it answers the rule kernel
 * as `additionalContext` — never a deny — and starts the count again. A
 * must-load the agent answered with a load and a reflex rule the gate
 * delivered become the session's active conventions, which head the kernel.
 * #1461: an identical kernel directly delivered to the same agent in this
 * context can be replaced by a short reminder. HTTP finish settles the
 * cadence; the next due HTTP hook receives the full text.
 *
 * A denial is not a load and not a surfaced hint: this lane reports nothing to
 * /hook/hinted and writes no usage. A load the agent makes after a denial is an
 * ordinary load (#515: "used" is not "loaded"; a forced load is still a load).
 *
 * Claude Code runs matching PreToolUse hooks in parallel, and a `deny` wins
 * over the Bash lane's `allow` + `updatedInput` (precedence deny > defer > ask >
 * allow, code.claude.com/docs/en/hooks). The retry runs the rm shim again.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Memory, Vault } from "@bastra-recall/core";
import { stripAutoRelatedSection } from "@bastra-recall/core";
import { HINT_FRAME_NOTE, stripFenceMarkers } from "@bastra-recall/core/scrub";
import { indexedConventionSource } from "./convention-source.js";
import { envFirst, envInt, envOff } from "./env.js";
import { FAST_BUDGET_MS } from "./hook-budgets.js";
import { hookAgent, hookGateAvailable, hookClientEvidence } from "./hook-surface.js";
import { dimensionsFrom } from "./telemetry-dimensions.js";
import { defaultLogDir } from "./telemetry.js";
import { reflexConfig, reflexPool, type ReflexMatch } from "./reflex.js";
import {
  actionClaimable,
  claimActionRules,
  claimPendingMustLoad,
  claimReflex,
  countAndExpireDelivery,
  reserveKernel,
  returnKernelCalls,
  KERNEL_DELIVERY,
  KERNEL_RETRY_AT,
  type ActionMustLoad,
} from "./gate-lane-claims.js";
import {
  loadSessionState,
  mutateSessionState,
  recordClaimedMustLoad,
  type ActiveConvention,
  type PendingMustLoad,
} from "./session-state.js";
import { recordBudgetShadow } from "./session-budget.js";
import { projectForLane } from "./scope-filter.js";
import { renderKernelReminder, RULE_KERNEL_TOOL_CALLS, renderRuleKernel } from "./rule-kernel.js";
import { kernelSeen, kernelUnchanged, rememberKernel, type KernelSeen } from "./rule-kernel-seen.js";

import { actionReflexPool, matchActionReflex } from "./gate-lane-reflex.js";
export { actionContext, actionReflexPool, MAX_ACTION_CONTEXT_CHARS } from "./gate-lane-reflex.js";

const HOOK_TIMEOUT_MS = envInt("BASTRA_HOOK_TIMEOUT_MS", FAST_BUDGET_MS, "NEXUS_HOOK_TIMEOUT_MS");
const HOOK_VERSION = "0.1.0";
// C gets only part of the hook budget; legacy gates must remain independent.
const RULEBOOK_ACTION_BUDGET_MS = RULEBOOK_CATALOG_BUDGET_MS;

/** Body characters one deny may carry; past it a rule is named, not quoted. */
export const REFLEX_BODY_BUDGET_CHARS = 4000;

export interface GatePayload {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  agent_id?: string;
  bastra_client?: string;
  bastra_codex_version?: string;
}

export interface GateDeps {
  /** Absolute budget when a tool-specific lane performs the lookup first. */
  deadline?: number;
  /** A tool-specific inline gate must not double count the catch-all call. */
  countTool?: boolean;
  /** Tool-specific rules delivered to this subagent, independent of its parent hints. */
  actionMustLoad?: ActionMustLoad;
  /** The action-time reflex pool, already filtered (see actionReflexPool). */
  reflexPool: () => readonly Memory[];
  /** Testable advisory telemetry; failure must never alter gate delivery. */
  telemetry?: (fields: Record<string, unknown>) => Promise<void>;
  /** #1305: the rule kernel's candidates from the daemon's vault index.
   *  Absent = no re-delivery; the count still runs. */
  kernel?: CatalogProvider;
}

/** Recalled text stays reference-only; only owner-directed text is inlined. */
export function actionConventionFrame(
  ids: readonly string[],
  summaries?: ReadonlyMap<string, string>,
  origins?: ReadonlyMap<string, string | undefined>
) {
  const line = (s: string) =>
    stripFenceMarkers(s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " "))
      .replace(/\s+/gu, " ")
      .trim();
  const head = [
    '<recall-hints trigger="github-write">',
    HINT_FRAME_NOTE,
    "MUST-LOAD — load the applicable saved issue/PR conventions before deciding:",
  ];
  const rows: string[] = [];
  let used = head.join("\n").length;
  for (const id of ids) {
    const text = summaries?.get(id);
    const row =
      origins?.get(id) === "user-directed" && typeof text === "string"
        ? `- ${line(id)}: ${line(text).slice(0, 350)}`
        : `- ${line(id)}: load_memory(${JSON.stringify(line(id))})`;
    if (used + row.length > 7600) break;
    rows.push(row);
    used += row.length + 1;
  }
  return [
    ...head,
    ...rows,
    ...(rows.length < ids.length
      ? [
          `${ids.length - rows.length} further required IDs are not displayed here; read list_rules for the complete categorized catalog.`,
        ]
      : []),
    "</recall-hints>",
  ].join("\n");
}

/** Read/check tools always pass; Bastra writes participate in round checking. */
export function isGateExempt(toolName: string, input: Record<string, unknown>): boolean {
  if (bastraReadTool(toolName)) return true;
  return toolName === "ToolSearch" && typeof input.query === "string" && /bastra/i.test(input.query);
}

const poolCache = new WeakMap<Vault, Memory[]>();
const watched = new WeakSet<Vault>();

/** The daemon's cached pool: built once, rebuilt after any vault change. */
export function cachedActionReflexPool(vault: Vault): Memory[] {
  let pool = poolCache.get(vault);
  if (pool === undefined) {
    pool = actionReflexPool(reflexPool(vault));
    poolCache.set(vault, pool);
    if (!watched.has(vault)) {
      watched.add(vault);
      vault.on(() => poolCache.delete(vault));
    }
  }
  return pool;
}

type Outcome = "pass" | "deny";

/**
 * Run the gate; return the exact stdout document for the hook client.
 * Never throws — every failure answers `{}`.
 */
export async function runGateLane(payload: GatePayload, deps: GateDeps): Promise<string> {
  const startedAt = Date.now();
  let settleC: RulebookDenialReceipt | undefined;
  try {
    const output = await gate(payload, deps, startedAt, (settle) => {
      settleC = settle;
    });
    if (settleC) {
      const denied = JSON.parse(output).hookSpecificOutput?.permissionDecision === "deny";
      if (denied) await confirmLaneDelivery(settleC, Math.min(startedAt + HOOK_TIMEOUT_MS, deps.deadline ?? Infinity));
      else await settleC(false);
    }
    return output;
  } catch (err) {
    await settleC?.(false);
    await spoolRulebookFailure(payload.session_id ?? null);
    await writeTelemetry(payload, startedAt, {
      outcome: "pass",
      non_conformance: "gate_error",
      error: (err as Error)?.message ?? String(err),
    });
    return "{}";
  }
}

async function gate(
  payload: GatePayload,
  deps: GateDeps,
  startedAt: number,
  onDenial: (settle: RulebookDenialReceipt) => void
): Promise<string> {
  const emitTelemetry = async (fields: Record<string, unknown> & { outcome: Outcome }) => {
    try {
      if (deps.telemetry) await deps.telemetry(fields);
      else await writeTelemetry(payload, startedAt, fields);
    } catch {
      /* advisory only */
    }
  };
  if (payload.hook_event_name !== "PreToolUse") return "{}";
  // #1304: Codex needs registration evidence for the proven runtime minimum.
  if (!hookGateAvailable(payload)) return "{}";
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : "";
  const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "";
  if (!toolName) return "{}";
  const input = payload.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : {};
  if (isGateExempt(toolName, input)) return "{}";
  const mutates = await rulebookMutates(toolName, input);
  // Readers skip C and catalog I/O; legacy must-load/reflex behavior remains
  // until Phase 4. Collect both reasons before emitting one denial; legacy claims keep their original finite contract.
  let rulebookDecision: string | undefined,
    requiredActionIds: readonly string[] = [],
    actionScope = "";
  if (deps.actionMustLoad) {
    const refs = deps.actionMustLoad.ids.map((id) => ({
      id,
      revision: deps.actionMustLoad?.revisions?.get(id) ?? null,
    }));
    await requireActionRules(payload, refs, Math.min(startedAt + HOOK_TIMEOUT_MS, deps.deadline ?? Infinity));
    const catalog: import("./rulebook-catalog.js").KernelCandidates = {
      entries: refs.map((r) => ({
        ...r,
        title: "",
        body: "",
        group: "explicit",
        updated: null,
        stale_status: "unknown",
        rulebook: "on-demand",
      })),
      omitted: 0,
    };
    rulebookDecision = await rulebookBoundary(payload, catalog, "action", {
      requiredOnly: true,
      deadline: deps.deadline,
      onRequired: (ids, scope) => {
        requiredActionIds = ids;
        actionScope = scope;
      },
      onDenial,
    });
  } else
    rulebookDecision =
      deps.kernel && mutates ? await boundedRulebookAction(payload, deps, startedAt, onDenial) : undefined;
  const rulebookDenied = rulebookDecision !== undefined && rulebookDecision !== "{}";
  if (!sessionId) return "{}";

  // A subagent never saw the main thread's hint block; its calls do not
  // answer for it. A reflex rule is about the action, whoever takes it.
  const subagent = hookAgent(payload) === "subagent";
  const matched = matchActionReflex(deps.reflexPool(), toolName, input);
  const reflexCandidates = matched.length > 0 ? await servedReflex(matched) : [];
  // #1305: a delivered reflex rule is in force from here on, at this revision.
  const reflexRevisions = new Map(
    reflexCandidates.map((m) => [m.memory.fm.id, indexedConventionSource(m.memory)] as const)
  );

  let claimedMustLoad: PendingMustLoad[] = [];
  let claimedReflex: ReflexMatch[] = [];
  let kernelActive: ActiveConvention[] | null = null;
  const kernelToken = randomUUID();
  const finishKernel = (delivered: boolean, backoff = false, seen?: KernelSeen) => {
    void mutateSessionState(sessionId, (state) => {
      let marker;
      try {
        marker = JSON.parse(state.constants?.[KERNEL_DELIVERY] ?? "null");
      } catch {
        return;
      }
      if (marker?.token !== kernelToken) return;
      delete state.constants![KERNEL_DELIVERY];
      if (delivered && seen) rememberKernel(state.constants!, seen);
      if (!delivered) {
        returnKernelCalls(state, marker);
        if (backoff) state.constants![KERNEL_RETRY_AT] = String(Date.now() + 5000);
      }
    }).catch(() => {});
  };
  let legacyPending: PendingMustLoad[] = [];
  let previousActive: ActiveConvention[] = [];
  let previousClaims: string[] = [];
  const undoLegacy = async () => {
    if (!legacyPending.length && !claimedReflex.length) return;
    await mutateSessionState(sessionId, (state) => {
      const pending = state.pendingMustLoad ?? [];
      for (const entry of legacyPending)
        if (!pending.some((e) => e.id === entry.id) && !state.loadedConventions?.some((c) => c.id === entry.id))
          pending.push(entry);
      if (pending.length) state.pendingMustLoad = pending;
      const reflexIds = new Set(claimedReflex.map((m) => m.memory.fm.id));
      state.deniedReflex = state.deniedReflex?.filter((id) => !reflexIds.has(id));
      // Restore only the activations this claim installed; preserve concurrent loads.
      state.activeConventions = state.activeConventions?.filter(
        (c) => !reflexIds.has(c.id) || state.loadedConventions?.some((l) => l.id === c.id)
      );
      for (const old of previousActive)
        if (reflexIds.has(old.id) && !state.activeConventions?.some((c) => c.id === old.id))
          (state.activeConventions ??= []).push(old);
      const added = new Set(legacyPending.map((e) => e.id).filter((id) => !previousClaims.includes(id)));
      state.claimedMustLoad = state.claimedMustLoad?.filter((id) => !added.has(id));
    });
  };
  const expired = () =>
    Date.now() - startedAt > HOOK_TIMEOUT_MS || (deps.deadline !== undefined && Date.now() >= deps.deadline);
  const actionToken = randomUUID();
  let actionIds: string[] = [],
    newActionClaims: string[] = [];
  const finishAction = async (delivered: boolean) => {
    const action = deps.actionMustLoad;
    if (!action || !actionIds.length) return;
    await mutateSessionState(sessionId, (state) => {
      if (state.constants?.[`${action.key}:scope`] !== actionScope) return;
      const confirmed = delivered && actionRulebookScope(state) === actionScope;
      const seen = new Set<string>(JSON.parse(state.constants?.[action.key] ?? "[]"));
      for (const id of actionIds) {
        const key = `${action.key}:attempt:${id}`,
          raw = state.constants?.[key];
        let marker;
        try {
          marker = raw ? JSON.parse(raw) : null;
        } catch {
          continue;
        }
        if (marker?.token !== actionToken) continue;
        if (confirmed) {
          const revisions = JSON.parse(state.constants?.[`${action.key}:revisions`] ?? "{}");
          revisions[id] = marker.revision ?? null;
          state.constants![`${action.key}:revisions`] = JSON.stringify(
            Object.fromEntries([...seen].slice(-200).map((id) => [id, revisions[id] ?? null]))
          );
          delete state.constants![key];
        } else {
          seen.delete(id);
          delete state.constants![key];
          if (newActionClaims.includes(id))
            state.claimedMustLoad = state.claimedMustLoad?.filter((value) => value !== id);
        }
      }
      if (state.constants) {
        state.constants[action.key] = JSON.stringify([...seen].slice(-200));
        // Retain only bounded completed agent histories; never evict an in-flight claim.
        const keys = Object.keys(state.constants),
          histories = keys.filter(
            (k) =>
              k.startsWith("github-action-conventions-v2") &&
              !k.includes(":attempt:") &&
              !k.endsWith(":revisions") &&
              !k.endsWith(":scope") &&
              !keys.some((at) => at.startsWith(k + ":attempt:"))
          );
        for (const old of histories.slice(0, -100)) {
          delete state.constants[old];
          delete state.constants[old + ":revisions"];
          delete state.constants[old + ":scope"];
        }
      }
    });
  };
  const undoAction = () => finishAction(false);
  try {
    const persisted = await mutateSessionState(
      sessionId,
      // #1525: the decisions are named steps (gate-lane-claims.ts), run here in
      // one locked mutation in their original order.
      (state) => {
        const delivery = countAndExpireDelivery(state, deps.countTool !== false, payload);
        claimedMustLoad = [];
        claimedReflex = [];
        kernelActive = null;
        previousActive = [...(state.activeConventions ?? [])];
        previousClaims = [...(state.claimedMustLoad ?? [])];
        const pending = claimPendingMustLoad(state, subagent);
        if (pending) {
          claimedMustLoad = pending;
          legacyPending = [...claimedMustLoad];
        }
        const action = deps.actionMustLoad;
        if (actionClaimable(state, action, requiredActionIds, actionScope, expired())) {
          const claim = claimActionRules(state, {
            action,
            requiredActionIds,
            actionScope,
            rulebookDenied,
            claimedMustLoad,
            token: actionToken,
            deadline: Math.min(startedAt + HOOK_TIMEOUT_MS, deps.deadline ?? Infinity),
          });
          actionIds = claim.ids;
          newActionClaims = claim.newClaims;
        }
        claimedReflex = claimReflex(state, reflexCandidates, reflexRevisions);
        if (claimedMustLoad.length > 0)
          recordClaimedMustLoad(
            state,
            claimedMustLoad.map((e) => e.id)
          );
        // A deny or action context carries its own message; the kernel waits.
        const quiet =
          !!deps.kernel &&
          !rulebookDenied &&
          actionIds.length === 0 &&
          claimedMustLoad.length === 0 &&
          claimedReflex.length === 0;
        kernelActive = reserveKernel(
          state,
          quiet,
          delivery,
          kernelToken,
          Math.min(startedAt + HOOK_TIMEOUT_MS, deps.deadline ?? Infinity)
        );
      },
      { deadline: Math.min(startedAt + HOOK_TIMEOUT_MS, deps.deadline ?? Infinity) }
    );
    const elapsed = Date.now() - startedAt;
    if (!persisted) {
      // No claim reached the disk, so nothing may be denied: the call passes.
      // SQLite may reject BEGIN before the callback sees the pending ids. The
      // read snapshot is diagnostic only; it never claims or consumes them.
      const unclaimedMustLoadIds =
        claimedMustLoad.length > 0
          ? claimedMustLoad.map((e) => e.id)
          : subagent
            ? []
            : ((await loadSessionState(sessionId)).pendingMustLoad ?? []).map((e) => e.id);
      await emitTelemetry({
        outcome: "pass",
        non_conformance: expired() ? "gate_timeout" : "state_write_failed",
        ...(unclaimedMustLoadIds.length > 0 ? { unclaimed_must_load_ids: unclaimedMustLoadIds } : {}),
        ...(claimedReflex.length > 0 ? { unclaimed_reflex_ids: claimedReflex.map((m) => m.memory.fm.id) } : {}),
      });
      return "{}";
    }
    if (elapsed > HOOK_TIMEOUT_MS || (deps.deadline !== undefined && Date.now() >= deps.deadline)) {
      await undoAction();
      await undoLegacy();
      if (kernelActive) finishKernel(false);
      // A late response must neither deny nor consume an undelivered legacy claim.
      await emitTelemetry({ outcome: "pass", non_conformance: "gate_timeout" });
      return "{}";
    }
    if (claimedMustLoad.length === 0 && claimedReflex.length === 0) {
      if (rulebookDenied) return rulebookDecision!;
      if (actionIds.length) {
        const context = actionConventionFrame(actionIds, deps.actionMustLoad?.summaries, deps.actionMustLoad?.origins);
        await confirmLaneDelivery(
          finishAction,
          Math.min(startedAt + HOOK_TIMEOUT_MS, deps.deadline ?? Infinity),
          "context"
        );
        return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: context } });
      }
      const active = kernelActive as ActiveConvention[] | null;
      return active === null || !deps.kernel
        ? "{}"
        : redeliverKernel(payload, deps.kernel, active, startedAt, finishKernel, deps.deadline);
    }

    const reason = denyReason(
      claimedMustLoad.map((e) => e.id),
      claimedReflex
    );
    if (rulebookDenied) reason.text += "\n" + JSON.parse(rulebookDecision!).hookSpecificOutput.permissionDecisionReason;
    if (actionIds.length)
      reason.text +=
        "\n" + actionConventionFrame(actionIds, deps.actionMustLoad?.summaries, deps.actionMustLoad?.origins);
    await emitTelemetry({
      outcome: "deny",
      must_load_ids: claimedMustLoad.map((e) => e.id),
      must_load_blocks: [...new Set(claimedMustLoad.map((e) => e.block))],
      reflex_ids: claimedReflex.map((m) => m.memory.fm.id),
      degraded_ids: reason.degraded,
      reason_chars: reason.text.length,
    });
    if (expired()) {
      await undoAction();
      await undoLegacy();
      return "{}";
    }
    if (actionIds.length)
      await confirmLaneDelivery(finishAction, Math.min(startedAt + HOOK_TIMEOUT_MS, deps.deadline ?? Infinity));
    if (expired()) {
      await undoAction();
      await undoLegacy();
      return "{}";
    }
    await confirmLaneDelivery(
      async (delivered) => {
        if (!delivered) await undoLegacy();
      },
      Math.min(startedAt + HOOK_TIMEOUT_MS, deps.deadline ?? Infinity)
    );
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason.text,
      },
    });
  } catch (error) {
    await undoAction();
    await undoLegacy();
    throw error;
  }
}

/** A catalog outage or a queued C write must not swallow a legacy denial.
 * The deadline also guards work that completes after the timeout has won. */
async function boundedRulebookAction(
  payload: GatePayload,
  deps: GateDeps,
  startedAt: number,
  onDenial: (settle: RulebookDenialReceipt) => void
): Promise<string | undefined> {
  const deadline = Math.min(
    startedAt + Math.min(RULEBOOK_ACTION_BUDGET_MS, HOOK_TIMEOUT_MS / 2),
    deps.deadline ?? Infinity
  );
  if (Date.now() >= deadline) return undefined;
  let abandoned = false,
    settleC: RulebookDenialReceipt | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = (async () => {
    const catalog = await catalogFor(payload, deps.kernel!);
    if (abandoned || Date.now() >= deadline) return undefined;
    return rulebookBoundary(payload, catalog, "action", {
      deadline,
      onDenial: async (settle) => {
        settleC = settle;
        if (abandoned || Date.now() >= deadline) await settle(false);
        else onDenial(settle);
      },
    });
  })();
  const timeout = Symbol("rulebook-timeout");
  try {
    const result = await Promise.race([
      work,
      new Promise<typeof timeout>((resolve) => {
        timer = setTimeout(() => resolve(timeout), Math.max(0, deadline - Date.now()));
      }),
    ]);
    if (result === timeout || Date.now() >= deadline) {
      abandoned = true;
      await settleC?.(false);
      void spoolRulebookFailure(payload.session_id ?? null).catch(() => {});
      return undefined;
    }
    return result;
  } catch {
    abandoned = true;
    await settleC?.(false);
    // C is unavailable; legacy claims still run on their original budget.
    void spoolRulebookFailure(payload.session_id ?? null).catch(() => {});
    return undefined;
  } finally {
    abandoned = true;
    if (timer) clearTimeout(timer);
    // A reservation acquired after this scope ended self-releases above.
  }
}

/**
 * #1305: periodic rule context, never a deny. The count stays due until a
 * context delivery is confirmed; an unavailable catalog retries next call.
 * #1461: directly observed, unchanged context can be shortened to a reminder.
 */
async function redeliverKernel(
  payload: GatePayload,
  kernel: NonNullable<GateDeps["kernel"]>,
  active: readonly ActiveConvention[],
  startedAt: number,
  finishKernel: (delivered: boolean, backoff?: boolean, seen?: KernelSeen) => void,
  outerDeadline?: number
): Promise<string> {
  const project = projectForLane(typeof payload.cwd === "string" && payload.cwd ? payload.cwd : process.cwd());
  const deadline = Math.min(startedAt + HOOK_TIMEOUT_MS, outerDeadline ?? Infinity);
  try {
    const candidates = await withRulebookDeadline(
      () => kernel(active, project, "content"),
      Math.min(deadline, Date.now() + RULEBOOK_CATALOG_BUDGET_MS)
    );
    const trigger = `${RULE_KERNEL_TOOL_CALLS} tool calls without a prompt`;
    const rendered = renderRuleKernel(candidates, { trigger });
    if (Date.now() >= deadline) {
      finishKernel(false);
      return "{}";
    }
    if (rendered.text === "") {
      finishKernel(true);
      return "{}";
    }
    const seen = kernelSeen(payload, rendered.text);
    const unchanged = await kernelUnchanged(payload.session_id ?? "", seen);
    const text = unchanged
      ? renderKernelReminder(candidates, { trigger, fingerprint: seen.fingerprint })
      : rendered.text;
    recordBudgetShadow(payload.session_id ?? null, "hook_call", Math.ceil(text.length / 4), {
      source: "rule-kernel",
    });
    void writeTelemetry(
      payload,
      startedAt,
      unchanged
        ? { outcome: "pass", kernel_reminder_chars: text.length, kernel_fingerprint: seen.fingerprint }
        : {
            outcome: "pass",
            kernel_ids: rendered.full,
            kernel_degraded_ids: rendered.degraded,
            kernel_omitted: rendered.omitted,
            kernel_paged_index: rendered.paged_index ?? 0,
            kernel_chars: rendered.text.length,
            kernel_fingerprint: seen.fingerprint,
          }
    );
    await confirmLaneDelivery(
      async (delivered) => {
        finishKernel(delivered, false, unchanged ? undefined : seen);
      },
      deadline,
      "context"
    );
    return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: text } });
  } catch {
    finishKernel(false, true);
    // Restore the claim, with backoff instead of charging every subsequent reader.
    void writeTelemetry(payload, startedAt, { outcome: "pass", non_conformance: "kernel_unavailable" });
    return "{}";
  }
}

/** The kill switch and the per-turn budget of the prompt reflex apply here
 *  too. Read only once a rule matched — the settings file is not free. */
async function servedReflex(matched: ReflexMatch[]): Promise<ReflexMatch[]> {
  const { enabled, maxPerTurn } = await reflexConfig();
  return enabled ? matched.slice(0, maxPerTurn) : [];
}

function denyReason(mustLoad: string[], reflex: ReflexMatch[]): { text: string; degraded: string[] } {
  const parts: string[] = [];
  const degraded: string[] = [];
  if (mustLoad.length > 0) {
    parts.push(
      `bastra-recall must-load: ${mustLoad.join(", ")} — shown as must-load and not loaded yet. ` +
        `load_memory(id) or dismiss via load_memory(id, verbosity:'lean'). ` +
        `This call was interrupted once; retrying it goes through.`
    );
  }
  let budget = REFLEX_BODY_BUDGET_CHARS;
  for (const m of reflex) {
    const fm = m.memory.fm;
    const body = stripFenceMarkers(stripAutoRelatedSection(m.memory.body ?? "").trim());
    const head = `bastra-recall reflex rule ${fm.id} ("${stripFenceMarkers(fm.title)}", trigger "${stripFenceMarkers(m.phrase)}") applies to this action`;
    if (body !== "" && body.length <= budget) {
      budget -= body.length;
      parts.push(`${head}:\n${body}`);
    } else {
      degraded.push(fm.id);
      parts.push(`${head}. degraded: load_memory(${fm.id}) — the rule is longer than this notice may carry.`);
    }
  }
  if (reflex.length > 0) parts.push("Each rule interrupts once per session; retrying the call goes through.");
  return { text: parts.join("\n\n"), degraded };
}

/** One `gate_hook_call` row per deny, kernel re-delivery or non-conformance.
 *  A plain pass writes nothing: the lane runs on every tool call. */
async function writeTelemetry(
  payload: GatePayload,
  startedAt: number,
  fields: Record<string, unknown> & { outcome: Outcome }
): Promise<void> {
  if (envOff("BASTRA_TELEMETRY", "NEXUS_TELEMETRY")) return;
  try {
    const logDir = envFirst("BASTRA_LOG_PATH", "NEXUS_LOG_PATH") ?? defaultLogDir();
    await mkdir(logDir, { recursive: true });
    const ts = new Date().toISOString();
    const sessionId = typeof payload.session_id === "string" && payload.session_id ? payload.session_id : null;
    const event = {
      kind: "gate_hook_call",
      ts,
      session_id: sessionId ?? randomUUID(),
      hook_version: HOOK_VERSION,
      tool_name: typeof payload.tool_name === "string" ? payload.tool_name : null,
      latency_ms_total: Date.now() - startedAt,
      ...fields,
      dimensions: dimensionsFrom({
        client: hookClientEvidence(payload),
        hook_source: "gate",
        session_id: sessionId ?? undefined,
        agent: hookAgent(payload),
      }),
    };
    await appendFile(join(logDir, `events-${ts.slice(0, 10)}.jsonl`), JSON.stringify(event) + "\n", "utf8");
  } catch {
    // Telemetry must never break the lane.
  }
}
