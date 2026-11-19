/**
 * In-memory stand-in for the daemon's task store, used ONLY by the deterministic P2
 * characterization mode (#1649). It is not the feature and proves nothing about it:
 * it gives the real P2 driver plausible, fully reproducible answers so that the
 * driver's own request sequence and computed values can be pinned before #1531
 * restructures it. Every time value comes from the caller's clock; nothing here
 * reads the wall clock or draws random numbers.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

interface Schedule {
  kind: string;
  at: number;
  local_time?: string;
  offset_minutes?: number;
  [key: string]: unknown;
}
interface Recurrence {
  kind: "calendar" | "elapsed";
  interval: number;
  count: number;
  catch_up?: string;
}
export interface Task {
  id: string;
  expected_revision: string;
  state: "pending" | "due" | "resolved" | "cancelled";
  armed: boolean;
  action_level: string;
  generation: number;
  schedule: Schedule;
  recurrence?: Recurrence;
  next_slot?: { at: number };
  next_slot_index: number;
  snoozed_until?: number;
  created_by: string;
  idempotency_key: string;
  request_sha256: string;
  history: Array<Record<string, unknown>>;
  [key: string]: unknown;
}
interface Occurrence {
  id: string;
  task_id: string;
  generation: number;
  due_at: number;
  missed_count: number;
  fired_at: number;
  attempts: Array<Record<string, unknown>>;
  acknowledgement?: Record<string, unknown>;
  resolution?: Record<string, unknown>;
}
interface TaskEvent {
  id: string;
  source_id: string;
  actor: string;
  owner_domains: string[];
  value_sha256: string;
  [key: string]: unknown;
}
export interface Store {
  schema_version: number;
  tasks: Task[];
  occurrences: Occurrence[];
  events: TaskEvent[];
  sources: Array<Record<string, unknown> & { id: string }>;
  source_state: Record<string, string>;
  clock_high_water: number | null;
  counters: { task: number; revision: number; event: number };
}

export class StoreUnavailable extends Error {
  constructor(readonly code: "corrupt" | "unsupported_version") {
    super(code);
  }
}

const emptyStore = (): Store => ({
  schema_version: 1,
  tasks: [],
  occurrences: [],
  events: [],
  sources: [],
  source_state: {},
  clock_high_water: null,
  counters: { task: 0, revision: 0, event: 0 },
});

export function loadStore(path: string): Store {
  if (!existsSync(path)) return emptyStore();
  let parsed: Store;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new StoreUnavailable("corrupt");
  }
  if (parsed.schema_version !== 1) throw new StoreUnavailable("unsupported_version");
  return parsed;
}

/** Every write keeps the previous bytes as `.backup`, like the published P1 store. */
export function saveStore(path: string, store: Store) {
  if (existsSync(path)) copyFileSync(path, `${path}.backup`);
  writeFileSync(path, JSON.stringify(store), { mode: 0o600 });
}

export function bumpRevision(store: Store, task: Task, entry: Record<string, unknown>) {
  task.expected_revision = `rev-${++store.counters.revision}`;
  task.history.push(entry);
}

// Europe/Madrid under the EU rule: CEST (+120) from the last Sunday of March 01:00 UTC
// to the last Sunday of October 01:00 UTC, CET (+60) otherwise. Pure arithmetic, so the
// result does not depend on the ICU time-zone data of the machine.
function lastSundayUtc(year: number, month: number) {
  const last = Date.UTC(year, month + 1, 0, 1);
  return last - new Date(last).getUTCDay() * 86400000;
}
function madridOffsetMinutes(at: number) {
  const year = new Date(at).getUTCFullYear();
  return at >= lastSundayUtc(year, 2) && at < lastSundayUtc(year, 9) ? 120 : 60;
}
/** Local wall time to instant; `undefined` for a local time the DST gap skips. */
export function madridInstant(localTime: string, overlap: string) {
  const local = Date.parse(`${localTime}Z`);
  const candidates = [120, 60]
    .map((offset) => local - offset * 60000)
    .filter((at) => madridOffsetMinutes(at) * 60000 === local - at);
  if (!candidates.length) return undefined;
  const at = overlap === "later" ? candidates.at(-1)! : candidates[0];
  return { at, offset_minutes: madridOffsetMinutes(at) };
}
function addDays(localTime: string, days: number) {
  return new Date(Date.parse(`${localTime}Z`) + days * 86400000).toISOString().slice(0, 19);
}

function slotAt(task: Task, index: number) {
  if (task.schedule.kind !== "calendar" || index === 0) {
    return task.schedule.at + index * (task.recurrence?.kind === "elapsed" ? task.recurrence.interval : 0);
  }
  const days = index * (task.recurrence?.interval ?? 1);
  return madridInstant(addDays(task.schedule.local_time!, days), "earlier")?.at ?? Number.POSITIVE_INFINITY;
}
export function resetSlots(task: Task) {
  task.next_slot_index = 0;
  task.next_slot = { at: slotAt(task, 0) };
}

function fireDue(store: Store, task: Task, now: number) {
  const count = task.recurrence?.count ?? 1;
  const due: number[] = [];
  for (let i = task.next_slot_index; i < count && slotAt(task, i) <= now; i++) due.push(i);
  if (!due.length) return false;
  const last = due.at(-1)!;
  store.occurrences.push({
    id: `${task.id}:g${task.generation}:s${last}`,
    task_id: task.id,
    generation: task.generation,
    due_at: slotAt(task, last),
    missed_count: due.length - 1,
    fired_at: now,
    attempts: [],
  });
  task.next_slot_index = last + 1;
  task.next_slot = last + 1 < count ? { at: slotAt(task, last + 1) } : undefined;
  if (!task.next_slot) task.state = "due";
  return true;
}

/** Fire armed, unsnoozed, pending tasks whose next slot has passed; a clock rollback fires nothing. */
export function reconcile(store: Store, now: number) {
  if (store.clock_high_water !== null && now < store.clock_high_water) return false;
  store.clock_high_water = now;
  let fired = false;
  for (const task of store.tasks) {
    if (!task.armed || task.state !== "pending" || (task.snoozed_until ?? 0) > now) continue;
    fired = fireDue(store, task, now) || fired;
  }
  return fired;
}
