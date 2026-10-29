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
import { stripFenceMarkers } from "@bastra-recall/core/scrub";
import { readConventionSource } from "./convention-source.js";
import { envFirst, envInt, envOff } from "./env.js";
import { FAST_BUDGET_MS } from "./hook-budgets.js";
import { hookAgent, hookGateAvailable, hookClientEvidence } from "./hook-surface.js";
import { dimensionsFrom } from "./telemetry-dimensions.js";
import { defaultLogDir } from "./telemetry.js";
import { isReflexPoolMember, matchReflexPool, reflexConfig, reflexPool, type ReflexMatch } from "./reflex.js";
import {
  mutateSessionState, recordActiveConventions, recordClaimedMustLoad,
  type ActiveConvention, type PendingMustLoad,
} from "./session-state.js";
import { recordBudgetShadow } from "./session-budget.js";
import { projectForLane } from "./scope-filter.js";
import { RULE_KERNEL_TOOL_CALLS, renderRuleKernel, type KernelCandidates } from "./rule-kernel.js";
import { RECALL_TOOL_PREFIX } from "./save-notice-lane.js";

const HOOK_TIMEOUT_MS = envInt("BASTRA_HOOK_TIMEOUT_MS", FAST_BUDGET_MS, "NEXUS_HOOK_TIMEOUT_MS");
const HOOK_VERSION = "0.1.0";

/** The action context a reflex trigger is matched against stays below 8 KB. */
export const MAX_ACTION_CONTEXT_CHARS = 8 * 1024 - 1;
/** Body characters one deny may carry; past it a rule is named, not quoted. */
export const REFLEX_BODY_BUDGET_CHARS = 4000;
/** Reflex claims remembered per session. */
const DENIED_REFLEX_CAP = 200;
/** Pool eligibility: only a rule the user dictated and rated as weighty. */
const MIN_SALIENCE = 0.8;

const RECALL_TOOL = new RegExp(RECALL_TOOL_PREFIX.replace("bastra-recall", "bastra[-_]recall"));

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
  /** The action-time reflex pool, already filtered (see actionReflexPool). */
  reflexPool: () => readonly Memory[];
  /** #1305: the rule kernel's candidates from the daemon's vault index.
   *  Absent = no re-delivery; the count still runs. */
  kernel?: (active: readonly ActiveConvention[], project: string | null) => Promise<KernelCandidates>;
}

/** The recall tools themselves always pass — denying the load would deadlock. */
export function isGateExempt(toolName: string, input: Record<string, unknown>): boolean {
  if (RECALL_TOOL.test(toolName)) return true;
  return toolName === "ToolSearch" && typeof input.query === "string" && /bastra/i.test(input.query);
}

/**
 * Only a rule the user wired as reflex, dictated in person, rated salience >=
 * 0.8 and that nothing superseded may interrupt an action.
 */
export function actionReflexPool(memories: readonly Memory[]): Memory[] {
  return memories.filter(
    (m) =>
      isReflexPoolMember(m) &&
      m.fm.write_origin === "user-directed" &&
      typeof m.fm.salience === "number" &&
      m.fm.salience >= MIN_SALIENCE,
  );
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

/**
 * What a reflex trigger is matched against: the tool name (and an MCP tool's
 * own name), the paths, the query and the Bash command. Never file contents —
 * a trigger word inside a written file is not the action.
 */
export function actionContext(toolName: string, input: Record<string, unknown>): string {
  const parts = [toolName];
  const short = toolName.split("__").pop();
  if (short && short !== toolName) parts.push(short);
  for (const key of ["file_path", "notebook_path", "path", "query", "command"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) parts.push(value);
  }
  return parts.join("\n").slice(0, MAX_ACTION_CONTEXT_CHARS);
}

type Outcome = "pass" | "deny";

/**
 * Run the gate; return the exact stdout document for the hook client.
 * Never throws — every failure answers `{}`.
 */
export async function runGateLane(payload: GatePayload, deps: GateDeps): Promise<string> {
  const startedAt = Date.now();
  try {
    return await gate(payload, deps, startedAt);
  } catch (err) {
    await writeTelemetry(payload, startedAt, {
      outcome: "pass",
      non_conformance: "gate_error",
      error: (err as Error)?.message ?? String(err),
    });
    return "{}";
  }
}

async function gate(payload: GatePayload, deps: GateDeps, startedAt: number): Promise<string> {
  if (payload.hook_event_name !== "PreToolUse") return "{}";
  // #1304: Codex needs registration evidence for the proven runtime minimum.
  if (!hookGateAvailable(payload)) return "{}";
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : "";
  const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "";
  if (!sessionId || !toolName) return "{}";
  const input = payload.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : {};
  if (isGateExempt(toolName, input)) return "{}";

  // A subagent never saw the main thread's hint block; its calls do not
  // answer for it. A reflex rule is about the action, whoever takes it.
  const subagent = hookAgent(payload) === "subagent";
  const matched = matchActionReflex(deps.reflexPool(), toolName, input);
  const reflexCandidates = matched.length > 0 ? await servedReflex(matched) : [];
  // #1305: a delivered reflex rule is in force from here on, at this revision.
  const reflexRevisions = new Map(
    await Promise.all(reflexCandidates.map(async (m) => [m.memory.fm.id, await readConventionSource(m.memory)] as const)),
  );

  let claimedMustLoad: PendingMustLoad[] = [];
  let claimedReflex: ReflexMatch[] = [];
  let kernelActive: ActiveConvention[] | null = null;
  const persisted = await mutateSessionState(sessionId, (state) => {
    state.toolCalls = (state.toolCalls ?? 0) + 1;
    claimedMustLoad = [];
    claimedReflex = [];
    kernelActive = null;
    if (!subagent && state.pendingMustLoad !== undefined && state.pendingMustLoad.length > 0) {
      claimedMustLoad = state.pendingMustLoad;
      delete state.pendingMustLoad;
    }
    if (reflexCandidates.length > 0) {
      const denied = new Set(state.deniedReflex ?? []);
      claimedReflex = reflexCandidates.filter((m) => !denied.has(m.memory.fm.id));
      if (claimedReflex.length > 0) {
        for (const m of claimedReflex) denied.add(m.memory.fm.id);
        state.deniedReflex = [...denied].slice(-DENIED_REFLEX_CAP);
        recordActiveConventions(state, claimedReflex.map((m) => ({ id: m.memory.fm.id, ...(reflexRevisions.get(m.memory.fm.id) ?? { revision: null }) })));
      }
    }
    if (claimedMustLoad.length > 0) recordClaimedMustLoad(state, claimedMustLoad.map((e) => e.id));
    // #1305: a deny carries its own message; the kernel waits for the next call.
    if (deps.kernel && claimedMustLoad.length === 0 && claimedReflex.length === 0 && state.toolCalls >= RULE_KERNEL_TOOL_CALLS) {
      kernelActive = [...(state.activeConventions ?? [])];
      state.toolCalls = 0;
    }
  });
  const elapsed = Date.now() - startedAt;
  if (!persisted) {
    // No claim reached the disk, so nothing may be denied: the call passes.
    await writeTelemetry(payload, startedAt, {
      outcome: "pass",
      non_conformance: "state_write_failed",
      ...(claimedMustLoad.length > 0 ? { unclaimed_must_load_ids: claimedMustLoad.map((e) => e.id) } : {}),
      ...(claimedReflex.length > 0 ? { unclaimed_reflex_ids: claimedReflex.map((m) => m.memory.fm.id) } : {}),
    });
    return "{}";
  }
  if (elapsed > HOOK_TIMEOUT_MS) {
    // The client has most likely given up already. Persisted claims stay
    // spent, but a late response must never deny the action.
    await writeTelemetry(payload, startedAt, { outcome: "pass", non_conformance: "gate_timeout" });
    return "{}";
  }
  if (claimedMustLoad.length === 0 && claimedReflex.length === 0) {
    const active = kernelActive as ActiveConvention[] | null;
    return active === null || !deps.kernel ? "{}" : redeliverKernel(payload, deps.kernel, active, startedAt);
  }

  const reason = denyReason(claimedMustLoad.map((e) => e.id), claimedReflex);
  await writeTelemetry(payload, startedAt, {
    outcome: "deny",
    must_load_ids: claimedMustLoad.map((e) => e.id),
    must_load_blocks: [...new Set(claimedMustLoad.map((e) => e.block))],
    reflex_ids: claimedReflex.map((m) => m.memory.fm.id),
    degraded_ids: reason.degraded,
    reason_chars: reason.text.length,
  });
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason.text,
    },
  });
}

/**
 * #1305: the rule kernel as a hint after {@link RULE_KERNEL_TOOL_CALLS} tool
 * calls without a prompt. Never a deny. The count is already reset on disk; a
 * kernel that cannot be built or comes too late answers `{}` and leaves a row.
 */
async function redeliverKernel(
  payload: GatePayload,
  kernel: NonNullable<GateDeps["kernel"]>,
  active: readonly ActiveConvention[],
  startedAt: number,
): Promise<string> {
  const project = projectForLane(typeof payload.cwd === "string" && payload.cwd ? payload.cwd : process.cwd());
  const rendered = renderRuleKernel(await kernel(active, project), { trigger: `${RULE_KERNEL_TOOL_CALLS} tool calls without a prompt` });
  if (rendered.text === "") return "{}";
  if (Date.now() - startedAt > HOOK_TIMEOUT_MS) {
    await writeTelemetry(payload, startedAt, { outcome: "pass", non_conformance: "gate_timeout", kernel_ids: rendered.full.concat(rendered.degraded) });
    return "{}";
  }
  // #458 shadow: the re-delivery is PreToolUse context like the tool lanes'.
  recordBudgetShadow(payload.session_id ?? null, "hook_call", Math.ceil(rendered.text.length / 4), { source: "rule-kernel" });
  await writeTelemetry(payload, startedAt, {
    outcome: "pass",
    kernel_ids: rendered.full,
    kernel_degraded_ids: rendered.degraded,
    kernel_omitted: rendered.omitted,
    kernel_chars: rendered.text.length,
  });
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: rendered.text },
  });
}

function matchActionReflex(pool: readonly Memory[], toolName: string, input: Record<string, unknown>): ReflexMatch[] {
  if (pool.length === 0) return [];
  return matchReflexPool(pool, actionContext(toolName, input), pool.length).matched;
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
        `This call was interrupted once; retrying it goes through.`,
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
async function writeTelemetry(payload: GatePayload, startedAt: number, fields: Record<string, unknown> & { outcome: Outcome }): Promise<void> {
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
