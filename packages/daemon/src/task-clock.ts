/** Deterministic calendar resolver: gap reject, overlap earlier, persisted instants. */
import type { Task } from "./task-schema.js";
export function localWall(at: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(at);
  const get = (key: string) => parts.find(p => p.type === key)!.value;
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
}
export function resolveTaskCalendar(local: string, timezone: string): { at: number; offset_minutes: number } {
  const wall = Date.parse(`${local}Z`);
  if (!Number.isFinite(wall) || new Date(wall).toISOString().slice(0, 19) !== local) throw new Error("invalid calendar wall time");
  const offsets = new Set<number>();
  for (let hours = -36; hours <= 36; hours += 6) {
    const sample = wall + hours * 3600000;
    offsets.add(Date.parse(`${localWall(sample, timezone)}Z`) - sample);
  }
  const candidates = [...offsets].map(offset => ({ at: wall - offset, offset_minutes: offset / 60000 }))
    .filter(c => c.at >= 0 && Number.isInteger(c.offset_minutes) && localWall(c.at, timezone) === local).sort((a, b) => a.at - b.at);
  if (!candidates.length) throw new Error("calendar time is in a DST gap");
  return candidates[0];
}
function shiftedWall(local: string, days: number): string { return new Date(Date.parse(`${local}Z`) + days * 86400000).toISOString().slice(0, 19); }
export function timeSlot(task: Task, index: number): { at: number; key: string; local_time?: string; offset_minutes?: number } {
  if (task.schedule.kind === "event") throw new Error("event has no time slot");
  if (!task.recurrence || index === 0) {
    return { at: task.schedule.at, key: task.schedule.kind === "calendar" ? task.schedule.local_time : String(task.schedule.at) };
  }
  if (task.recurrence.kind === "calendar") {
    if (task.schedule.kind !== "calendar") throw new Error("calendar recurrence requires calendar schedule");
    const local_time = shiftedWall(task.schedule.local_time, task.recurrence.interval * index);
    return { ...resolveTaskCalendar(local_time, task.timezone), local_time, key: local_time };
  }
  const at = task.schedule.at + task.recurrence.interval * index;
  if (!Number.isSafeInteger(at)) throw new Error("recurrence instant overflow");
  return { at, key: String(at) };
}
export function latestTimeSlot(task: Task, now: number): { index: number; slot: ReturnType<typeof timeSlot> } | null {
  if (task.schedule.kind === "event" || task.schedule.at > now) return null;
  let index = 0;
  if (task.recurrence) {
    index = task.recurrence.kind === "elapsed" ? Math.floor((now - task.schedule.at) / task.recurrence.interval)
      : Math.floor((Date.parse(`${localWall(now, task.timezone)}Z`) - Date.parse(`${task.schedule.kind === "calendar" ? task.schedule.local_time : "invalid"}Z`)) / (task.recurrence.interval * 86400000));
    if (task.recurrence.count !== undefined) index = Math.min(index, task.recurrence.count - 1);
    if (task.recurrence.until !== undefined) {
      const end = latestTimeSlot({ ...task, recurrence: { ...task.recurrence, until: undefined } }, Math.min(now, task.recurrence.until));
      if (!end) return null; index = Math.min(index, end.index);
    }
  }
  index = Math.max(0, index);
  let slot = timeSlot(task, index);
  if (slot.at > now && index > 0) slot = timeSlot(task, --index);
  return slot.at <= now ? { index, slot } : null;
}
