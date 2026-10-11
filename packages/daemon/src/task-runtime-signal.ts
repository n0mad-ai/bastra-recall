/** In-process wake/cache signals. Disk remains the authority across processes. */
import type { TaskStore } from "./task-schema.js";
const snapshots = new Map<string, Set<(store: TaskStore) => void>>();
const wakes = new Map<string, Set<() => void>>();
export function onTaskSnapshot(path: string, listener: (store: TaskStore) => void): () => void {
  const listeners = snapshots.get(path) ?? new Set(); listeners.add(listener); snapshots.set(path, listeners);
  return () => { listeners.delete(listener); if (!listeners.size) snapshots.delete(path); };
}
export function publishTaskSnapshot(path: string, store: TaskStore): void {
  for (const listener of snapshots.get(path) ?? []) listener(structuredClone(store));
}
export function onTaskWake(path: string, listener: () => void): () => void {
  const listeners = wakes.get(path) ?? new Set(); listeners.add(listener); wakes.set(path, listeners);
  return () => { listeners.delete(listener); if (!listeners.size) wakes.delete(path); };
}
export function requestTaskReconciliation(path: string): void { for (const listener of wakes.get(path) ?? []) listener(); }
