/** Bridge/standalone stdio forward effects to the protected long-lived daemon. */
import { resolveDaemonEndpoint } from "./daemon-endpoint.js";
import { taskFailure } from "./task-transport.js";
export async function forwardTaskExecution(name: string, input: unknown, authorization: string | undefined) {
  if (!authorization) throw Object.assign(new Error("Mapped task credential required"), { code: "unauthorized" });
  const response = await fetch(`${resolveDaemonEndpoint().baseUrl}/api/v1/${name}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: authorization }, body: JSON.stringify(input), signal: AbortSignal.timeout(10000) });
  const body = await response.json() as { code?: string; error?: string };
  if (!response.ok) throw Object.assign(new Error(body.error), { code: body.code }); return body;
}
export async function forwardTaskExecutionMcp(name: string, input: unknown, authorization: string | undefined) {
  try { return { content: [{ type: "text", text: JSON.stringify(await forwardTaskExecution(name, input, authorization)) }] }; }
  catch (error) { return { isError: true, content: [{ type: "text", text: JSON.stringify(taskFailure(error).body) }] }; }
}
