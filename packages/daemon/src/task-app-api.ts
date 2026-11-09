/** Local app observation/reporting contract. Reports grant no execution authority. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { authenticateTask, type TaskPrincipal } from "./task-auth.js";
import { isLoopback, isLoopbackHost } from "./http-auth.js";
import { readTaskStore, transactTaskStore, cleanText, TaskStoreError } from "./task-store.js";
import { taskIdentitySchema, type Task, type TaskStore } from "./task-schema.js";
import type { TaskServiceContext } from "./task-service.js";
import { onTaskSnapshot } from "./task-runtime-signal.js";
import { tasksEnabled } from "./tasks-enabled.js";
const instant = z.number().int().nonnegative().safe();
export const taskResultGetInput = z.strictObject({ id: taskIdentitySchema });
export const taskResultReportInput = taskResultGetInput.extend({
  expected_revision: z.string().regex(/^[a-z0-9._-]+:\d+$/), run_id: taskIdentitySchema,
  status: z.enum(["succeeded", "failed", "unknown"]), summary: z.string().max(16384), occurrence_id: taskIdentitySchema.optional(),
});
export const taskResultResponseSchema = z.strictObject({
  task_id: taskIdentitySchema, expected_revision: z.string(),
  executor_report: z.strictObject({ run_id: taskIdentitySchema, status: z.enum(["succeeded", "failed", "unknown"]), summary: z.string(),
    at: instant, actor: taskIdentitySchema, generation: instant, occurrence_id: taskIdentitySchema.optional() }).optional(),
  executor_report_current: z.boolean(),
  intents: z.array(z.strictObject({ id: taskIdentitySchema, state: z.enum(["pending", "succeeded", "unknown", "failed"]), created_at: instant, receipt_id: taskIdentitySchema.optional() })),
  receipts: z.array(z.strictObject({ id: taskIdentitySchema, intent_id: taskIdentitySchema, outcome: z.enum(["succeeded", "reconciled", "unknown", "failed"]), at: instant, error_code: taskIdentitySchema.optional() })),
});
function visible(task: Task, principal: TaskPrincipal): boolean { return task.owner_domains.every(d => principal.domains.includes(d)); }
function find(store: TaskStore, id: string, principal: TaskPrincipal): Task {
  const task = store.tasks.find(t => t.id === id && visible(t, principal));
  if (!task) throw Object.assign(new Error("Task absent in authorized domains"), { code: "not_found" });
  return task;
}
function result(store: TaskStore, task: Task) {
  return taskResultResponseSchema.parse({ task_id: task.id, expected_revision: `${store.recovery_epoch}:${task.revision}`,
    executor_report: task.executor_report, executor_report_current: task.executor_report?.generation === task.generation,
    intents: store.intents.filter(i => i.task_id === task.id).map(i => ({ id: i.id, state: i.state, created_at: i.created_at, receipt_id: i.receipt_id })),
    receipts: store.receipts.filter(r => r.task_id === task.id).map(r => ({ id: r.id, intent_id: r.intent_id, outcome: r.outcome, at: r.at, error_code: r.error_code })),
  });
}
export async function callTaskResult(ctx: TaskServiceContext, authorization: string | undefined, operation: "task_result_get" | "task_result_report", raw: unknown): Promise<unknown> {
  const principal = await authenticateTask(authorization, ctx.authPath);
  if (operation === "task_result_get") {
    const input = taskResultGetInput.parse(raw), store = await readTaskStore(ctx.path);
    return result(store, find(store, input.id, principal));
  }
  const input = taskResultReportInput.parse(raw), now = (ctx.now ?? Date.now)();
  const store = await transactTaskStore(ctx.path, undefined, s => {
    const task = find(s, input.id, principal);
    if (`${s.recovery_epoch}:${task.revision}` !== input.expected_revision) throw new TaskStoreError("conflict", "Task revision changed or recovered");
    if (input.occurrence_id && !s.occurrences.some(o => o.id === input.occurrence_id && o.task_id === task.id && o.generation === task.generation))
      throw Object.assign(new Error("Occurrence absent in current generation"), { code: "not_found" });
    task.executor_report = { run_id: input.run_id, status: input.status, summary: cleanText(input.summary),
      actor: principal.actor_id, at: now, generation: task.generation, ...(input.occurrence_id ? { occurrence_id: input.occurrence_id } : {}) };
    const before = task.revision++; task.updated_at = now;
    task.history.push({ at: now, actor: principal.actor_id, operation: "executor-report", before_revision: before, after_revision: task.revision, reason: "Attributed executor report; no signed action receipt or task completion inferred" });
  }, "control");
  return result(store, find(store, input.id, principal));
}
export const TASK_STREAM_PATH = "/tasks/stream";
export const taskStreamEventSchema = z.strictObject({
  version: z.literal(1), cursor: z.string(), task_id: taskIdentitySchema, task_revision: instant,
  state: z.enum(["pending", "due", "snoozed", "resolved", "cancelled", "expired"]), occurrence_id: taskIdentitySchema.optional(),
});
export const taskStreamSnapshotSchema = z.strictObject({ version: z.literal(1), cursor: z.string(), resync: z.literal(true),
  tasks: z.array(z.strictObject({ id: taskIdentitySchema, revision: instant, state: z.enum(["pending", "due", "snoozed", "resolved", "cancelled", "expired"]) })) });
const streamCounts = new Map<string, number>();
/** Bounded live notifications plus an authoritative snapshot on every reconnect.
 * Last-Event-ID is advisory only: no durable event log/replay is claimed. */
export async function dispatchTaskStream(req: IncomingMessage, res: ServerResponse, ctx: TaskServiceContext, options: { heartbeatMs?: number } = {}): Promise<void> {
  let cleanup = () => {};
  try {
    if (!tasksEnabled()) throw Object.assign(new Error("Tasks disabled"), { code: "feature_disabled" });
    if (req.method !== "GET" || !isLoopback(req) || !isLoopbackHost(req.headers.host, []) || (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`))
      throw Object.assign(new Error("Local app request required"), { code: "forbidden" });
    if (new URL(req.url!, "http://127.0.0.1").search) throw Object.assign(new Error("Stream query parameters are not supported"), { code: "validation" });
    let principal = await authenticateTask(req.headers.authorization, ctx.authPath);
    let previous = await readTaskStore(ctx.path);
    if ((streamCounts.get(ctx.path) ?? 0) >= 32) throw Object.assign(new Error("Stream capacity reached"), { code: "capacity" });
    streamCounts.set(ctx.path, (streamCounts.get(ctx.path) ?? 0) + 1);
    let closed = false, pending: TaskStore | undefined, busy = false;
    const cursor = (store: TaskStore) => `${store.recovery_epoch}:${store.revision}`;
    const write = (event: string, data: unknown, id: string): void => {
      if (closed) return;
      res.write(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      if (res.writableLength > 256 * 1024) { cleanup(); res.destroy(); }
    };
    const emit = async (store: TaskStore): Promise<void> => {
      const previousDomains = JSON.stringify(principal.domains);
      principal = await authenticateTask(req.headers.authorization, ctx.authPath);
      if (closed) return;
      const currentCursor = cursor(store);
      if (store.recovery_epoch === previous.recovery_epoch && store.revision < previous.revision) return;
      if (store.recovery_epoch !== previous.recovery_epoch || JSON.stringify(principal.domains) !== previousDomains) {
        write("snapshot", { version: 1, cursor: currentCursor, resync: true, tasks: store.tasks.filter(t => visible(t, principal)).map(t => ({ id: t.id, revision: t.revision, state: t.state })) }, currentCursor);
      } else if (store.revision > previous.revision) {
        for (const task of store.tasks.filter(t => visible(t, principal))) {
          const old = previous.tasks.find(t => t.id === task.id && visible(t, principal));
          const data = { version: 1, cursor: currentCursor, task_id: task.id, task_revision: task.revision, state: task.state };
          if (!old || task.revision !== old.revision) write("changed", data, `${currentCursor}:changed:${task.id}`);
          const occurrences = store.occurrences.filter(o => o.task_id === task.id && o.generation === task.generation);
          for (const occurrence of occurrences) {
            const prior = previous.occurrences.find(o => o.id === occurrence.id);
            if (!prior && task.state !== "expired" && occurrence.kind !== "expired") write("due", { ...data, occurrence_id: occurrence.id }, `${currentCursor}:due:${occurrence.id}`);
            if (task.state !== "expired" && occurrence.kind !== "expired" && occurrence.resolution && !prior?.resolution) write("completed", { ...data, occurrence_id: occurrence.id }, `${currentCursor}:completed:${occurrence.id}`);
          }
          if (task.state === "resolved" && old?.state !== "resolved" && !occurrences.some(o => o.resolution && !previous.occurrences.find(p => p.id === o.id)?.resolution)) write("completed", data, `${currentCursor}:completed:${task.id}`);
          if (task.state === "expired" && old?.state !== "expired") write("expired", data, `${currentCursor}:expired:${task.id}`);
        }
        // Deletion/domain removal requires resync, without exposing removed content.
        if (previous.tasks.some(t => visible(t, principal) && !store.tasks.some(n => n.id === t.id && visible(n, principal))))
          write("snapshot", { version: 1, cursor: currentCursor, resync: true, tasks: store.tasks.filter(t => visible(t, principal)).map(t => ({ id: t.id, revision: t.revision, state: t.state })) }, currentCursor);
      }
      previous = store;
    };
    const queue = (store: TaskStore): void => {
      pending = store; if (busy || closed) return; busy = true;
      void (async () => { while (pending && !closed) { const next = pending; pending = undefined; await emit(next); } })()
        .catch(() => { cleanup(); res.end(); }).finally(() => { busy = false; });
    };
    const unsubscribe = onTaskSnapshot(ctx.path, queue);
    const heartbeat = setInterval(() => {
      if (closed) return;
      void authenticateTask(req.headers.authorization, ctx.authPath).then(() => readTaskStore(ctx.path)).then(store => {
        if (closed) return; queue(store); res.write(": heartbeat\n\n");
        if (res.writableLength > 256 * 1024) { cleanup(); res.destroy(); }
      }).catch(() => { cleanup(); res.end(); });
    }, options.heartbeatMs ?? 15000); heartbeat.unref();
    cleanup = () => { if (closed) return; closed = true; pending = undefined; clearInterval(heartbeat); unsubscribe(); const remaining = (streamCounts.get(ctx.path) ?? 1) - 1; if (remaining) streamCounts.set(ctx.path, remaining); else streamCounts.delete(ctx.path); };
    res.once("close", cleanup); req.once("aborted", cleanup);
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
    write("snapshot", { version: 1, cursor: cursor(previous), resync: true, tasks: previous.tasks.filter(t => visible(t, principal)).map(t => ({ id: t.id, revision: t.revision, state: t.state })) }, cursor(previous));
    // Close the read/subscribe race using the durable latest state.
    queue(await readTaskStore(ctx.path));
  } catch (error) {
    cleanup();
    if (res.headersSent) { res.end(); return; }
    const code = (error as { code?: string }).code ?? "unavailable";
    const status = ({ unauthorized: 401, forbidden: 403, validation: 400, feature_disabled: 404, capacity: 503 } as Record<string, number>)[code] ?? 503;
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify({ code, error: "Task stream unavailable" }));
  }
}
