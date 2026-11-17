/**
 * The task CLI's HTTP call to the daemon's task API: one operation, one
 * authorization, the daemon's error mapped to a thrown error. Shared by the
 * task commands and the execution switch without either importing the other
 * (#1515 B7).
 */
import { TaskDomainError } from "../task-auth.js";
import { isTaskTool } from "../task-transport.js";

/** Agent mode is explicit. Owner mode always asks privately, ignoring agent env. */
export async function taskCliCall(
  sub: string,
  input: unknown,
  authorization: string,
  baseUrl: string
): Promise<unknown> {
  const operation = `task_${sub.replaceAll("-", "_")}`;
  if (!isTaskTool(operation)) throw Object.assign(new Error("Unknown task operation"), { code: "validation" });
  const resp = await fetch(`${baseUrl}/api/v1/${operation}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authorization },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(10000),
  });
  const body = (await resp.json()) as {
    error?: string;
    code?: string;
    reason?: string;
    rejected?: string[];
    allowed?: string[];
  };
  if (
    resp.status === 403 &&
    body.code === "forbidden" &&
    body.reason === "owner_domain_not_enrolled" &&
    Array.isArray(body.rejected) &&
    Array.isArray(body.allowed) &&
    [...body.rejected, ...body.allowed].every((d) => typeof d === "string" && /^[a-z0-9][a-z0-9._:-]{0,95}$/.test(d))
  )
    throw new TaskDomainError(body.rejected, body.allowed);
  if (!resp.ok)
    throw Object.assign(new Error(body.error), { code: body.code, reason: body.reason, status: resp.status });
  return body;
}
