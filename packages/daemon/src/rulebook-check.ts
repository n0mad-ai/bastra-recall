/** Round self-report, not a proof of semantic compliance. No prompt classification. */
import { ConventionValidatorSchema } from "@bastra-recall/core";
import { expireReceipts } from "./receipt-store.js";
import { getPrimaryLanguage } from "./settings.js";
import { recordRulebookEvent } from "./rulebook-events.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { loadSessionState, mutateSessionState, type SessionState, ACTIVE_CONVENTIONS_CAP, recordActiveConventions, taskIdFor } from "./session-state.js";
import { callerSessionStore } from "./caller-session.js";
import { hookAgent, hookClientEvidence, hookGateAvailable } from "./hook-surface.js";
import { collectRulebookCatalog, cachedRulebookCatalog, withRulebookDeadline, RULEBOOK_TOOL_BUDGET_MS, type RulebookCatalogMode, type KernelCandidates } from "./rulebook-catalog.js";
import { projectForLane } from "./scope-filter.js";
import type { ToolDeps } from "./tool-deps.js";
import { drainRulebookFailures, spoolRulebookFailure } from "./rulebook-spool.js";

const RuleRef = z.object({id:z.string(),revision:z.string().nullable()});
const RoundRule = RuleRef.extend({validator:ConventionValidatorSchema.optional()});
const Actor = z.object({roundApplied:z.array(RoundRule).default([]),roundDismissed:z.array(RuleRef).default([]),repairs:z.number().default(0),repairProse:z.boolean().default(false),required:z.array(RuleRef).default([]), loaded:z.array(RuleRef).default([]), dismissed:z.array(RuleRef).default([]), key: z.string(), checked: z.boolean().default(false), ids: z.array(z.string()).default([]),
  denies: z.number().default(0), stops: z.number().default(0), deferredStop: z.boolean().default(false) });
const State = z.object({ copyViolations:z.number().default(0), blockedDismissals:z.array(z.string()).default([]), context: z.string(), round: z.number(), actors: z.array(Actor), unchecked: z.number(), exceptions: z.array(z.string()).default([]) });
type CheckState = z.infer<typeof State>;
export interface RulebookPayload { session_id?: string; agent_id?: string; bastra_client?: string; bastra_codex_version?: string; cwd?: string; stop_hook_active?: boolean }
function read(state: { readonly rulebookCheck?: string }): CheckState {
  try { return State.parse(JSON.parse(state.rulebookCheck ?? "")); }
  catch { return { context: randomUUID(), round: 0, actors: [], unchecked: 0, copyViolations:0, blockedDismissals:[], exceptions: [] }; }
}
function put(state: SessionState, value: CheckState) { state.rulebookCheck = JSON.stringify(value); }
function actor(state: CheckState, key: string) {
  let found = state.actors.find(a => a.key === key);
  if (!found) { found = { key, roundApplied:[],roundDismissed:[],repairs:0,repairProse:false,checked: false, ids: [], denies: 0, stops: 0, deferredStop: false, required:[],loaded:[],dismissed:[] }; state.actors.push(found); }
  return found;
}
function identity(p: RulebookPayload): string {
  if (p.agent_id) return `agent:${p.agent_id}`;
  return hookAgent(p) === "main" ? "main" : "unattributed";
}
// Pending ordinary Stop work survives a context/round reset; checking evidence does not.
const deferredActors = (s: CheckState) => s.actors.filter(a => a.deferredStop || a.required.length || a.loaded.length || a.dismissed.length).map(a => ({ ...a, checked: false, ids: [], denies: 0, stops: 0, roundApplied:[],roundDismissed:[],repairs:0,repairProse:false }));
export async function resetRulebookContext(sessionId: string): Promise<void> {
  if (sessionId) await mutateSessionState(sessionId, s => {
    const old = read(s); put(s, { context: randomUUID(), round: old.round, actors: deferredActors(old).map(a=>({...a,loaded:[],dismissed:[]})), unchecked: old.unchecked, copyViolations:old.copyViolations, blockedDismissals:old.blockedDismissals, exceptions: old.exceptions });
  });
}
export async function beginRulebookRound(p: RulebookPayload, catalog: KernelCandidates): Promise<string> {
  if (!p.session_id || hookClientEvidence(p) === "replay") return "";
  let unchecked = await drainRulebookFailures(p.session_id);
  let exceptions: string[] = [], blockedDismissals:string[]=[];
  let copyViolations=0;
  const persisted = await mutateSessionState(p.session_id, s => {
    const old = read(s); unchecked += old.unchecked;
    exceptions = old.exceptions;blockedDismissals=old.blockedDismissals;copyViolations=old.copyViolations;
    put(s, { context: old.context, round: old.round + 1, actors: deferredActors(old), unchecked: 0, copyViolations:0, blockedDismissals:[], exceptions: [] });
  });
  if (!persisted && unchecked) await spoolRulebookFailure(p.session_id, unchecked);
  const de = (await getPrimaryLanguage().catch(() => undefined)) === "de";
  const count = catalog.entries.length;
  const example = `rulebook_check(${JSON.stringify({ applicable: [], session_id: p.session_id, ...(p.agent_id ? { agent_id: p.agent_id } : {}) })})`;
  const correspondence=catalog.entries.filter(isCorrespondenceRule).map(e=>e.id);
  const taskNote = correspondence.length ? (de ?
    `Korrespondenz: Jede ID in dieser Runde ausdrücklich erklären: ${correspondence.slice(0,40).join(", ")}${correspondence.length>40?` (+${correspondence.length-40}; vollständige IDs mit list_rules)`:""}. Alternativ alle ungeschützten Korrespondenzregeln mit not_applicable:[{category:"correspondence",reason}] erklären. Regeln einer laufenden Entwurfs-/Kopieraufgabe oder dieser Runde bleiben verbindlich. Ein rulebook_check genügt: anwendbare IDs in applicable, jede übrige ID in not_applicable:[{id,reason}] mit mindestens 10 Zeichen Begründung. applicable:[] allein genügt nicht. Laden zählt als anwendbar; erklärte Validatoren prüfen die Antwort auch ohne Task. Nur der Nutzer kann freigeben.` :
    `Correspondence: explicitly decide every ID this round: ${correspondence.slice(0,40).join(", ")}${correspondence.length>40?` (+${correspondence.length-40}; get all IDs with list_rules)`:""}. Alternatively cover all unprotected correspondence rules with not_applicable:[{category:"correspondence",reason}]. Rules of a current review/copy task or loaded/applied this round remain binding. One rulebook_check suffices: applicable IDs plus every remaining ID in not_applicable:[{id,reason}], at least 10 substantive characters. applicable:[] alone is insufficient. Loading counts as applicable; declared validators check the answer even without task. Only the user can approve.`) : "";
  return [count ? (de ? `Regelbuch: ${count} Regeln im Index; vor der Antwort prüfen (load_memory oder ${example}, wenn keine zutrifft).` : `Rulebook: ${count} rules in the index; check before answering (load_memory or ${example} if none applies).`) : "",
    taskNote, blockedDismissals.length ? (de ? `Regelbuch-Abmeldung ignoriert; diese Aufgabenregeln oder in dieser Runde geladenen/angewandten Regeln bleiben verbindlich: ${blockedDismissals.join(", ")}.` : `Rulebook dismissal ignored; these task rules or rules loaded/applied this round remain binding: ${blockedDismissals.join(", ")}.`) : "", copyViolations ? (de ? `Korrespondenz: ${copyViolations} Verstöße gegen Kopiertext-Prüfgrenzen protokolliert.` : `Correspondence: ${copyViolations} copy-validator violations recorded.`) : "", exceptions.length ? (de ? `Regelbuch-Ausnahmen (nicht anwendbar): ${exceptions.join(", ")}.` : `Rulebook exceptions (not applicable): ${exceptions.join(", ")}.`) : "", unchecked ? (de ? `Regelbuch: ${unchecked} Prüfgrenzen blieben ungeprüft (Begrenzung oder Ausfall).` : `Rulebook: ${unchecked} unchecked boundary observations (retry cap or outage).`) : ""].filter(Boolean).join("\n");
}
const ExceptionReason = z.string().trim().min(10).max(500).regex(/[\p{L}\p{N}]/u, "Explain non-applicability with substantive text.");
export const RulebookCheckArgs = z.object({ applicable: z.array(z.string().min(1)).max(10000),
  not_applicable: z.array(z.union([z.object({id:z.string().min(1),reason:ExceptionReason}).strict(), z.object({category:z.literal("correspondence"),reason:ExceptionReason}).strict()])).max(10000).optional(),
  task: z.enum(["translate-only", "draft-for-review", "approved-copy", "none"]).optional(),
  agent_id: z.string().min(1).max(200).optional(),
  session_id: z.string().min(1).max(200).optional() }).strict();
export async function recordRulebookCheck(sessionId: string | null | undefined, input: z.infer<typeof RulebookCheckArgs>, catalog: KernelCandidates) {
  if (input.not_applicable?.some(e => !ExceptionReason.safeParse(e.reason).success)) return {ok:false,reason:"Non-applicability requires at least 10 characters of substantive explanation."};
  if (!sessionId) return { ok: false, reason: "Session unknown; no receipt recorded. Supply the session_id from your hook, or continue within the bounded gate." };
  let task = input.task;
  let taskError: string | undefined;
  if (task !== undefined && input.agent_id) taskError = "Worker task reports cannot change the main session task.";
  else if (task !== undefined && task !== "draft-for-review") taskError = "A model report may only tighten to draft-for-review. Approval, translation-only and task end require the user-turn path.";
  if (taskError) task = undefined;
  const ids = new Set(catalog.entries.map(e => e.id));
  if (input.applicable.some(id => !ids.has(id))) return { ok: false, reason: "Unknown rule IDs; read list_rules and retry." };
  let context = "", round = 0, taskGeneration = 0, invalidDismissal = false, actionException=false;
  const persisted = await mutateSessionState(sessionId, s => {
    if (task && s.activeTask?.kind === "translate-only") { taskError = "A model task report cannot replace the user's translate-only task."; task = undefined; }
    if (task && s.activeTask?.kind === "approved-copy") { taskError = "A model task report cannot remove the user-approved copy task and its receipt obligation."; task = undefined; }
    if (task !== undefined && new Set([
      ...(s.activeConventions ?? []).map(e => e.id), ...input.applicable,
    ]).size > ACTIVE_CONVENTIONS_CAP) { taskError = `Task rules exceed the existing ${ACTIVE_CONVENTIONS_CAP}-convention session capacity.`; task = undefined; }
    const state = read(s), a = actor(state, input.agent_id ? `agent:${input.agent_id}` : "main");
    const correspondence=catalog.entries.filter(isCorrespondenceRule);
    const protectedIds=new Set([...a.roundApplied,...(hasCopyTask(s)?[...(s.activeConventions??[]),...(s.loadedConventions??[])]:[])].map(r=>r.id));
    const requiredIds=new Set(a.required.map(r=>r.id));
    const skips=(input.not_applicable??[]).flatMap(e=>'id' in e?[e]:correspondence.filter(r=>!protectedIds.has(r.id)&&!requiredIds.has(r.id)&&!input.applicable.includes(r.id)).map(r=>({id:r.id,reason:e.reason})));
    const accepted=skips.filter(e=>{
      if(protectedIds.has(e.id)||input.applicable.includes(e.id)){
        invalidDismissal=true;state.unchecked++;
        state.blockedDismissals=[...new Set([...state.blockedDismissals,e.id])];return false;
      }
      if(!a.required.some(r=>r.id===e.id)&&!correspondence.some(r=>r.id===e.id)){invalidDismissal=true;return false;}
      return true;
    });
    for (const skip of accepted) {
      state.exceptions=[...new Set([...state.exceptions,skip.id])];
      const required=a.required.find(r=>r.id===skip.id);
      if(required){a.dismissed=[...a.dismissed.filter(r=>r.id!==skip.id),required].slice(-200);actionException=true;state.unchecked++;state.exceptions=[...new Set([...state.exceptions,skip.id])].slice(-200);}
      const entry=correspondence.find(r=>r.id===skip.id);
      if(entry)a.roundDismissed=[...a.roundDismissed.filter(r=>r.id!==skip.id),{id:entry.id,revision:entry.revision}];
      a.required=a.required.filter(r=>r.id!==skip.id);
    }
    for(const entry of correspondence.filter(e=>input.applicable.includes(e.id))){
      const prior=a.roundApplied.find(r=>r.id===entry.id)?.validator;
      const v=entry.validator;
      const validator=prior&&(!v||prior.channel!==v.channel||prior.unit!==v.unit||prior.limit<v.limit)?prior:v;
      a.roundApplied=[...a.roundApplied.filter(r=>r.id!==entry.id),{id:entry.id,revision:entry.revision,validator}];
      a.roundDismissed=a.roundDismissed.filter(r=>r.id!==entry.id);
    }
    a.checked = true; a.ids = [...new Set(input.applicable)];
    if (task !== undefined) {
      const now = Date.now();
      const beforeConventions = s.activeConventions;
      const startingTask = task !== (s.activeTask?.kind ?? "none");
      if (startingTask) {
        if(s.activeTask&&s.activeTask.kind!=="none")delete s.userValidatorChannel;
        s.activeTask = { id: taskIdFor(task, now), kind: task, since: now, generation: s.activeTask?.generation ?? 0, ...(s.userValidatorChannel?{validatorChannel:s.userValidatorChannel}:{}) };
        expireReceipts(s);
      }
      // A model report only adds stricter review obligations.
      // The transitional user-turn path owns approval/end/translation changes.
      if (task !== "none") recordActiveConventions(s, catalog.entries.filter(e => input.applicable.includes(e.id)).map(e => ({
        id: e.id, revision: e.revision, scope: "task" as const, validator: e.validator,
      })), now);
      if (JSON.stringify((s.activeConventions ?? []).map(e => [e.id,e.revision,e.validator])) !==
          JSON.stringify((beforeConventions ?? []).map(e => [e.id,e.revision,e.validator]))) {
        delete s.receipts;
      }
      taskGeneration = s.activeTask?.generation ?? 0;
      delete s.correspondenceContext;
    }
    context = state.context; round = state.round; put(s, state);
  });
  if (invalidDismissal) { await recordRulebookEvent(sessionId,{outcome:"not-applicable",exceptions:input.not_applicable,violation:true}); return {ok:false,reason:"Only an outstanding action ID or current correspondence ID can be dismissed. A current review/copy task rule or a rule loaded/declared applicable this round cannot be weakened. Valid remaining declarations were recorded."}; }
  if (persisted&&input.not_applicable?.length) await recordRulebookEvent(sessionId,{outcome:"not-applicable",exceptions:input.not_applicable,violation:actionException});
  await recordRulebookEvent(sessionId, { outcome: persisted ? "checked" : "fail-open", context, round, ids: input.applicable });
  if (persisted && taskError) return { ok: false, reason: `${taskError} Task unchanged; valid rule declarations were recorded.`, context, round };
  return persisted ? { ok: true, context, round, applicable: input.applicable, ...(input.task !== undefined ? { task: { kind: input.task, generation: taskGeneration },
      conventions: catalog.entries.filter(e => input.applicable.includes(e.id)).map(e => ({id: e.id, revision: e.revision, validator: e.validator})) } : {}),
    contract: "Self-report for this session/context/round. Not action-bound; no guarantee of semantic application." } : { ok: false, reason: "State unavailable; gate remains bounded and fail-open." };
}
export async function rulebookCheckHandler(deps: ToolDeps, args: unknown, ctx: { sessionId?: string | null; project?: string | null; agentId?: string | null } = {}) {
  const parsed = RulebookCheckArgs.parse(args);
  const input = { ...parsed, ...(ctx.agentId !== undefined ? { agent_id: ctx.agentId ?? undefined } : {}) };
  const sid = ctx.sessionId ?? callerSessionStore.getStore() ?? input.session_id;
  const snapshot = sid ? await loadSessionState(sid) : undefined;
  const deadline = Date.now() + RULEBOOK_TOOL_BUDGET_MS;
  const opts = { project: ctx.project ?? null, active: snapshot?.activeConventions ?? [] };
  let catalog = await cachedRulebookCatalog(deps.vault, { ...opts, mode: input.task !== undefined ? "content" : "ids", budgetMs: RULEBOOK_TOOL_BUDGET_MS });
  if (input.applicable.some(id => !catalog.entries.some(e => e.id === id))) {
    // Retry the index once before rejecting an unknown ID. An unavailable
    // refresh must still return the original IDs answer, not throw a tool error.
    catalog = await withRulebookDeadline(() => collectRulebookCatalog(deps.vault, { ...opts, mode: input.task !== undefined ? "content" : "ids" }), deadline).catch(() => catalog);
  }
  return recordRulebookCheck(sid, input, catalog);
}
/** Only actual current full loads can answer binding/required IDs or retain validator metadata. */
export async function recordRulebookLoad(sessionId: string, id: string, agentId?: string | null,
  source?: import("./convention-source.js").ConventionSource): Promise<void> {
  if (!sessionId) return;
  await mutateSessionState(sessionId, s => {
    const state=read(s),a=actor(state,agentId?`agent:${agentId}`:"main");
    const obligated=a.required.some(r=>r.id===id);
    if(source&&!source.rulebookMetadata?.rulebook&&!source.validator&&!source.rulebookMetadata?.rule_categories?.includes("correspondence")&&!obligated)return;
    if (source?.rulebookMetadata?.rulebook || source?.validator || source?.rulebookMetadata?.rule_categories?.includes("correspondence") || obligated || !source) a.checked=true;
    if(!a.ids.includes(id))a.ids.push(id);
    if(source&&(source.validator||source.rulebookMetadata?.rule_categories?.includes("correspondence"))&&!source.hiddenFromPublic){
      a.roundApplied=[...a.roundApplied.filter(r=>r.id!==id),{id,revision:source.revision,validator:source.validator}];
      a.roundDismissed=a.roundDismissed.filter(r=>r.id!==id);
    }
    a.loaded=[...a.loaded.filter(r=>r.id!==id),{id,revision:source?.revision??null}].slice(-200);
    a.required=a.required.filter(r=>r.id!==id);
    if(!agentId && source){
      s.loadedConventions=[...(s.loadedConventions??[]).filter(r=>r.id!==id),{id,revision:source.revision,loadedAt:Date.now(),...(source.validator?{validator:source.validator}:{})}].slice(-200);
    }
    put(s,state);
  });
}
/** Structural action obligations are independent of the model's round self-report. */
export async function requireActionRules(p:RulebookPayload,refs:readonly {id:string;revision:string|null}[],deadline?:number):Promise<void>{
 if(!p.session_id)return;
 const persisted=await mutateSessionState(p.session_id,s=>{
  const state=read(s),a=actor(state,identity(p));
  for(const ref of refs){
   const loaded=a.loaded.some(r=>r.id===ref.id&&(ref.revision===null||r.revision===ref.revision)) ||
    (identity(p)==="main" && s.loadedConventions?.some(r=>r.id===ref.id&&(ref.revision===null||r.revision===ref.revision)));
   const dismissed=a.dismissed.some(r=>r.id===ref.id&&r.revision===ref.revision);
   if(loaded||dismissed){a.required=a.required.filter(r=>r.id!==ref.id);continue;}
   a.required=[...a.required.filter(r=>r.id!==ref.id),ref];
  }
  put(s,state);
 },{deadline});
 if(!persisted)void spoolRulebookFailure(p.session_id).catch(()=>{});
}
export type CatalogProvider = (active: readonly import("./session-state.js").ActiveConvention[], project: string | null, mode?: RulebookCatalogMode) => Promise<KernelCandidates>;
const catalogRetry = new Map<string, number>();
export async function catalogFor(p: RulebookPayload, kernel: CatalogProvider) {
  const key = JSON.stringify([p.session_id ?? "", p.cwd ?? ""]);
  if ((catalogRetry.get(key) ?? 0) > Date.now()) throw new Error("rulebook_catalog_backoff");
  try { return await withRulebookDeadline(async () => {
    const state = p.session_id ? await loadSessionState(p.session_id) : undefined;
    return kernel(state?.activeConventions ?? [], projectForLane(p.cwd || process.cwd()), "ids");
  }); } catch (error) {
    if (catalogRetry.size >= 512) catalogRetry.delete(catalogRetry.keys().next().value!);
    catalogRetry.set(key, Date.now() + 5000); throw error;
  }
}
/** Undefined means C did not apply; {} permits the legacy lanes to run.
 * Legacy denials retain their own once-per-claim/session contract. */
export type RulebookDenialReceipt = (delivered: boolean) => Promise<void>;
export async function rulebookBoundary(p: RulebookPayload, catalog: KernelCandidates, boundary: "action" | "stop", options: {
  requiredOnly?: boolean; deadline?: number; onDenial?: (settle: RulebookDenialReceipt) => void | Promise<void>;
} = {}): Promise<string | undefined> {
  if (!hookGateAvailable(p)) return undefined;
  if (!catalog.entries.some(e => boundary === "action" || e.rulebook === "on-demand" || isCorrespondenceRule(e))) return undefined;
  if (boundary === "stop" && !["claude-code", "codex"].includes(hookClientEvidence(p))) return undefined;
  if (!p.session_id) { await spoolRulebookFailure(null); return "{}"; }
  let deny = false, unchecked = false, context = "", round = 0, requiredIds:string[]=[];
  const persisted = await mutateSessionState(p.session_id, s => {
    const state = read(s), a = actor(state, identity(p));
    context = state.context; round = state.round;
    requiredIds=boundary==="action"?a.required.map(r=>r.id):catalog.entries.filter(isCorrespondenceRule).filter(e=>!roundCorrespondence(s,p).rules.some(r=>r.id===e.id)&&!a.roundDismissed.some(r=>r.id===e.id)).map(e=>e.id);
    if ((!options.requiredOnly&&!a.checked) || requiredIds.length) {
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
      // Rollback is bookkeeping, never part of the response's latency budget.
      void mutateSessionState(p.session_id!, s => {
        const current = read(s);
        if (current.context !== context || current.round !== round) return;
        const a = current.actors.find(a => a.key === identity(p));
        if (a) a.denies = Math.max(0, a.denies - 1);
        put(s, current);
      }).then(ok => {
        if (!ok) void recordRulebookEvent(p.session_id!, { boundary, outcome: "rollback-failed" });
      }).catch(() => { void recordRulebookEvent(p.session_id!, { boundary, outcome: "rollback-failed" }); });
    });
  }
  if (!persisted) { await spoolRulebookFailure(p.session_id); await recordRulebookEvent(p.session_id, { boundary, outcome: "fail-open" }); return "{}"; }
  if (deny || unchecked) await recordRulebookEvent(p.session_id, { boundary, outcome: deny ? "deny" : "unchecked", agent_known: identity(p) !== "unattributed" });
  if (!deny) return "{}";
  const de = (await getPrimaryLanguage().catch(() => undefined)) === "de";
  const attribution = identity(p) === "unattributed" ? (de ? " Zuordnung fehlt; eigener Rundenbeleg nötig, maximal zwei Ablehnungen." : " Agent attribution missing; a main-thread receipt cannot be inherited. At most two denials.") : "";
  const example = `rulebook_check(${JSON.stringify({ applicable: [], session_id: p.session_id, ...(p.agent_id ? { agent_id: p.agent_id } : {}) })})`;
  const loadExample=JSON.stringify({id:requiredIds[0]??"rule-id",session_id:p.session_id,...(p.agent_id?{agent_id:p.agent_id}:{})});
  const reason = boundary==="stop"&&requiredIds.length ? `Correspondence declarations missing for this round: ${requiredIds.slice(0,40).join(", ")}${requiredIds.length>40?` (+${requiredIds.length-40}; list_rules contains all IDs)`:""}. In one rulebook_check, use not_applicable:[{category:"correspondence",reason}] for all unprotected correspondence IDs, or explicitly list every applicable ID and every remaining ID in not_applicable:[{id,reason}] (at least 10 substantive characters). Loading a rule declares it applicable. applicable:[] alone cannot discharge these IDs. Do not infer approval or permission to send.` : requiredIds.length ? `MUST-LOAD — concrete action rules: ${requiredIds.slice(0,20).join(", ")}${requiredIds.length>20?` (+${requiredIds.length-20}; read the complete category catalog with list_rules)`:""}. Load each with load_memory(${loadExample}) (replace id for each requirement). applicable:[] cannot discharge these IDs. An explicit rulebook_check({not_applicable:[{id,reason}],applicable:[]}) for each exact ID records a visible exception.` : (de ? `Prüfe den Regelbuch-Index gegen diese Runde. Lade passende Regeln und überarbeite die Antwort, oder rufe ${example} auf, wenn keine zutrifft.` : `Check the rulebook index against this round. Load applicable rules and revise the answer, or call ${example} if none applies.`) + attribution;
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

/** Validators imply correspondence structurally, including legacy rules. */
export function isCorrespondenceRule(e:{validator?:unknown;rule_categories?:readonly string[]}):boolean{
 return !!e.validator||!!e.rule_categories?.includes("correspondence");
}
function hasCopyTask(state:Pick<import("./session-state.js").ReadonlySessionState,"activeTask">):boolean{
 return state.activeTask?.kind==="draft-for-review"||state.activeTask?.kind==="approved-copy";
}
export function roundCorrespondence(state:Pick<import("./session-state.js").ReadonlySessionState,"rulebookCheck"|"loadedConventions"|"activeConventions"|"activeTask">,p:RulebookPayload={bastra_client:"claude-code"}){
 const value=read(state),a=value.actors.find(a=>a.key===identity(p));
 const rules=[...(a?.roundApplied??[])];
 if(identity(p)==="main"&&hasCopyTask(state))for(const loaded of [...(state.loadedConventions??[]),...(state.activeConventions??[])]){
  const validator=ConventionValidatorSchema.safeParse(loaded.validator);
  if(validator.success&&!rules.some(r=>r.id===loaded.id))rules.push({id:loaded.id,revision:loaded.revision,validator:validator.data});
 }
 return {key:`${value.context}:${value.round}:${identity(p)}`,round:value.round,rules,dismissed:(a?.roundDismissed??[]).map(r=>r.id),repairs:a?.repairs??0,repairProse:a?.repairProse??false};
}
/** Called only under the existing bounded Stop state claim. */
export function claimRoundRepair(state:SessionState,p:RulebookPayload,key:string,observeOnly=false,minimum=0,proseIsCopy=true):number|null{
 const current=roundCorrespondence(state,p);if(current.key!==key||current.repairs>2)return null;
 const value=read(state),a=actor(value,identity(p)),count=Math.max(a.repairs,minimum);if(count>2)return null;
 if(a.repairs===0)a.repairProse=proseIsCopy;
 a.repairs=observeOnly?3:count+1;
 if(observeOnly||count===2){value.copyViolations++;value.unchecked++;}
 put(state,value);return count;
}
export function refreshRoundValidators(state:SessionState,before:{readonly rulebookCheck?:string},sources:ReadonlyMap<string,import("./convention-source.js").ConventionSource>):void{
 const value=read(state),old=read(before);if(value.context!==old.context||value.round!==old.round)return;
 for(const a of value.actors)for(const rule of a.roundApplied){
  if(!old.actors.find(prior=>prior.key===a.key)?.roundApplied.some(r=>r.id===rule.id&&r.revision===rule.revision))continue;
  const source=sources.get(rule.id);if(!source)continue;
  rule.revision=source.revision;
  if(source.validator&&!source.hiddenFromPublic)rule.validator=source.validator;else delete rule.validator;
 }
 put(state,value);
}
