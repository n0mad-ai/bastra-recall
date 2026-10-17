import { tasksEnabled } from "./tasks-enabled.js";
/** Browser access reuses only Agent authority; Owner login/signing stay separate. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { getUiEnabled } from "./settings.js";
import { isLoopback, isLoopbackHost, gateLocalPost } from "./http-auth.js";
import { taskClientToken } from "./task-client-auth.js";
import { authenticateTask } from "./task-auth.js";
import { callTaskCrud, type TaskServiceContext } from "./task-service.js";
import { defaultTaskContext, isTaskTool, taskFailure } from "./task-transport.js";
import { readJsonBody, sendJson, MAX_BODY_BYTES } from "./http-util.js";
const sessions = new Map<string, { authorization: string; csrf: string; expires: number; path: string }>();
const ttl = 15 * 60 * 1000;
const cookie = "bastra_task_session";
const cookieHeader = (value: string, age: number) => `${cookie}=${value}; HttpOnly; SameSite=Strict; Path=/ui/tasks/; Max-Age=${age}`;
function reject(code: string): never { throw Object.assign(new Error("Task UI access denied"), { code }); }
export function dispatchTaskUi(req: IncomingMessage, res: ServerResponse, method: string, url: string, ctx: TaskServiceContext = defaultTaskContext(undefined, true)): boolean {
  if (!url.startsWith("/ui/tasks/")) return false;
  if (!tasksEnabled()) { sendJson(res, 404, { error: "Tasks preview disabled; opt in with BASTRA_TASKS=1", code: "feature_disabled" }); return true; }
  void (async () => {
    try {
      res.setHeader("Cache-Control", "no-store");
      if (!isLoopback(req) || !isLoopbackHost(req.headers.host, []) || !await getUiEnabled()) reject("forbidden");
      if (method !== "POST") reject("forbidden");
      const gate = gateLocalPost({ origin: req.headers.origin, host: req.headers.host, contentType: req.headers["content-type"], path: url });
      if (gate !== 200) reject("forbidden");
      for (const [id, s] of sessions) if (s.expires <= Date.now()) sessions.delete(id);
      if (url === "/ui/tasks/session") {
        await readJsonBody(req, 256);
        const token = taskClientToken(); if (!token) reject("unauthorized");
        const authorization = `Bearer ${token}`, principal = await authenticateTask(authorization, ctx.authPath);
        if (principal.role !== "agent") reject("forbidden");
        if (sessions.size >= 100) reject("capacity");
        const id = randomBytes(32).toString("base64url"), csrf = randomBytes(32).toString("base64url");
        sessions.set(id, { authorization, csrf, expires: Date.now()+ttl, path: ctx.path });
        res.setHeader("Set-Cookie", cookieHeader(id, ttl/1000)); sendJson(res,200,{ role: "agent", csrf, expires_in: ttl/1000 }); return;
      }
      const id = req.headers.cookie?.split(";").map(c => c.trim()).find(c => c.startsWith(`${cookie}=`))?.slice(cookie.length+1);
      const session = id && sessions.get(id); if (!session || session.path !== ctx.path) reject("unauthorized");
      const csrf = req.headers["x-bastra-task-csrf"];
      if (typeof csrf !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(csrf) || csrf.length !== session.csrf.length || !timingSafeEqual(Buffer.from(csrf), Buffer.from(session.csrf))) reject("forbidden");
      if (url === "/ui/tasks/logout") { await readJsonBody(req,256); sessions.delete(id!); res.setHeader("Set-Cookie",cookieHeader("",0)); sendJson(res,200,{logged_out:true}); return; }
      const operation = url.slice("/ui/tasks/api/".length);
      if (!url.startsWith("/ui/tasks/api/") || !isTaskTool(operation)) reject("not_found");
      // Recheck revocation/role on every request; API never inherits an Owner.
      if ((await authenticateTask(session.authorization, ctx.authPath)).role !== "agent") reject("forbidden");
      const input = await readJsonBody(req, MAX_BODY_BYTES);
      sendJson(res,200,await callTaskCrud(ctx,session.authorization,operation as any,input));
    } catch (error) { const failure=taskFailure(error); sendJson(res,failure.status,failure.body); }
  })();
  return true;
}
