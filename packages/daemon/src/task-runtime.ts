/** Task job logic hosted by daemon-jobs; contact reads only a cached projection. */
import { watch, existsSync, type FSWatcher } from "node:fs";
import { basename, dirname, relative, sep } from "node:path";
import { emptyTaskStore, type TaskStore } from "./task-schema.js";
import { readTaskStore } from "./task-store.js";
import { observeTaskSources, reconcileTaskTime } from "./task-events.js";
import { taskCheckMaterial, assessTaskFreshness } from "./task-freshness.js";
import { onTaskSnapshot, onTaskWake } from "./task-runtime-signal.js";
import type { TaskServiceContext } from "./task-service.js";

export class TaskRuntime {
  snapshot: TaskStore = emptyTaskStore();
  lastTick: number | null = null; lastError: string | null = null; nextTick = 0;
  reads = 0; backoff = 0; ioStopped = false;
  readonly checks = new Map<string, { next: number; backoff: number; material: string }>();
  private pollCursor = 0; private stopped = false; private busy: Promise<void> | null = null;
  private queued = false; private loaded = false; private watcher?: FSWatcher;
  private unsubscribe: Array<() => void>; private cleanup: Array<() => void> = [];
  readonly ready: Promise<void>;
  constructor(readonly ctx: TaskServiceContext) {
    this.unsubscribe = [onTaskSnapshot(ctx.path, store => { this.snapshot = store; this.loaded = true; this.installWatcher(); }),
      onTaskWake(ctx.path, () => this.contact())];
    this.installWatcher();
    this.ready = this.refresh().then(() => this.tick()).catch(() => undefined);
  }
  private installWatcher(): void {
    if (this.watcher || this.stopped) return;
    const target = dirname(this.ctx.path); let directory = target;
    while (!existsSync(directory) && dirname(directory) !== directory) directory = dirname(directory);
    try {
      this.watcher = watch(directory, { persistent: false }, (_event, name) => {
        const wanted = directory === target ? basename(this.ctx.path) : relative(directory, target).split(sep)[0];
        if (name?.toString() !== wanted) return;
        if (directory !== target) { this.watcher?.close(); this.watcher = undefined; this.installWatcher(); }
        void this.refresh().then(changed => { if (changed) this.contact(); }).catch(() => undefined);
      });
      this.watcher.on("error", () => { this.watcher?.close(); this.watcher = undefined; this.lastError = "watch_unavailable"; });
    } catch { /* Retried off-path at the next contact or committed mutation. */ }
  }
  private async refresh(): Promise<boolean> {
    if (this.stopped) return false;
    this.reads++;
    try {
      const snapshot = await readTaskStore(this.ctx.path);
      if (this.loaded && snapshot.recovery_epoch === this.snapshot.recovery_epoch && snapshot.revision < this.snapshot.revision) return false;
      const changed = !this.loaded || snapshot.revision !== this.snapshot.revision || snapshot.recovery_epoch !== this.snapshot.recovery_epoch;
      this.snapshot = snapshot; this.loaded = true; return changed;
    } catch { this.lastError = "task_store_unavailable"; this.ioStopped = true; throw new Error("Task store unavailable"); }
  }
  get hasWork(): boolean { return this.snapshot.controls.enabled && this.snapshot.tasks.some(t => t.armed && !["resolved", "cancelled", "expired"].includes(t.state)); }
  contact(): void {
    if (this.stopped) return;
    this.queued = true;
    setImmediate(() => { if (this.queued) { this.queued = false; this.installWatcher(); void this.tick(); } });
  }
  async tick(): Promise<void> {
    if (this.stopped) return;
    if (this.busy) { this.queued = true; return this.busy; }
    if (!this.hasWork || !this.loaded || (this.ioStopped && (this.ctx.now ?? Date.now)() < this.nextTick)) return; // no interval reads/writes when empty/unarmed
    const now = (this.ctx.now ?? Date.now)();
    this.busy = (async () => {
      const started = Date.now(); let assessed = new Map<string,string>(); const selected = new Set<string>(); const sources = new Set<string>();
      let visited = 0;
      while (visited < this.snapshot.tasks.length && selected.size < 10) {
        const task = this.snapshot.tasks[(this.pollCursor + visited++) % this.snapshot.tasks.length];
        if (!task.armed || ["resolved", "cancelled", "expired"].includes(task.state) || (task.schedule.kind !== "event" && !task.evidence.length)) continue;
        const event = [...this.snapshot.events].reverse().find(e => task.schedule.kind === "event" && e.source_id === task.schedule.source_id);
        const material = taskCheckMaterial(task, this.snapshot);
        const previous = this.checks.get(task.id);
        if (previous && now < previous.next && previous.material === material) continue;
        selected.add(task.id); if (task.schedule.kind === "event" && (!event || task.verification?.event_id === event.id)) sources.add(task.schedule.source_id);
      }
      this.pollCursor = (this.pollCursor + visited) % this.snapshot.tasks.length;
      try {
        if (selected.size) {
          await observeTaskSources(this.ctx, true, sources);
          if (Date.now() - started < 5000) assessed = await assessTaskFreshness(this.ctx, selected, 5000 - (Date.now() - started));
        }
        if (Date.now() - started < 5000) this.snapshot = await reconcileTaskTime(this.ctx);
        this.lastTick = now; this.backoff = 0; this.lastError = null;
        for (const id of selected) {
          const task = this.snapshot.tasks.find(t => t.id === id); if (!task || !assessed.has(id)) continue;
          const failed = ["unavailable", "inconclusive", "stale"].includes(task.verification?.outcome ?? "") || task.last_failure?.code === "source_unavailable";
          const delay = failed ? Math.min(Math.max((this.checks.get(id)?.backoff ?? 0) * 2, task.budget.poll_interval_ms), 3600000) : task.budget.poll_interval_ms;
          this.checks.set(id, { next: now + delay, backoff: failed ? delay : 0, material: assessed.get(id)! });
          this.backoff = Math.max(this.backoff, failed ? delay : 0); if (failed) this.lastError = "source_unavailable";
        }
        // Accepted/new events never inherit a failed or older snapshot's backoff.
        if (this.snapshot.tasks.some(t => { if (!t.armed || t.schedule.kind !== "event") return false; const sourceId = t.schedule.source_id; return this.snapshot.events.some(e => e.source_id === sourceId)
          && this.checks.get(t.id)?.material !== taskCheckMaterial(t, this.snapshot); })) this.queued = true;
        this.nextTick = Math.min(now + 60000, ...[...this.checks.values()].map(c => c.next));
      } catch { this.ioStopped = true; this.lastError = "task_job_unavailable"; this.backoff = Math.min(Math.max(this.backoff * 2, 60000), 3600000); this.nextTick = now + this.backoff; }
    })();
    try { await this.busy; } finally { this.busy = null; }
    if (this.queued) { this.queued = false; this.contact(); }
  }
  onStop(cleanup: () => void): void { if (this.stopped) cleanup(); else this.cleanup.push(cleanup); }
  settle(): Promise<void> { return this.busy ?? Promise.resolve(); }
  stop(): void { this.stopped = true; this.watcher?.close(); for (const unsubscribe of this.unsubscribe) unsubscribe(); for (const cleanup of this.cleanup) cleanup(); }
}
const runtimes = new Map<string, TaskRuntime>();
export function startTaskRuntime(ctx: TaskServiceContext): TaskRuntime {
  runtimes.get(ctx.path)?.stop(); const runtime = new TaskRuntime(ctx); runtimes.set(ctx.path, runtime); runtime.onStop(() => { if (runtimes.get(ctx.path) === runtime) runtimes.delete(ctx.path); }); return runtime;
}
export function taskRuntime(path: string): TaskRuntime | undefined { return runtimes.get(path); }
export async function stopTaskRuntimes(): Promise<void> { const active = [...runtimes.values()]; for (const runtime of active) runtime.stop(); runtimes.clear(); await Promise.all(active.map(runtime => runtime.settle())); }
