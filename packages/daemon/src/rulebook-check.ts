/** Round self-report, not a proof of semantic compliance. No prompt classification. */
import { getPrimaryLanguage } from "./settings.js";
import { recordRulebookEvent } from "./rulebook-events.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { loadSessionState, mutateSessionState, type SessionState } from "./session-state.js";
import { callerSessionStore } from "./caller-session.js";
import { hookAgent, hookClientEvidence, hookGateAvailable } from "./hook-surface.js";
import { cachedRulebookCatalog, type KernelCandidates } from "./rulebook-catalog.js";
import { projectForLane } from "./scope-filter.js";
import type { ToolDeps } from "./tool-deps.js";
import { drainRulebookFailures, spoolRulebookFailure } from "./rulebook-spool.js";

const Actor = z.object({ key: z.string(), checked: z.boolean().default(false), ids: z.array(z.string()).default([]),
  denies: z.number().default(0), stops: z.number().default(0), deferredStop: z.boolean().default(false) });
const State = z.object({ context: z.string(), round: z.number(), actors: z.array(Actor), unchecked: z.number() });
type CheckState = z.infer<typeof State>;
export interface RulebookPayload { session_id?: string; agent_id?: string; bastra_client?: string; bastra_codex_version?: string; cwd?: string; stop_hook_active?: boolean }
function read(state: { readonly rulebookCheck?: string }): CheckState {
  try { return State.parse(JSON.parse(state.rulebookCheck ?? "")); }
  catch { return { context: randomUUID(), round: 0, actors: [], unchecked: 0 }; }
}
function put(state: SessionState, value: CheckState) { state.rulebookCheck = JSON.stringify(value); }
function actor(state: CheckState, key: string) {
  let found = state.actors.find(a => a.key === key);
  if (!found) { found = { key, checked: false, ids: [], denies: 0, stops: 0, deferredStop: false }; state.actors.push(found); }
  return found;
}
function identity(p: RulebookPayload): string {
  if (p.agent_id) return `agent:${p.agent_id}`;
  return hookAgent(p) === "main" ? "main" : "unattributed";
}
// Pending ordinary Stop work survives a context/round reset; checking evidence does not.
const deferredActors = (s: CheckState) => s.actors.filter(a => a.deferredStop).map(a => ({ ...a, checked: false, ids: [], denies: 0, stops: 0 }));
export async function resetRulebookContext(sessionId: string): Promise<void> {
  if (sessionId) await mutateSessionState(sessionId, s => {
    const old = read(s); put(s, { context: randomUUID(), round: old.round, actors: deferredActors(old), unchecked: old.unchecked });
  });
}
export async function beginRulebookRound(p: RulebookPayload, catalog: KernelCandidates): Promise<string> {
  if (!p.session_id || hookClientEvidence(p) === "replay") return "";
  let unchecked = await drainRulebookFailures(p.session_id);
  const persisted = await mutateSessionState(p.session_id, s => {
    const old = read(s); unchecked += old.unchecked;
    put(s, { context: old.context, round: old.round + 1, actors: deferredActors(old), unchecked: 0 });
  });
  if (!persisted && unchecked) await spoolRulebookFailure(p.session_id, unchecked);
  const de = (await getPrimaryLanguage().catch(() => undefined)) === "de";
  const count = catalog.entries.length;
  const example = `rulebook_check(${JSON.stringify({ applicable: [], session_id: p.session_id, ...(p.agent_id ? { agent_id: p.agent_id } : {}) })})`;
  return [count ? (de ? `Regelbuch: ${count} Regeln im Index; vor der Antwort prüfen (load_memory oder ${example}, wenn keine zutrifft).` : `Rulebook: ${count} rules in the index; check before answering (load_memory or ${example} if none applies).`) : "",
    unchecked ? (de ? `Regelbuch: ${unchecked} Prüfgrenzen blieben ungeprüft (Begrenzung oder Ausfall).` : `Rulebook: ${unchecked} unchecked boundary observations (retry cap or outage).`) : ""].filter(Boolean).join("\n");
}
export const RulebookCheckArgs = z.object({ applicable: z.array(z.string().min(1)).max(10000),
  agent_id: z.string().min(1).max(200).optional(),
  session_id: z.string().min(1).max(200).optional() }).strict();
export async function recordRulebookCheck(sessionId: string | null | undefined, input: z.infer<typeof RulebookCheckArgs>, catalog: KernelCandidates) {
  if (!sessionId) return { ok: false, reason: "Session unknown; no receipt recorded. Supply the session_id from your hook, or continue within the bounded gate." };
  const ids = new Set(catalog.entries.map(e => e.id));
  if (input.applicable.some(id => !ids.has(id))) return { ok: false, reason: "Unknown rule IDs; read list_rules and retry." };
  let context = "", round = 0;
  const persisted = await mutateSessionState(sessionId, s => {
    const state = read(s), a = actor(state, input.agent_id ? `agent:${input.agent_id}` : "main");
    a.checked = true; a.ids = [...new Set(input.applicable)]; context = state.context; round = state.round; put(s, state);
  });
  await recordRulebookEvent(sessionId, { outcome: persisted ? "checked" : "fail-open", context, round, ids: input.applicable });
  return persisted ? { ok: true, context, round, applicable: input.applicable,
    contract: "Self-report for this session/context/round. Not action-bound; no guarantee of semantic application." } : { ok: false, reason: "State unavailable; gate remains bounded and fail-open." };
}
export async function rulebookCheckHandler(deps: ToolDeps, args: unknown, ctx: { sessionId?: string | null; project?: string | null } = {}) {
  const input = RulebookCheckArgs.parse(args);
  const sid = ctx.sessionId ?? callerSessionStore.getStore() ?? input.session_id;
  const snapshot = sid ? await loadSessionState(sid) : undefined;
  return recordRulebookCheck(sid, input, await cachedRulebookCatalog(deps.vault, { project: ctx.project ?? null, active: snapshot?.activeConventions ?? [] }));
}
/** Only the full successful load path calls this, for a current binding rule. */
export async function recordRulebookLoad(sessionId: string, id: string, agentId?: string | null): Promise<void> {
  // Missing actor means main; explicit worker IDs remain isolated.
  if (!sessionId) return;
  await mutateSessionState(sessionId, s => {
    const state = read(s), a = actor(state, agentId ? `agent:${agentId}` : "main");
    a.checked = true; if (!a.ids.includes(id)) a.ids.push(id); put(s, state);
  });
}
export type CatalogProvider = (active: readonly import("./session-state.js").ActiveConvention[], project: string | null) => Promise<KernelCandidates>;
export async function catalogFor(p: RulebookPayload, kernel: CatalogProvider) {
  const state = p.session_id ? await loadSessionState(p.session_id) : undefined;
  return kernel(state?.activeConventions ?? [], projectForLane(p.cwd || process.cwd()));
}
/** Undefined means C did not apply; {} permits the legacy lanes to run.
 * Legacy denials retain their own once-per-claim/session contract. */
export type RulebookDenialReceipt = (delivered: boolean) => Promise<void>;
export async function rulebookBoundary(p: RulebookPayload, catalog: KernelCandidates, boundary: "action" | "stop", options: {
  deadline?: number; onDenial?: (settle: RulebookDenialReceipt) => void | Promise<void>;
} = {}): Promise<string | undefined> {
  if (!hookGateAvailable(p)) return undefined;
  if (!catalog.entries.some(e => boundary === "action" || e.rulebook === "on-demand")) return undefined;
  if (boundary === "stop" && !["claude-code", "codex"].includes(hookClientEvidence(p))) return undefined;
  if (!p.session_id) { await spoolRulebookFailure(null); return "{}"; }
  let deny = false, unchecked = false, context = "", round = 0;
  const persisted = await mutateSessionState(p.session_id, s => {
    const state = read(s), a = actor(state, identity(p));
    context = state.context; round = state.round;
    if (!a.checked) {
      const field = boundary === "action" ? "denies" : "stops", cap = boundary === "action" ? 2 : 1;
      if (a[field] < cap && !(boundary === "stop" && p.stop_hook_active === true)) { a[field]++; deny = true; if (boundary === "stop") a.deferredStop = true; }
      else { state.unchecked++; unchecked = true; }
    }
    put(s, state);
  }, { deadline: options.deadline });
  if (persisted && deny && boundary === "action" && options.onDenial) {
    let settled = false;
    await options.onDenial(async delivered => {
      if (settled) return; settled = true;
      if (delivered) return;
      await mutateSessionState(p.session_id!, s => {
        const current = read(s);
        if (current.context !== context || current.round !== round) return;
        const a = current.actors.find(a => a.key === identity(p));
        if (a) a.denies = Math.max(0, a.denies - 1);
        put(s, current);
      });
    });
  }
  if (!persisted) { await spoolRulebookFailure(p.session_id); await recordRulebookEvent(p.session_id, { boundary, outcome: "fail-open" }); return "{}"; }
  if (deny || unchecked) await recordRulebookEvent(p.session_id, { boundary, outcome: deny ? "deny" : "unchecked", agent_known: identity(p) !== "unattributed" });
  if (!deny) return "{}";
  const de = (await getPrimaryLanguage().catch(() => undefined)) === "de";
  const attribution = identity(p) === "unattributed" ? (de ? " Zuordnung fehlt; eigener Rundenbeleg nötig, maximal zwei Ablehnungen." : " Agent attribution missing; a main-thread receipt cannot be inherited. At most two denials.") : "";
  const example = `rulebook_check(${JSON.stringify({ applicable: [], session_id: p.session_id, ...(p.agent_id ? { agent_id: p.agent_id } : {}) })})`;
  const reason = (de ? `Prüfe den Regelbuch-Index gegen diese Runde. Lade passende Regeln und überarbeite die Antwort, oder rufe ${example} auf, wenn keine zutrifft.` : `Check the rulebook index against this round. Load applicable rules and revise the answer, or call ${example} if none applies.`) + attribution;
  return boundary === "stop" ? JSON.stringify({ decision: "block", reason }) : JSON.stringify({ hookSpecificOutput: {
    hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
}

/** Consume deferred ordinary Stop work only when it can actually run. */
export async function takeDeferredRulebookStop(p: RulebookPayload): Promise<boolean> {
  if (!p.session_id) return false;
  const snapshot = await loadSessionState(p.session_id);
  if (!snapshot.rulebookCheck || !read(snapshot).actors.some(a => a.key === identity(p) && a.deferredStop)) return false;
  let pending = false;
  const persisted = await mutateSessionState(p.session_id, s => {
    if (!s.rulebookCheck) return;
    const state = read(s), a = actor(state, identity(p)); pending = a.deferredStop; a.deferredStop = false; put(s, state);
  });
  return persisted && pending;
}
