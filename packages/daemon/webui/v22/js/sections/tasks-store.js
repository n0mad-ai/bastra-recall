// Tasks area — UI state, daemon snapshot and the user actions. The stage
// (tasks.js) and the panel tabs (tasks-panel.js) subscribe via onTasks().
// Actions are the old UI's (webui/js/tasks.js) on the same endpoints.
import { t } from "../i18n.js";
import { state, setState } from "../state.js";
import { api, mutate, itemsOf, canMove, isTerminal, scheduleAt, fmtAt, BROWSER_TZ, createInput, loadWeatherDays } from "./tasks-api.js";

const SAVE_KEY = "recall-v22-tasks";
const saved = (() => { try { return JSON.parse(localStorage.getItem(SAVE_KEY) || "{}"); } catch { return {}; } })();

export const blankForm = () => ({ goal: "", timing: "after", when: "7d", tz: BROWSER_TZ, domain: "personal", level: "notify", every: "", count: "3", expires: "", arm: false });

export const S = {
  snap: null,          // last task_status answer
  error: "",           // load error (daemon down, tasks disabled)
  cold: [],            // tasks loaded from an archive
  items: [],           // itemsOf(snap, cold)
  sel: null,           // selected item id
  compose: false, showDue: false, due: null, dueBusy: false, duePending: 0, dueBlocked: 0,
  F: blankForm(),
  view: saved.view === "month" ? "month" : "week",
  off: 0, miniD: 0,
  hide: saved.hide && typeof saved.hide === "object" ? saved.hide : {},
  style: typeof saved.style === "string" ? saved.style : "ledger", // checked against the registry on use (tasks-styles.js)
  agenda: !!saved.agenda,
  drag: null,          // id of the item being dragged
  edit: null,          // { id, kind: "goal" | "expires" | "snooze" | "prepare" } — inline form in the detail panel
  proposal: null,      // proposal pop-over data (task_prepare / task_proposal / task_rollback_prepare answer)
  propNote: "",
  tech: false,
  W: 900,              // stage width (prototype W)
};

const listeners = new Set();
export function onTasks(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function emit(what = "all") { for (const fn of listeners) fn(what); }

export function save() {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify({ style: S.style, view: S.view, agenda: S.agenda, hide: S.hide })); } catch { /* storage blocked */ }
}

/** Notices: detail panel bottom while the panel is open, toast otherwise (js/main.js, js/lens.js). */
export function say(msg) { setState({ toast: "" }); setState({ toast: msg }); }

export const byId = (id) => S.items.find((x) => x.id === id);
export const role = () => S.snap?.role;

let request = 0;
export async function refresh(background = false) {
  const seq = ++request;
  try {
    const next = await api("status");
    if (seq !== request) return;
    if (!next || typeof next !== "object" || !Array.isArray(next.tasks)) throw new Error(t("tk.err.generic"));
    const changed = JSON.stringify(next) !== JSON.stringify(S.snap);
    S.snap = next; S.error = "";
    if (background && !changed) return;
    S.items = itemsOf(S.snap, S.cold);
    emit();
  } catch (e) {
    if (seq !== request) return;
    if (!S.snap || !background) { S.error = e.message; emit(); }
  }
}

export async function loadWeather() { if (await loadWeatherDays()) emit(); }

/** Runs a user action; the notice goes to the panel/toast, the board refreshes afterwards. */
export async function act(fn, okMsg) {
  try {
    const msg = await fn();
    await refresh();
    if (msg || okMsg) say(msg || okMsg);
  } catch (e) { say(e.message); refresh(); }
}

/** Opens the Tasks area with this task selected (dashboard widgets, header
 *  ticker). The id is the daemon task id, which is the item id of a live task. */
export function openTask(id) {
  select(typeof id === "string" ? id : null, { view: "tasks", hover: null, vpOpen: false });
}

export function select(id, extra = {}) {
  S.sel = id; S.edit = null;
  setState({ tab: "areas", lensOpen: true, ...(state.vw < 1400 ? { lensPeek: true } : {}), ...extra });
  emit();
}

// ── lifecycle (old UI moveTask / mutate) ──────────────────────────────────
const updated = () => t("tk.msg.updated");
export function lifecycle(x, op, extra) {
  return act(async () => { await mutate(x.t.id, op, extra); return op === "rearm" ? t("tk.msg.rearmed") : op === "cancel" ? t("tk.msg.cancelled") : op === "resolve" ? t("tk.msg.resolved") : updated(); });
}

/** Board/column move: planned → rearm, done → resolve, failed → cancel, snoozed → ask for the time in the panel. */
export function moveTo(x, target) {
  if (!canMove(x.t, target)) { say(t("tk.msg.noDrop")); return; }
  if (target === "planned") return lifecycle(x, "rearm");
  if (target === "done") return lifecycle(x, "resolve");
  if (target === "failed") return lifecycle(x, "cancel");
  if (target === "snoozed") { select(x.id); S.edit = { id: x.id, kind: "snooze" }; emit(); }
}

export const review = (x) => act(async () => { await mutate(x.t.id, "review"); return t("tk.msg.armed"); });

/** Calendar drop: a real schedule change through task_edit (same API the old UI uses for edits). */
export function moveDue(id, at) {
  const x = byId(id);
  if (!x) return;
  const task = x.t;
  if (task.archived || isTerminal(task) || task.schedule.kind === "event") { say(t("tk.msg.noDrop")); return; }
  if (!Number.isFinite(at) || at <= Date.now() - 60000) { say(t("tk.msg.past")); return; }
  return act(async () => {
    const schedule = scheduleAt(at, task.timezone);
    await mutate(task.id, "edit", { patch: { schedule } });
    return t("tk.msg.moved", { due: fmtAt(schedule.at, task.timezone) });
  });
}

export function create() {
  let built;
  try { built = createInput(S.F, role()); } catch (e) { say(e.message); return; }
  return act(async () => {
    const res = await api("create", built.input);
    S.compose = false; S.F = { ...S.F, goal: "", expires: "" };
    if (res && typeof res.id === "string") S.sel = res.id;
    return built.note || t("tk.msg.created");
  });
}

export async function openDue() {
  S.showDue = true; S.compose = false; S.dueBusy = true; emit();
  try {
    const d = await api("due", { include_acknowledged: true, max_bytes: 16384 });
    S.due = Array.isArray(d.cards) ? d.cards : [];
    S.duePending = Number.isFinite(d.pending) ? d.pending : 0; S.dueBlocked = Number.isFinite(d.retry_blocked) ? d.retry_blocked : 0;
  }
  catch (e) { S.due = []; say(e.message); }
  S.dueBusy = false; emit();
}

export async function showProposal(data) {
  if (!data || !data.proposal) { say(t("tk.err.generic")); return; }
  S.proposal = data; S.propNote = ""; S.compose = false; S.showDue = false; emit();
}

/** Old UI "Änderung ausführen": lease → execute → release. */
export async function executeProposal() {
  const data = S.proposal; if (!data) return;
  let res;
  try {
    res = await api("lease", { proposal_id: data.proposal.id });
    const r = await api("execute", { proposal_id: data.proposal.id, lease_id: res.lease.id, holder_token: res.holder_token, fence: res.lease.fence, idempotency_key: crypto.randomUUID() });
    S.propNote = t("tk.prop.result", { state: t(`tk.outcome.${r.state}`), intent: r.intent_id ?? "—", receipt: r.receipt?.id || t("tk.prop.noReceipt") });
    emit(); await refresh();
  } catch (e) { say(e.message); }
  finally { if (res?.lease) await api("release", { lease_id: res.lease.id, holder_token: res.holder_token, fence: res.lease.fence }).catch(() => {}); }
}

export function controls(patch) {
  return act(async () => { await api("controls", patch); return t("tk.msg.controls"); });
}

export async function loadArchive(id) {
  return act(async () => {
    const d = await api("list", { archive_id: id });
    S.cold = (Array.isArray(d.tasks) ? d.tasks : []).map((x) => ({ ...x, archived: true, archive_id: id, deliveries: [] }));
    return t("tk.msg.archive", { n: S.cold.length });
  });
}
