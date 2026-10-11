/** Passive presentation is authenticated, cached and never a human receipt. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { authenticateTask } from "./task-auth.js";
import { taskDueInput, taskDueProjection, taskDueText, cachedTaskSnapshot, recordTaskDelivery } from "./task-outbox.js";
import { requestTaskReconciliation } from "./task-runtime-signal.js";
import type { TaskServiceContext } from "./task-service.js";

export function taskRequestAuth(req: IncomingMessage): string | undefined {
  const dedicated = req.headers["x-bastra-task-authorization"];
  return typeof dedicated === "string" ? dedicated : req.headers.authorization;
}
const passiveQuiet = new Map<string, number>();
export async function taskAttachment(ctx: TaskServiceContext, authorization: string | undefined, session: string, channel: "mcp" | "http" | "session" | "prompt") {
  requestTaskReconciliation(ctx.path);
  try {
    const principal = await authenticateTask(authorization, ctx.authPath);
    const store = cachedTaskSnapshot(ctx.path); if (!store) return undefined;
    const input = taskDueInput.parse({ session: /^[a-z0-9][a-z0-9._:-]{0,95}$/.test(session) ? session : "unknown", channel });
    const projection = taskDueProjection(store, principal, input, (ctx.now ?? Date.now)(), true);
    const now = (ctx.now ?? Date.now)();
    for (const [key, until] of passiveQuiet) if (until <= now) passiveQuiet.delete(key);
    const keep = projection.occurrenceIds.map(id => JSON.stringify([ctx.path, projection.client, id]));
    if (keep.some(key => (passiveQuiet.get(key) ?? 0) > now)) return undefined;
    if (!projection.cards.length) return undefined;
    if (passiveQuiet.size >= 5000) passiveQuiet.clear();
    for (const key of keep) passiveQuiet.set(key, now + 60000);
    return { text: taskDueText(projection), due: { coverage: projection.coverage, cards: projection.cards, overflow: projection.overflow },
      record: () => { setImmediate(() => { void recordTaskDelivery(ctx.path, principal, projection.client, projection.occurrenceIds, (ctx.now ?? Date.now)(), input.session, channel).catch(() => undefined); }); } };
  } catch { return undefined; } // legacy/absent/revoked mapping never receives private work
}
/** Success-only JSON finalizer. Streaming responses retain their existing framing. */
export function installTaskHttpProjection(req: IncomingMessage, res: ServerResponse, ctx: TaskServiceContext): void {
  const path = (req.url ?? "").split("?")[0];
  if (!path.startsWith("/api/v1/") || path.startsWith("/api/v1/tasks") || path.startsWith("/api/v1/task_")) return;
  const end = res.end.bind(res); const head = res.writeHead.bind(res); const write = res.write.bind(res);
  let finishing = false;
  const restore = () => { res.end = end; res.writeHead = head; res.write = write; };
  res.writeHead = ((status: number, messageOrHeaders?: any, headers?: any) => {
    res.statusCode = status;
    const values = typeof messageOrHeaders === "string" ? headers : messageOrHeaders;
    if (values && !Array.isArray(values)) for (const [key, value] of Object.entries(values)) res.setHeader(key, value as string);
    if (String(res.getHeader("Content-Type")).includes("text/event-stream")) { restore(); return head(status); }
    return res;
  }) as ServerResponse["writeHead"];
  res.write = ((...args: any[]) => { restore(); head(res.statusCode); return (write as any)(...args); }) as ServerResponse["write"];
  res.end = ((...args: any[]) => {
    if (finishing) return res; finishing = true;
    void (async () => {
      try {
        if (res.statusCode < 200 || res.statusCode >= 300 || !String(res.getHeader("Content-Type")).includes("application/json")) { restore(); return (end as any)(...args); }
        const raw = Buffer.isBuffer(args[0]) ? args[0].toString("utf8") : typeof args[0] === "string" ? args[0] : "";
        const body = JSON.parse(raw);
        if (!body || typeof body !== "object" || Array.isArray(body) || body.error || body.isError || body.ok === false) { restore(); return (end as any)(...args); }
        const attachment = await taskAttachment(ctx, taskRequestAuth(req), String(req.headers["x-bastra-cc-session"] ?? "unknown"), "http");
        if (!attachment || res.destroyed) { restore(); return (end as any)(...args); }
        const payload = JSON.stringify({ ...body, proactive_due: attachment.due });
        res.removeHeader("Content-Length"); res.setHeader("Content-Length", Buffer.byteLength(payload));
        res.once("finish", attachment.record); restore(); return end(payload);
      } catch { restore(); return (end as any)(...args); }
    })();
    return res;
  }) as ServerResponse["end"];
}
export async function finalizeTaskMcp(result: any, ctx: TaskServiceContext, authorization: string | undefined, session = "unknown") {
  if (result.isError) return result;
  const attachment = await taskAttachment(ctx, authorization, session, "mcp");
  if (!attachment) return result;
  attachment.record(); return { ...result, content: [...result.content, { type: "text", text: attachment.text }] };
}
