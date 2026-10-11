import { taskClientToken } from "./task-client-auth.js";
import { approvalRegistryPath, pinnedApprovalRegistry } from "./task-approval-keys.js";
import type { ToolDeps } from "./tool-deps.js";
import { taskMemoryChanger, taskMemoryReader } from "./task-freshness.js";
import { z } from "zod";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tasksPath } from "./task-store.js";
import { taskAuthPath, authenticateTask } from "./task-auth.js";
import { callTaskCrud, TASK_CRUD_OPERATIONS, TASK_INPUT_SCHEMAS, type TaskCrudOperation, type TaskServiceContext } from "./task-service.js";
import { MAX_BODY_BYTES, readJsonBody, sendJson } from "./http-util.js";
import { PathLockUnavailableError } from "./path-lock.js";

export const taskTools = TASK_CRUD_OPERATIONS.map(name => ({ name,
  description: `${name}: persisted commitment; agent capture stays unarmed. Owner command required for review, acknowledgement, resolution and rearm. Delivery does not resolve.`,
  inputSchema: z.toJSONSchema(TASK_INPUT_SCHEMAS[name]) as { type: "object"; properties: Record<string, unknown> },
  annotations: { readOnlyHint: name === "task_get" || name === "task_list" || name === "task_status" || name === "task_proposal", destructiveHint: false },
}));
export function isTaskTool(name: string): name is TaskCrudOperation { return (TASK_CRUD_OPERATIONS as readonly string[]).includes(name); }
export function defaultTaskContext(deps?: Pick<ToolDeps, "vault" | "vaultPath">, executionHost = false): TaskServiceContext { return { executionHost, path: tasksPath(), authPath: taskAuthPath(), approvalRegistry: pinnedApprovalRegistry(), approvalRegistryPath: approvalRegistryPath(), memoryRead: deps ? taskMemoryReader(deps) : undefined, memoryChange: deps ? taskMemoryChanger(deps) : undefined, memorySubscribe: deps ? listener => deps.vault.on(e => listener(e.kind === "remove" ? e.id : e.memory.fm.id)) : undefined }; }
export function taskFailure(error: unknown): { status: number; body: { error: string; code: string; retryable: boolean; status: number } } {
  const reported = error instanceof z.ZodError ? "validation" : error instanceof PathLockUnavailableError ? "lock_unavailable"
    : (error as { code?: string })?.code ?? "unavailable";
  const statuses: Record<string, number> = { unauthorized: 401, forbidden: 403, not_found: 404,
    validation: 400, conflict: 409, approval_stale: 409, approval_expired: 409, approval_revoked: 409, approval_denied: 403, approval_missing: 409, approval_consumed: 409, lease_expired: 409, key_unlock_failed: 403, owner_cache_invalid: 403, adapter_disabled: 409, adapter_not_reversible: 409, execution_stopped: 409, feature_disabled: 409, execution_host_required: 409, protected_boundary_required: 409, corrupt: 503, auth_corrupt: 503, unsupported_version: 503, capacity: 503, lock_unavailable: 503 };
  // Do not echo raw validation values, paths, authorization or filesystem errors.
  const code = Object.hasOwn(statuses, reported) ? reported : "unavailable";
  const status = statuses[code] ?? 503;
  return { status, body: { error: `Task operation failed: ${code}`, code, retryable: status === 503, status } };
}
export async function callTaskMcp(name: TaskCrudOperation, input: unknown,
  authorization: string | undefined, ctx = defaultTaskContext()) {
  try {
    const result = await callTaskCrud(ctx, authorization, name, input);
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  } catch (error) {
    return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(taskFailure(error).body) }] };
  }
}
export async function taskClientAuthorization(): Promise<string | undefined> {
  // Client config must hold its explicitly assigned agent credential, not the legacy token.
  const token = taskClientToken(); return token ? `Bearer ${token}` : undefined;
}
/** Matches both canonical REST and the established /api/v1/<MCP tool> route. */
export function dispatchTaskHttp(req: IncomingMessage, res: ServerResponse, method: string, url: string,
  ctx = defaultTaskContext()): boolean {
  const pathname = new URL(url, "http://127.0.0.1").pathname;
  if (!pathname.startsWith("/api/v1/tasks") && !pathname.startsWith("/api/v1/task_")) return false;
  void (async () => {
    try {
      // Authenticate even invalid routes before reading a body. Loopback is no exemption.
      await authenticateTask(req.headers.authorization, ctx.authPath);
      let operation: TaskCrudOperation | undefined;
      let id: string | undefined;
      const tool = pathname.slice("/api/v1/".length);
      if (isTaskTool(tool) && method === "POST") operation = tool;
      else if (pathname === "/api/v1/tasks/due" && method === "GET") operation = "task_due";
      else if (pathname === "/api/v1/tasks/events" && method === "POST") operation = "task_event";
      else if (pathname === "/api/v1/tasks/sources" && method === "POST") operation = "task_source_register";
      else if (pathname === "/api/v1/tasks/reconcile" && method === "POST") operation = "task_reconcile";
      else if (pathname === "/api/v1/tasks" || pathname === "/api/v1/tasks/") {
        operation = method === "GET" ? "task_list" : method === "POST" ? "task_create" : undefined;
      } else {
        const match = /^\/api\/v1\/tasks\/([a-z0-9._:-]+)(?:\/(review|snooze|acknowledge|resolve|cancel|rearm|reconsider))?$/.exec(pathname);
        if (match) {
          id = match[1];
          if (method === "GET" && !match[2]) operation = "task_get";
          if (method === "PATCH" && !match[2]) operation = "task_edit";
          if (method === "POST" && match[2]) operation = `task_${match[2]}` as TaskCrudOperation;
        }
      }
      if (!operation) { sendJson(res, 404, { error: "Task route absent", code: "not_found", retryable: false }); return; }
      let input: Record<string, unknown> = method === "GET" ? {} : await readJsonBody(req, MAX_BODY_BYTES).catch(() => {
        throw Object.assign(new Error("Invalid bounded task JSON request"), { code: "validation" });
      });
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new z.ZodError([]);
      if (id) {
        if ("id" in input && input.id !== id) throw new z.ZodError([]);
        input = { ...input, id };
      }
      const result = await callTaskCrud(ctx, req.headers.authorization, operation, input);
      res.setHeader("Cache-Control", "no-store"); sendJson(res, 200, result);
    } catch (error) { const failure = taskFailure(error); sendJson(res, failure.status, failure.body); }
  })();
  return true;
}
