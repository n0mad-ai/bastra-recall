/** Canonical REST aliases, consumed by both HTTP routing and OpenAPI. */
import type { TaskCrudOperation } from "./task-service.js";

export interface TaskHttpRoute {
  method: "GET" | "POST" | "PATCH";
  path: string;
  operation: TaskCrudOperation;
}
export const TASK_HTTP_ROUTES: readonly TaskHttpRoute[] = [
  { method: "GET", path: "/tasks/due", operation: "task_due" },
  { method: "POST", path: "/tasks/recovery", operation: "task_recover" },
  { method: "POST", path: "/tasks/archive", operation: "task_archive" },
  { method: "POST", path: "/tasks/archive/restore", operation: "task_archive_restore" },
  { method: "POST", path: "/tasks/events", operation: "task_event" },
  { method: "POST", path: "/tasks/sources", operation: "task_source_register" },
  { method: "POST", path: "/tasks/reconcile", operation: "task_reconcile" },
  { method: "GET", path: "/tasks", operation: "task_list" },
  { method: "POST", path: "/tasks", operation: "task_create" },
  { method: "GET", path: "/tasks/{id}", operation: "task_get" },
  { method: "PATCH", path: "/tasks/{id}", operation: "task_edit" },
  ...["review", "snooze", "acknowledge", "resolve", "cancel", "rearm", "reconsider"].map(action => ({
    method: "POST" as const, path: `/tasks/{id}/${action}`, operation: `task_${action}` as TaskCrudOperation,
  })),
];

export function matchTaskHttpRoute(method: string, pathname: string): { operation: TaskCrudOperation; id?: string } | undefined {
  // Preserve the established collection trailing-slash alias, and strict ID alphabet.
  const path = pathname === "/api/v1/tasks/" ? "/tasks" : pathname.slice("/api/v1".length);
  for (const route of TASK_HTTP_ROUTES) {
    if (route.method !== method) continue;
    const pattern = route.path.replace("{id}", "([a-z0-9._:-]+)");
    const match = new RegExp(`^${pattern}$`).exec(path);
    if (match) return { operation: route.operation, ...(match[1] ? { id: match[1] } : {}) };
  }
  return undefined;
}
