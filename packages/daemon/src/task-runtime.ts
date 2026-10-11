/** Task job logic hosted by daemon-jobs; contact reads only a cached projection. */
import { watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import { emptyTaskStore, type TaskStore } from "./task-schema.js";
import { readTaskStore } from "./task-store.js";
import { observeTaskSources, reconcileTaskTime } from "./task-events.js";
import { assessTaskFreshness } from "./task-freshness.js";
import { onTaskSnapshot, onTaskWake } from "./task-runtime-signal.js";
import type { TaskServiceContext } from "./task-service.js";

export class TaskRuntime {
  snapshot: TaskStore = emptyTaskStore();
  lastTick: number | null = null; lastError: string | null = null; nextTick = 0;
  reads = 0; backoff = 0; private stopped = false; private busy: Promise<void> | null = null;
  private queued = false; private loaded = false; private watcher?: FSWatcher;
  private unsubscribe: Array<() => void>;
  readonly ready: Promise<void>;
  constructor(readonly ctx: TaskServiceContext) {
    this.unsubscribe = [onTaskSnapshot(ctx.path, store => { this.snapshot = store; this.loaded = true; this.installWatcher(); }),
      onTaskWake(ctx.path, () => this.contact())];
    this.installWatcher();
    this.ready = this.refresh().then(() => this.tick(true)).catch(() => undefined);
  }
  private installWatcher(): void {
    if (this.watcher || this.stopped) return;
    try {
      this.watcher = watch(dirname(this.ctx.path), { persistent: false }, (_event, name) => {
        if (name?.toString() !== basename(this.ctx.path)) return;
        // Watch notifications are off-path, never a second polling loop.
        void this.refresh().then(changed => { if (changed) this.contact(); }).catch(() => undefined);
      });
      this.watcher.on("error", () => { this.watcher?.close(); this.watcher = undefined; this.lastError = "watch_unavailable"; });
    } catch { /* The first task mutation creates the parent, then attaches. */ }
  }
  private async refresh(): Promise<boolean> {
    if (this.stopped) return false;
    this.reads++;
    try {
      const snapshot = await readTaskStore(this.ctx.path);
      const changed = !this.loaded || snapshot.revision !== this.snapshot.revision || snapshot.recovery_epoch !== this.snapshot.recovery_epoch;
      this.snapshot = snapshot; this.loaded = true; return changed;
    } catch { this.lastError = "task_store_unavailable"; throw new Error("Task store unavailable"); }
  }
  get hasWork(): boolean { return this.snapshot.controls.enabled && this.snapshot.tasks.some(t => t.armed && !["resolved", "cancelled", "expired"].includes(t.state)); }
  contact(): void {
    if (this.stopped) return;
    this.queued = true;
    // No source/file reads inside hooks; the existing job runs after the response turn.
    setImmediate(() => { if (this.queued) { this.queued = false; void this.tick(true); } });
  }
  async tick(force = false): Promise<void> {
    if (this.stopped) return;
    if (this.busy) { if (force) this.queued = true; return this.busy; }
    const now = (this.ctx.now ?? Date.now)();
    if (!this.hasWork || now < this.nextTick || (!force && !this.loaded)) return;
    this.busy = (async () => {
      const started = Date.now();
      try {
        // One shared journal/CAS path for startup, interval, contact and owner calls.
        await observeTaskSources(this.ctx, true);
        if (Date.now() - started < 5000) await assessTaskFreshness(this.ctx);
        if (Date.now() - started < 5000) this.snapshot = await reconcileTaskTime(this.ctx);
        this.lastTick = now;
        const degraded = this.snapshot.tasks.some(t => t.armed && (t.verification?.outcome === "unavailable" || t.last_failure?.code === "source_unavailable"));
        this.backoff = degraded ? Math.min(Math.max(this.backoff * 2, 60000), 3600000) : 0;
        this.lastError = degraded ? "source_unavailable" : null;
        this.nextTick = now + (this.backoff || 60000);
      } catch { this.lastError = "task_job_unavailable"; this.backoff = Math.min(Math.max(this.backoff * 2, 60000), 3600000); this.nextTick = now + this.backoff; }
    })();
    try { await this.busy; } finally { this.busy = null; }
    // Mutations/contact during a tick never create parallel work or lose a wake.
    if (this.queued) { this.queued = false; this.contact(); }
  }
  stop(): void { this.stopped = true; this.watcher?.close(); for (const unsubscribe of this.unsubscribe) unsubscribe(); }
}
const runtimes = new Map<string, TaskRuntime>();
export function startTaskRuntime(ctx: TaskServiceContext): TaskRuntime {
  runtimes.get(ctx.path)?.stop(); const runtime = new TaskRuntime(ctx); runtimes.set(ctx.path, runtime); return runtime;
}
export function taskRuntime(path: string): TaskRuntime | undefined { return runtimes.get(path); }
export function stopTaskRuntimes(): void { for (const runtime of runtimes.values()) runtime.stop(); runtimes.clear(); }
