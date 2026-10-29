/** Offline mechanical evidence; never a semantic compliance score (#1313). */
import { readEvents } from "./log-stats.js";
import { defaultLogDir } from "../telemetry.js";
import { isEvalTraffic } from "../telemetry-dimensions.js";

type Event = Record<string, unknown>;
export interface ConventionMemory {
  id: string;
  shown: boolean;
  loaded: boolean;
  saidAgain: number;
  /** Harvest only proves a stored match at harvest time, not at the repetition. */
  inVaultAtRepetition: "unknown";
}
export interface ConventionSession {
  session: string | null;
  session_known: boolean;
  shown: Set<string>;
  loaded: Set<string>;
  denied: number;
  timeouts: number;
  saidAgain: number;
  receipts: number;
  followed: "unknown" | "receipt" | "deny-cleared";
  gateAttempts: number;
  loadAttempts: number;
  failedLoads: number;
  unverifiedLoads: number;
  legacyUnattributedEvents: number;
  validationAttempts: number;
  failedValidations: number;
  unverifiedValidations: number;
  unattributedReceipts: number;
  repairExhausted: number;
  reportedRepairAttempts: number;
  unverifiedRepairAttemptCounts: number;
  memories: Map<string, ConventionMemory>;
  taskKinds: Set<string>;
  revisions: Set<string>;
  generations: Set<string>;
  firstVisible: Set<string>;
  repaired: Set<string>;
}
const str = (v: unknown): string | null => typeof v === "string" && v.length > 0 ? v : null;
const ids = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
const count = (v: unknown): number => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
function sessionOf(e: Event): string | null {
  if (e.session_known === false || e.kind === "receipt_unattributed") return null;
  if (e.kind === "load_memory" || e.kind === "convention_validation") return str(e.caller_session);
  if (e.kind === "session_harvest") return str(e.session_id);
  if (e.kind === "non_conformance") return e.session_known === true ? str(e.session_id) : null;
  const dimensions = e.dimensions as Record<string, unknown> | undefined;
  // Legacy hook clients minted a random session_id on missing attribution.
  // A nonempty UUID by itself therefore cannot establish a caller session.
  if (e.session_known === true || str(dimensions?.experiment_session)) return str(e.session_id);
  return null;
}
function fresh(session: string | null): ConventionSession {
  return { session, session_known: session !== null, shown: new Set(), loaded: new Set(), denied: 0, timeouts: 0,
    saidAgain: 0, receipts: 0, followed: "unknown", gateAttempts: 0, loadAttempts: 0, failedLoads: 0, unverifiedLoads: 0, legacyUnattributedEvents: 0,
    validationAttempts: 0, failedValidations: 0, unverifiedValidations: 0, unattributedReceipts: 0, repairExhausted: 0, reportedRepairAttempts: 0, unverifiedRepairAttemptCounts: 0, memories: new Map(),
    taskKinds: new Set(), revisions: new Set(), generations: new Set(), firstVisible: new Set(), repaired: new Set() };
}
function memory(row: ConventionSession, id: string): ConventionMemory {
  let item = row.memories.get(id);
  if (!item) { item = { id, shown: false, loaded: false, saidAgain: 0, inVaultAtRepetition: "unknown" }; row.memories.set(id, item); }
  return item;
}

export function aggregateConventions(events: Event[]): ConventionSession[] {
  const rows = new Map<string | null, ConventionSession>();
  const pending = new Map<string, Set<string>[]>();
  const sorted = [...events].sort((a, b) => Date.parse(String(a.ts)) - Date.parse(String(b.ts)));
  for (const e of sorted) {
    const kind = String(e.kind);
    const hookShown = /^(session|prompt|bash|bash_fail|todo)_hook_call$/.test(kind) || kind === "hook_call";
    const gate = kind === "gate_hook_call" || /^(gate_deny|gate_pass|gate_timeout)$/.test(kind);
    const repairExhausted = kind === "non_conformance" && e.reason === "repair_exhausted";
    if (!hookShown && !gate && !repairExhausted && !["convention_shown", "load_memory", "session_harvest", "convention_validation", "receipt_unattributed"].includes(kind)) continue;
    if (hookShown && ids(e.hinted_ids).length === 0) continue;
    const session = sessionOf(e);
    let row = rows.get(session);
    if (!row) { row = fresh(session); rows.set(session, row); }
    for (const [field, target] of [["task_kind", row.taskKinds], ["rule_revision", row.revisions], ["generation", row.generations], ["first_visible_result", row.firstVisible], ["repaired_result", row.repaired]] as const) {
      const value = typeof e[field] === "number" ? String(e[field]) : str(e[field]);
      if (value !== null) target.add(value);
    }
    if (hookShown || kind === "convention_shown") {
      for (const id of ids(kind === "convention_shown" ? e.memory_ids : e.hinted_ids)) {
        row.shown.add(id); memory(row, id).shown = true;
      }
    }
    if (kind === "load_memory") {
      row.loadAttempts++;
      const id = str(e.id);
      // found also occurs on privacy-denied legacy loads; delivered bytes are
      // the evidence that this caller actually received a memory.
      const delivered = e.found === true && typeof e.delivered_chars === "number";
      if (e.found === false) row.failedLoads++;
      else if (!delivered) row.unverifiedLoads++;
      if (delivered && id) {
        row.loaded.add(id); memory(row, id).loaded = true;
        if (session !== null) {
          const groups = pending.get(session) ?? [];
          let cleared = false;
          for (const group of groups) if (group.delete(id) && group.size === 0) cleared = true;
          pending.set(session, groups.filter(group => group.size > 0));
          if (cleared && row.followed !== "receipt") row.followed = "deny-cleared";
        }
      }
    }
    if (gate) {
      row.gateAttempts++;
      if (e.outcome === "deny" || kind === "gate_deny") {
        row.denied++;
        if (session !== null) {
          const groups = pending.get(session) ?? [];
          // Each deny is its own claim group. Every required ID in it must be
          // delivered before that interruption has mechanical load evidence.
          const claim = new Set(ids(e.must_load_ids));
          if (claim.size > 0) groups.push(claim);
          pending.set(session, groups);
        }
      }
      if (kind === "gate_timeout" || e.non_conformance === "gate_timeout" || e.error === "timeout") row.timeouts++;
    }
    if (kind === "session_harvest") {
      row.saidAgain += count(e.stored_count);
      for (const id of ids(e.stored_memory_ids)) memory(row, id).saidAgain++;
    }
    if (kind === "convention_validation") {
      row.validationAttempts++;
      if (e.result === "fail") row.failedValidations++;
      else if (e.result !== "pass") row.unverifiedValidations++;
      if (e.result === "pass" && str(e.receipt)) {
        row.receipts++;
        if (session !== null && e.receipt_stored === true) row.followed = "receipt";
        if (session === null) row.unattributedReceipts++;
      }
    }
    if (repairExhausted) {
      row.repairExhausted++;
      // The stop producer reports its bounded attempt count, not a complete
      // end-to-end attempt ledger. Keep this series separate and lower-bound.
      if (typeof e.attempts === "number" && Number.isInteger(e.attempts) && e.attempts >= 0) row.reportedRepairAttempts += e.attempts;
      else row.unverifiedRepairAttemptCounts++;
    }
    // Older lines have no matching validation attempt: keep the unknown
    // attribution visible without inventing a task or successful followed join.
    if (kind === "receipt_unattributed") row.legacyUnattributedEvents++;
  }
  return [...rows.values()].sort((a, b) => (a.session ?? "").localeCompare(b.session ?? ""));
}
const values = (set: Set<string>): string => set.size ? [...set].sort().join(",") : "unknown";
export function renderConventions(rows: ConventionSession[]): string {
  const out = ["conventions — mechanical evidence only; followed is not semantic compliance",
    "shown/loaded count distinct memory IDs per session; attempts include failed/unverified outcomes.",
    "said-again = exact-wording stored match at harvest, not proof the rule existed when repeated. Unknown-session events are not joined."];
  if (!rows.length) out.push("(no convention evidence in this window — try --since 7d)");
  for (const r of rows) {
    out.push(`session=${r.session ?? "unknown"} session_known=${r.session_known} shown=${r.shown.size} loaded=${r.loaded.size} denied=${r.denied} timeouts=${r.timeouts} said-again=${r.saidAgain} receipts=${r.receipts} followed: ${r.followed} task=${values(r.taskKinds)} revision=${values(r.revisions)} generation=${values(r.generations)} first-visible=${values(r.firstVisible)} repaired=${values(r.repaired)} gate-attempts=${r.gateAttempts} load-attempts=${r.loadAttempts} failed-loads=${r.failedLoads} unverified-loads=${r.unverifiedLoads} validator-attempts=${r.validationAttempts} failed-validations=${r.failedValidations} unverified-validations=${r.unverifiedValidations} unattributed-receipts=${r.unattributedReceipts} legacy-unattributed-events=${r.legacyUnattributedEvents} repair-exhausted=${r.repairExhausted} repair-attempts-reported-lower-bound=${r.reportedRepairAttempts} repair-attempt-counts-unknown=${r.unverifiedRepairAttemptCounts}`);
    for (const m of r.memories.values()) if (m.saidAgain > 0) out.push(`  memory=${m.id} said-again=${m.saidAgain} in-vault-at-repetition=unknown stored-match-at-harvest=yes shown=${r.session_known && m.shown ? "yes" : "unknown"} loaded=${r.session_known && m.loaded ? "yes" : "unknown"} followed=unknown`);
  }
  const sum = (f: (r: ConventionSession) => number) => rows.reduce((n, r) => n + f(r), 0);
  out.push(`total sessions=${rows.filter(r => r.session_known).length} unknown-buckets=${rows.some(r => !r.session_known) ? 1 : 0} shown=${sum(r => r.shown.size)} loaded=${sum(r => r.loaded.size)} denied=${sum(r => r.denied)} timeouts=${sum(r => r.timeouts)} said-again=${sum(r => r.saidAgain)} receipts=${sum(r => r.receipts)} gate-attempts=${sum(r => r.gateAttempts)} load-attempts=${sum(r => r.loadAttempts)} validator-attempts=${sum(r => r.validationAttempts)} failed-validations=${sum(r => r.failedValidations)} unverified-validations=${sum(r => r.unverifiedValidations)} repair-exhausted=${sum(r => r.repairExhausted)} repair-attempts-reported-lower-bound=${sum(r => r.reportedRepairAttempts)} repair-attempt-counts-unknown=${sum(r => r.unverifiedRepairAttemptCounts)}`);
  out.push("No end-to-end success rate: absent evidence stays unknown; first-visible and repair outcomes require explicit delivery telemetry.");
  return out.join("\n");
}

export async function cmdConventions(opts: { sinceMs: number; includeEval?: boolean; logDir?: string; write?: (text: string) => void }): Promise<number> {
  const all = await readEvents(opts.logDir ?? defaultLogDir(), Date.now() - opts.sinceMs);
  const events = opts.includeEval ? all : all.filter(e => !isEvalTraffic(e));
  const output = renderConventions(aggregateConventions(events));
  (opts.write ?? ((text: string) => process.stdout.write(text)))(output + "\n");
  return 0;
}
