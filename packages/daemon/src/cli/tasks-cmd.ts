import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolveDaemonEndpoint } from "../daemon-endpoint.js";
import { authenticateTask, mintTaskCredential, revokeTaskCredential, taskAuthPath } from "../task-auth.js";
import { isTaskTool, taskClientAuthorization, taskFailure } from "../task-transport.js";
import { taskPrivatePrompt } from "./task-private-prompt.js";
import { confirm } from "./prompt.js";

async function jsonFile(path: string): Promise<unknown> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 256 * 1024) throw new Error("Bounded JSON input required");
    return JSON.parse(await handle.readFile("utf8"));
  } finally { await handle.close(); }
}
/** Agent mode is explicit. Owner mode always asks privately, ignoring agent env. */
export async function taskCliCall(sub: string, input: unknown, authorization: string, baseUrl: string): Promise<unknown> {
  const operation = `task_${sub.replaceAll("-", "_")}`;
  if (!isTaskTool(operation)) throw Object.assign(new Error("Unknown task operation"), { code: "validation" });
  const resp = await fetch(`${baseUrl}/api/v1/${operation}`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: authorization }, body: JSON.stringify(input),
    signal: AbortSignal.timeout(10000),
  });
  const body = await resp.json() as { error?: string; code?: string };
  if (!resp.ok) throw Object.assign(new Error(body.error), { code: body.code, status: resp.status });
  return body;
}
export async function cmdTasks(args: { sub: string | null; positional: string[] }): Promise<number> {
  try {
    const words = args.positional.slice(2);
    if (args.sub === "auth") {
      if (!process.stdin.isTTY || !await confirm("Offline owner credential administration. Continue?"))
        throw Object.assign(new Error("Interactive owner command required"), { code: "forbidden" });
      const [operation, role, actor, domains, destination, previous] = words;
      if (operation === "revoke") { await revokeTaskCredential(taskAuthPath(), role); return 0; }
      if (!["mint", "rotate"].includes(operation) || !["owner", "agent"].includes(role) || !destination)
        throw Object.assign(new Error("Use auth mint|rotate owner|agent actor domain[,domain] new-token-file [previous-id]"), { code: "validation" });
      const out = await open(destination, "wx", 0o600);
      try {
        const credential = await mintTaskCredential(taskAuthPath(), { role: role as "owner" | "agent", actor_id: actor, domains: domains.split(",") }, operation === "rotate" ? previous : undefined);
        await out.writeFile(credential.token); await out.sync();
        process.stdout.write(JSON.stringify({ credential_id: credential.credential_id, token_written: true }) + "\n");
      } finally { await out.close(); }
      return 0;
    }
    const agent = words[0] === "agent"; if (agent) words.shift();
    const input = words[0] ? await jsonFile(words[0]) : {};
    const authorization = agent ? await taskClientAuthorization() : `Bearer ${await taskPrivatePrompt("Owner task token (hidden): ")}`;
    if (!authorization) throw Object.assign(new Error("Agent task credential required"), { code: "unauthorized" });
    // Owner commands cannot accidentally inherit an agent mapping from a pasted token.
    if (!agent) {
      const principal = await authenticateTask(authorization);
      if (principal.role !== "owner") throw Object.assign(new Error("Owner credential required"), { code: "forbidden" });
    }
    process.stdout.write(JSON.stringify(await taskCliCall(args.sub ?? "list", input, authorization, resolveDaemonEndpoint().baseUrl), null, 2) + "\n");
    return 0;
  } catch (error) { process.stderr.write(JSON.stringify(taskFailure(error).body) + "\n"); return 1; }
}
