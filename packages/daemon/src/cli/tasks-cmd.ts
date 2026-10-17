import { tasksEnabled, TASKS_PREVIEW_HINT } from "../tasks-enabled.js";
import { ownerTaskMaintenance } from "./task-maintenance-cmd.js";
import { ownerTaskTargets } from "./task-targets.js";
import { loginOwnerTaskAccess, ownerTaskAuthorization } from "./task-owner-access.js";
import { declareTaskBoundary, enableTaskExecution } from "./task-execution-enable.js";
import { friendlyTaskCreate, friendlyTaskResult, friendlyTaskError, parseTaskOptions, taskWhen } from "./task-friendly.js";
import { setupTaskHooks, taskClientCoverage } from "./task-setup.js";
import { taskOwnerKeys, taskOwnerSign } from "./task-approval-cmd.js";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolveDaemonEndpoint } from "../daemon-endpoint.js";
import { authenticateTask, mintTaskCredential, revokeTaskCredential, taskAuthPath } from "../task-auth.js";
import { isTaskTool, taskClientAuthorization, taskFailure } from "../task-transport.js";
import { confirm } from "./prompt.js";

export class TaskCliInputError extends Error { readonly code = "validation"; }
export async function readTaskInputFile(path: string): Promise<unknown> {
  try {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 256 * 1024) throw new Error("Bounded JSON input required");
    return JSON.parse(await handle.readFile("utf8"));
  } finally { await handle.close(); }
  } catch { throw new TaskCliInputError("Die Eingabedatei fehlt, ist nicht lesbar oder enthält kein gültiges JSON (höchstens 256 KiB)."); }
}
/** Agent mode is explicit. Owner mode always asks privately, ignoring agent env. */
export async function taskCliCall(sub: string, input: unknown, authorization: string, baseUrl: string): Promise<unknown> {
  const operation = `task_${sub.replaceAll("-", "_")}`;
  if (!isTaskTool(operation)) throw Object.assign(new Error("Unknown task operation"), { code: "validation" });
  const resp = await fetch(`${baseUrl}/api/v1/${operation}`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: authorization }, body: JSON.stringify(input),
    signal: AbortSignal.timeout(10000),
  });
  const body = await resp.json() as { error?: string; code?: string;reason?:string };
  if (!resp.ok) throw Object.assign(new Error(body.error), { code: body.code, reason:body.reason, status: resp.status });
  return body;
}
export async function cmdTasks(args: { sub: string | null; positional: string[]; argv?: string[]; json?: boolean }): Promise<number> {
  if (!tasksEnabled()) { process.stdout.write((args.json ? JSON.stringify({ code: "feature_disabled", preview: true, hint: TASKS_PREVIEW_HINT }) : TASKS_PREVIEW_HINT) + "\n"); return 0; }
  try {
    const parsed = parseTaskOptions(args.argv ?? args.positional);
    const words = parsed.words, options = parsed.options;
    if (args.sub === "owner-login") { await loginOwnerTaskAccess(); return 0; }
    if (args.sub === "ui") { process.stdout.write(`${resolveDaemonEndpoint().baseUrl}/ui/#tasks (UI aktivieren: bastra config set ui.enabled true)\n`); return 0; }
    if (args.sub === "boundary") { await declareTaskBoundary(); return 0; }
    if (args.sub === "setup-hooks") { await setupTaskHooks(); return 0; }
    if (args.sub === "client-status") {
      const status = await taskClientCoverage(); process.stdout.write((args.json ? JSON.stringify(status) : `${status.authorized ? "Client-Kennung gültig (Daemon muss laufen)" : "Keine Karten für diesen Client"}: ${status.coverage}${"remedy" in status ? `; ${status.remedy}` : ""}`) + "\n"); return 0;
    }
    if (["recover","archive","archive-restore"].includes(args.sub??"")) { await ownerTaskMaintenance(args.sub!,words,options,args.json); return 0; }
    if (args.sub === "targets") { await ownerTaskTargets(words,options,args.json); return 0; }
    if (args.sub === "keys") { await taskOwnerKeys(words); return 0; }
    if (args.sub === "auth") {
      if (!process.stdin.isTTY || !await confirm("Zugang als Owner am Terminal verwalten? Token-Dateien müssen außerhalb des Agent-Zugriffs liegen."))
        throw Object.assign(new Error("Interactive owner command required"), { code: "forbidden" });
      const [operation, role, actor, domains, destination, previous] = words;
      if (operation === "revoke") { await revokeTaskCredential(taskAuthPath(), role); process.stdout.write((args.json?JSON.stringify({revoked:true,credential_id:role}):`Zugang ${role} widerrufen. Dieser Client erhält keine Karten mehr.`)+"\n"); return 0; }
      if (!["mint", "rotate"].includes(operation) || !["owner", "agent"].includes(role) || !destination)
        throw Object.assign(new Error("Use auth mint|rotate owner|agent actor domain[,domain] new-token-file [previous-id]"), { code: "validation" });
      const out = await open(destination, "wx", 0o600);
      try {
        const credential = await mintTaskCredential(taskAuthPath(), { role: role as "owner" | "agent", actor_id: actor, domains: domains.split(",") }, operation === "rotate" ? previous : undefined);
        await out.writeFile(credential.token); await out.sync();
        process.stdout.write((args.json ? JSON.stringify({ credential_id: credential.credential_id, token_written: true }) : `Zugang angelegt: ${role === "owner" ? "Owner" : "Agent"} ${actor}, Domänen ${domains}. Token privat in der gewählten Datei; jetzt bastra tasks setup-hooks. Kennung ${credential.credential_id}.`) + "\n");
      } finally { await out.close(); }
      return 0;
    }
    const agent = words[0] === "agent" || options.agent === true; if (words[0] === "agent") words.shift();
    const signing = args.sub === "approve" || args.sub === "deny";
    if (signing && agent) throw Object.assign(new Error("Owner signing terminal required"), { code: "forbidden" });
    let input: any = signing ? {} : options.input ? await readTaskInputFile(String(options.input)) : args.sub === "create" && options.goal ? (() => { try { return friendlyTaskCreate(options); } catch (error) { throw Object.assign(new TaskCliInputError(error instanceof Error ? error.message : "Zeit/Optionen ungültig"),{reason:(error as any)?.reason}); } })() : words[0]?.endsWith(".json") ? await readTaskInputFile(words[0]) : {};
    if(args.sub==="release" && words[0] && !words[0].endsWith(".json")) input.lease_id=words[0];
    if (args.sub!=="release" && (options.id || (words[0] && !words[0].endsWith(".json")))) input.id = String(options.id ?? words[0]);
    if (options.revision) input.expected_revision = options.revision;
    if (options.occurrence) input.occurrence_id = options.occurrence;
    const authorization = agent ? await taskClientAuthorization() : await ownerTaskAuthorization();
    if (!authorization) throw Object.assign(new Error("Agent task credential required"), { code: "unauthorized" });
    // Owner commands cannot accidentally inherit an agent mapping from a pasted token.
    if (!agent) {
      const principal = await authenticateTask(authorization);
      if (principal.role !== "owner") throw Object.assign(new Error("Owner credential required"), { code: "forbidden" });
    }
    if ((args.sub === "execution-enable" || args.sub === "resume")) { if (agent) throw Object.assign(new Error("Owner required"), { code: "forbidden" }); await enableTaskExecution(authorization); return 0; }
    if (signing) { await taskOwnerSign(words, args.sub as "approve" | "deny", authorization,args.json); return 0; }
    const baseUrl = resolveDaemonEndpoint().baseUrl;
    if (input.id && !["get", "create"].includes(args.sub ?? "list") && (!input.expected_revision || options.until)) {
      const task = await taskCliCall("get", { id: input.id }, authorization, baseUrl) as any; input.expected_revision ??= task.expected_revision;
      if (options.until) { try { input.until = taskWhen(String(options.until), task.timezone); } catch { throw new TaskCliInputError("Zeit nicht lesbar"); } }
    }
    if (args.sub === "due") input = { include_acknowledged: true, max_bytes: 16384 };
    const controls: Record<string, object> = { mute: { muted: true }, unmute: { muted: false }, off: { enabled: false }, on: { enabled: true }, stop: { execution_stopped: true }, resume: { execution_stopped: false } };
    const result = await taskCliCall(controls[args.sub ?? ""] ? "controls" : args.sub ?? "list", controls[args.sub ?? ""] ?? input, authorization, baseUrl);
    process.stdout.write((args.json ? JSON.stringify(result, null, 2) : friendlyTaskResult(args.sub ?? "list", result)) + "\n");
    if (!args.json && args.sub === "create" && options.goal && !options.timezone) process.stdout.write(`Zeitzone aus dem System angenommen: ${(result as any).timezone}. Mit --timezone bewusst festlegen.\n`);
    return 0;
  } catch (error) { const failure = taskFailure(error).body;
    if (error instanceof TaskCliInputError) failure.error = error.message;
    process.stderr.write((args.json ? JSON.stringify(failure) : error instanceof TaskCliInputError ? `${args.sub??"Aufgaben"}: ${failure.error}` : friendlyTaskError(failure.code, args.sub,failure.reason)) + "\n"); return 1; }
}
