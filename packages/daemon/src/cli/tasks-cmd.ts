import { tasksEnabled, TASKS_PREVIEW_HINT } from "../tasks-enabled.js";
import { ownerTaskMaintenance } from "./task-maintenance-cmd.js";
import { ownerTaskTargets } from "./task-targets.js";
import { loginOwnerTaskAccess, ownerTaskAuthorization } from "./task-owner-access.js";
import { declareTaskBoundary, enableTaskExecution } from "./task-execution-enable.js";
import {
  friendlyTaskCreate,
  friendlyTaskResult,
  friendlyTaskError,
  parseTaskOptions,
  taskWhen,
} from "./task-friendly.js";
import { setupTaskHooks, taskClientCoverage } from "./task-setup.js";
import { taskCliLanguage, taskCliWords } from "./task-cli-words.js";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolveDaemonEndpoint } from "../daemon-endpoint.js";
import { authenticateTask, mintTaskCredential, revokeTaskCredential, taskAuthPath } from "../task-auth.js";
import { isTaskTool, taskClientAuthorization, taskFailure } from "../task-transport.js";
import { taskCliCall, taskCliOperationName } from "./task-cli-call.js";
import { confirm } from "./prompt.js";

/** A CLI input error with a stable reason the person reads in the CLI's language. */
export class TaskCliInputError extends Error {
  readonly code = "validation";
  constructor(
    message: string,
    readonly reason?: string
  ) {
    super(message);
  }
}
export async function readTaskInputFile(path: string): Promise<unknown> {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 256 * 1024) throw new Error("Bounded JSON input required");
      return JSON.parse(await handle.readFile("utf8"));
    } finally {
      await handle.close();
    }
  } catch {
    throw new TaskCliInputError(
      "The input file is missing, not readable or not valid JSON (at most 256 KiB)",
      "input_file_unreadable"
    );
  }
}
/** Error text for the terminal, in the task CLI's language (#1594, #1602). */
function taskCliErrorText(error: unknown, sub: string | null, language: string, json?: boolean): string {
  const failure = taskFailure(error).body;
  if (error instanceof TaskCliInputError) Object.assign(failure, { error: error.message, reason: error.reason });
  if (json) return JSON.stringify(failure);
  return friendlyTaskError(failure.code, sub, failure.reason, language);
}
type TaskCliArgs = { sub: string | null; positional: string[]; argv?: string[]; json?: boolean };
type TaskCliOptions = ReturnType<typeof parseTaskOptions>["options"];
interface LocalTaskCommand {
  args: TaskCliArgs;
  words: string[];
  options: TaskCliOptions;
  w: ReturnType<typeof taskCliWords>;
}

/** Sub-commands handled on this machine; everything else is a task API call. */
const localTaskCommands = new Map<string, (command: LocalTaskCommand) => Promise<unknown>>([
  ["owner-login", () => loginOwnerTaskAccess()],
  [
    "ui",
    async ({ w }) => {
      process.stdout.write(`${resolveDaemonEndpoint().baseUrl}/ui/#tasks ${w.uiHint}\n`);
    },
  ],
  ["boundary", () => declareTaskBoundary()],
  ["setup-hooks", () => setupTaskHooks()],
  ["client-status", printTaskClientStatus],
  ["targets", ({ words, options, args }) => ownerTaskTargets(words, options, args.json)],
  ["auth", ownerTaskCredentialCommand],
]);

/** Plain switches of the task runtime, sent as `task_controls`. */
const TASK_CONTROLS: Record<string, object> = {
  mute: { muted: true },
  unmute: { muted: false },
  off: { enabled: false },
  on: { enabled: true },
  stop: { execution_stopped: true },
  resume: { execution_stopped: false },
};

export async function cmdTasks(args: TaskCliArgs): Promise<number> {
  if (!tasksEnabled()) {
    process.stdout.write(
      (args.json
        ? JSON.stringify({ code: "feature_disabled", preview: true, hint: TASKS_PREVIEW_HINT })
        : TASKS_PREVIEW_HINT) + "\n"
    );
    return 0;
  }
  const language = await taskCliLanguage(),
    w = taskCliWords(language);
  try {
    const { words, options } = parseTaskOptions(args.argv ?? args.positional);
    const local = localTaskCommands.get(args.sub ?? "");
    if (local) await local({ args, words, options, w });
    else if (isOwnerMaintenance(args.sub, words, options))
      await ownerTaskMaintenance(args.sub!, words, options, args.json);
    else {
      // Reject unknown commands before reading input or looking up authorization.
      const sub = args.sub ?? "list";
      if (sub !== "execution-enable" && !Object.hasOwn(TASK_CONTROLS, sub) && !isTaskTool(taskCliOperationName(sub)))
        throw new TaskCliInputError("Unknown task operation", "unknown_task_operation");
      await runTaskApiCommand(args, words, options, language, w);
    }
    return 0;
  } catch (error) {
    process.stderr.write(taskCliErrorText(error, args.sub, language, args.json) + "\n");
    return 1;
  }
}

async function printTaskClientStatus({ args, w }: LocalTaskCommand): Promise<void> {
  const status = await taskClientCoverage();
  process.stdout.write(
    (args.json
      ? JSON.stringify(status)
      : `${status.authorized ? w.clientValid : w.clientNoCards}: ${status.coverage}${"remedy" in status ? `; ${status.remedy}` : ""}`) +
      "\n"
  );
}

/** Owner archive maintenance; `archive` in agent mode is an API call instead. */
function isOwnerMaintenance(sub: string | null, words: string[], options: TaskCliOptions): boolean {
  return ["recover", "archive-restore", ...(options.agent || words[0] === "agent" ? [] : ["archive"])].includes(
    sub ?? ""
  );
}

/** `tasks auth mint|rotate|revoke`: interactive owner credential management. */
async function ownerTaskCredentialCommand({ args, words, w }: LocalTaskCommand): Promise<void> {
  if (!process.stdin.isTTY || !(await confirm(w.authConfirm)))
    throw Object.assign(new Error("Interactive owner command required"), { code: "forbidden" });
  const [operation, role, actor, domains, destination, previous] = words;
  if (operation === "revoke") {
    await revokeTaskCredential(taskAuthPath(), role);
    process.stdout.write(
      (args.json ? JSON.stringify({ revoked: true, credential_id: role }) : w.authRevoked(role)) + "\n"
    );
    return;
  }
  if (!["mint", "rotate"].includes(operation) || !["owner", "agent"].includes(role) || !destination)
    throw Object.assign(
      new Error("Use auth mint|rotate owner|agent actor domain[,domain] new-token-file [previous-id]"),
      {
        code: "validation",
      }
    );
  const out = await open(destination, "wx", 0o600);
  try {
    const credential = await mintTaskCredential(
      taskAuthPath(),
      { role: role as "owner" | "agent", actor_id: actor, domains: domains.split(",") },
      operation === "rotate" ? previous : undefined
    );
    await out.writeFile(credential.token);
    await out.sync();
    process.stdout.write(
      (args.json
        ? JSON.stringify({ credential_id: credential.credential_id, token_written: true })
        : w.authMinted(role, actor, domains, credential.credential_id)) + "\n"
    );
  } finally {
    await out.close();
  }
}

/** One call to the daemon's task API, with the body built from words and options. */
async function runTaskApiCommand(
  args: TaskCliArgs,
  words: string[],
  options: TaskCliOptions,
  language: string,
  w: ReturnType<typeof taskCliWords>
): Promise<void> {
  const agent = words[0] === "agent" || options.agent === true;
  if (words[0] === "agent") words.shift();
  let input = addTaskTargets(args.sub, await readTaskCliInput(args.sub, words, options), words, options);
  const authorization = await taskCliAuthorization(agent);
  if (args.sub === "execution-enable" || (args.sub === "resume" && !input.id))
    return enableTaskExecution(authorization);
  if (agent && args.sub === "archive") input = await agentArchiveInput(words, options);
  const baseUrl = resolveDaemonEndpoint().baseUrl;
  await fillFromCurrentTask(args.sub, input, options, authorization, baseUrl);
  const [operation, body] = taskApiRequest(args.sub, input);
  const result = await taskCliCall(operation, body, authorization, baseUrl);
  process.stdout.write(
    (args.json ? JSON.stringify(result, null, 2) : friendlyTaskResult(args.sub ?? "list", result, language)) + "\n"
  );
  if (!args.json && args.sub === "create" && options.goal && !options.timezone)
    process.stdout.write(w.timezoneAssumed((result as any).timezone) + "\n");
}

/** Which task operation the sub-command calls, and with which body. */
function taskApiRequest(sub: string | null, input: any): [string, unknown] {
  if (sub === "due") return ["due", { include_acknowledged: true, max_bytes: 16384 }];
  // #1644: own keys only, so `toString` or `__proto__` stay unknown commands.
  const control = sub === "resume" && input.id ? undefined : Object.hasOwn(TASK_CONTROLS, sub ?? "");
  return control ? ["controls", TASK_CONTROLS[sub!]] : [sub ?? "list", input];
}

/** The request body: an input file, the friendly create options, or empty. */
async function readTaskCliInput(sub: string | null, words: string[], options: TaskCliOptions): Promise<any> {
  if (options.input) return readTaskInputFile(String(options.input));
  if (sub === "create" && options.goal) {
    try {
      return friendlyTaskCreate(options);
    } catch (error) {
      throw new TaskCliInputError(
        error instanceof Error ? error.message : "Invalid time or options",
        (error as any)?.reason
      );
    }
  }
  return words[0]?.endsWith(".json") ? readTaskInputFile(words[0]) : {};
}

/** Task, lease, revision, archive and occurrence named on the command line. */
function addTaskTargets(sub: string | null, input: any, words: string[], options: TaskCliOptions): any {
  const named = words[0] && !words[0].endsWith(".json");
  if (sub === "release" && named) input.lease_id = words[0];
  if (sub !== "release" && (options.id || named)) input.id = String(options.id ?? words[0]);
  if (options.revision) input.expected_revision = options.revision;
  if (options.archive) input.archive_id = String(options.archive);
  if (options.occurrence) input.occurrence_id = options.occurrence;
  return input;
}

/** Agent mode is explicit. Owner mode always asks privately, ignoring agent env. */
async function taskCliAuthorization(agent: boolean): Promise<string> {
  const authorization = agent ? await taskClientAuthorization() : await ownerTaskAuthorization();
  if (!authorization) throw Object.assign(new Error("Agent task credential required"), { code: "unauthorized" });
  // Owner commands cannot accidentally inherit an agent mapping from a pasted token.
  if (!agent) {
    const principal = await authenticateTask(authorization);
    if (principal.role !== "owner") throw Object.assign(new Error("Owner credential required"), { code: "forbidden" });
  }
  return authorization;
}

/** `tasks archive --agent`: the named tasks against the current store revision. */
async function agentArchiveInput(words: string[], options: TaskCliOptions) {
  const { readTaskStore, tasksPath } = await import("../task-store.js");
  const snapshot = await readTaskStore(tasksPath());
  return {
    task_ids: words.length
      ? words
      : String(options.id ?? "")
          .split(",")
          .filter(Boolean),
    expected_revision: snapshot.revision,
    recovery_epoch: snapshot.recovery_epoch,
  };
}

/** For a named task without a revision, or with a time to resolve in its timezone,
 *  revision and times come from the task as the daemon has it now. */
async function fillFromCurrentTask(
  sub: string | null,
  input: any,
  options: TaskCliOptions,
  authorization: string,
  baseUrl: string
): Promise<void> {
  if (
    !input.id ||
    ["get", "create"].includes(sub ?? "list") ||
    (input.expected_revision && !options.until && !options.expires)
  )
    return;
  const task = await currentTask(sub, input, authorization, baseUrl);
  if (!task) throw Object.assign(new Error("Task absent"), { code: "not_found" });
  input.expected_revision ??= task.expected_revision;
  if (options.until) {
    try {
      input.until = taskWhen(String(options.until), task.timezone);
    } catch {
      throw new TaskCliInputError("Time not readable", "time_format");
    }
  }
  if (sub === "edit" && options.expires)
    input.patch = {
      ...input.patch,
      expires_at: options.expires === "none" ? null : taskWhen(String(options.expires), task.timezone),
    };
}

/** The named task, from its archive when deleting an archived one. */
async function currentTask(sub: string | null, input: any, authorization: string, baseUrl: string): Promise<any> {
  return input.archive_id && sub === "delete"
    ? ((await taskCliCall("list", { archive_id: input.archive_id }, authorization, baseUrl)) as any).tasks.find(
        (t: any) => t.id === input.id
      )
    : ((await taskCliCall("get", { id: input.id }, authorization, baseUrl)) as any);
}
