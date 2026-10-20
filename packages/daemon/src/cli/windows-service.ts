/** Task Scheduler backend. All commands are execFile calls, never cmd/shell strings.
 * XML LogonTrigger is the /SC ONLOGON equivalent. Task Scheduler owns crash
 * recovery; hooks must not add a second supervisor or wake a stopped service.
 * https://learn.microsoft.com/en-us/windows/win32/taskschd/logon-trigger-example--xml-
 * https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-restartonfailure-settingstype-element
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { userInfo } from "node:os";
import { join, win32 } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { bastraDataDir } from "../platform-paths.js";
import type { AutostartState } from "./autostart.js";

export interface ServiceResult { ok: boolean; detail: string }
export interface AutostartService {
  status(): Promise<AutostartState>;
  install(env: Record<string, string>, program: string[], opts: { reload: boolean; force?: boolean }): Promise<ServiceResult>;
  uninstall(opts?: { force?: boolean }): Promise<ServiceResult>;
  kickstart(): Promise<ServiceResult>;
}
export type ServiceExec = (file: string, args: string[]) => Promise<string>;
/** schtasks /XML may write UTF-16LE even when stdout is a pipe. */
export function decodeServiceOutput(output: Buffer): string {
  const utf16 = output.length >= 2 && (output.readUInt16LE() === 0xfeff || (output[0] !== 0 && output[1] === 0));
  return output.toString(utf16 ? "utf16le" : "utf8").replace(/^\ufeff/, "");
}
const execute: ServiceExec = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { encoding: "buffer", timeout: 15_000, windowsHide: true }, (error, stdout, stderr) => {
    if (error) reject(Object.assign(error, { detail: decodeServiceOutput(stderr).trim() || error.message }));
    else resolve(decodeServiceOutput(stdout));
  });
});
/** Ownership marker, not an authentication boundary: tasks belong to this user. */
const PREFIX = "Bastra managed autostart v1:";
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const unxml = (s: string) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
/** Windows CommandLineToArgvW quoting, not cmd.exe quoting. */
export function quoteWindowsArg(s: string): string {
  return '"' + s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
}
function actionArgs(env: Record<string, string>, script: string): string {
  // Task Scheduler has no EnvironmentVariables element. Set the persisted
  // environment inside Node, then import the ESM entry point without a shell.
  const payload = Buffer.from(JSON.stringify({ env, script })).toString("base64");
  const bootstrap = `const c=JSON.parse(Buffer.from('${payload}','base64'));Object.assign(process.env,c.env);import(require('node:url').pathToFileURL(c.script).href).catch(e=>{console.error(e);process.exitCode=1})`;
  return ["-e", bootstrap].map(quoteWindowsArg).join(" ");
}
/** Count is unsignedByte in the Scheduler XML schema: at most 255 retries. */
export function renderTaskXml(env: Record<string, string>, program: string[], user: string): string {
  const metadata = PREFIX + Buffer.from(JSON.stringify({ env, program })).toString("base64");
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>${metadata}</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(user)}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Bastra"><UserId>${xml(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>255</Count></RestartOnFailure></Settings>
  <Actions Context="Bastra"><Exec><Command>${xml(program[0])}</Command><Arguments>${xml(actionArgs(env, program[1]))}</Arguments></Exec></Actions>
</Task>\n`;
}

export function windowsService(opts: { exec?: ServiceExec; user?: string; directory?: string; taskName?: string } = {}): AutostartService {
  const exec = opts.exec ?? execute;
  const user = opts.user ?? (process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${userInfo().username}` : userInfo().username);
  // Per-user task names avoid sharing an autostart definition across accounts.
  const taskName = opts.taskName ?? `Bastra-${createHash("sha256").update(user.toLowerCase()).digest("hex").slice(0, 16)}`;
  const directory = opts.directory ?? bastraDataDir(undefined, { platform: "win32" });
  const path = join(directory, "autostart-task.xml");
  const scheduler = win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "schtasks.exe");
  const powershell = win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  async function status(): Promise<AutostartState> {
    const state: AutostartState = { path: taskName, exists: false, managed: false, program: [], loaded: false, missingProgramPath: null, danglingProgram: false, endpoint: null, env: {} };
    // COM State=4 is running, independent of Windows display language. Only
    // ERROR_FILE_NOT_FOUND means absent; access/service/query failures throw.
    const script = `$ErrorActionPreference='Stop';try{$s=New-Object -ComObject Schedule.Service;$s.Connect();$s.GetFolder('\\').GetTask('${taskName.replace(/'/g, "''")}').State}catch{$e=$_.Exception;while($e.InnerException){$e=$e.InnerException};if($e.HResult -eq -2147024894){'MISSING'}else{throw}}`;
    const raw = await exec(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]);
    if (raw.trim() === "MISSING") return state;
    if (!/^[1-4]$/.test(raw.trim())) throw new Error("Could not determine Task Scheduler state");
    state.loaded = raw.trim() === "4";
    const definition = await exec(scheduler, ["/Query", "/TN", taskName, "/XML"]);
    state.exists = true;
    try {
      const description = /<Description>([^<]*)<\/Description>/.exec(definition)?.[1] ?? "";
      if (description.startsWith(PREFIX)) {
        const data = JSON.parse(Buffer.from(description.slice(PREFIX.length), "base64").toString("utf8"));
        if (Array.isArray(data.program) && data.program.length === 2 && data.program.every((v: unknown) => typeof v === "string") && data.env?.BASTRA_AUTOSTART_MANAGED === "1" && Object.values(data.env).every(v => typeof v === "string")) {
          // Marker alone does not authorize replacing a task whose action was changed.
          const command = unxml(/<Command>([^<]*)<\/Command>/.exec(definition)?.[1] ?? "");
          const args = unxml(/<Arguments>([^<]*)<\/Arguments>/.exec(definition)?.[1] ?? "");
          if ((definition.match(/<Exec>/g) ?? []).length === 1 && command === data.program[0] && args === actionArgs(data.env, data.program[1])) {
            state.managed = true; state.program = data.program; state.env = data.env;
            state.endpoint = data.env.BASTRA_DAEMON_URL ?? null;
          }
        }
      }
    } catch { /* unreadable means foreign */ }
    state.missingProgramPath = state.program.find(p => !existsSync(p)) ?? null;
    state.danglingProgram = state.missingProgramPath !== null;
    return state;
  }
  async function run(args: string[]): Promise<ServiceResult> {
    try { await exec(scheduler, args); return { ok: true, detail: "" }; }
    catch (error) { return { ok: false, detail: (error as { detail?: string }).detail ?? (error as Error).message }; }
  }
  async function waitForRunning(expected: boolean): Promise<ServiceResult> {
    for (let attempt = 0; attempt < 50; attempt++) {
      if ((await status()).loaded === expected) return { ok: true, detail: "" };
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return { ok: false, detail: expected ? "task did not enter running state" : "task did not stop" };
  }
  async function kickstart(): Promise<ServiceResult> {
    const state = await status();
    if (!state.managed) return { ok: false, detail: "no managed autostart" };
    if (state.loaded) {
      const stopped = await run(["/End", "/TN", taskName]);
      if (!stopped.ok) return stopped;
      const ended = await waitForRunning(false);
      if (!ended.ok) return ended;
    }
    const started = await run(["/Run", "/TN", taskName]);
    return started.ok ? waitForRunning(true) : started;
  }
  return {
    status,
    kickstart,
    async install(env, program, options) {
      const state = await status();
      if (state.exists && !state.managed && !options.force) return { ok: false, detail: "task was not written by bastra; use --force to replace it" };
      await mkdir(directory, { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, Buffer.from('\ufeff' + renderTaskXml(env, program, user), "utf16le"));
        const result = await run(["/Create", "/TN", taskName, "/XML", temporary, ...(state.managed || options.force ? ["/F"] : [])]);
        if (!result.ok) return result;
        return options.reload ? kickstart() : result;
      } finally { await unlink(temporary).catch(() => {}); }
    },
    async uninstall(options = {}) {
      const state = await status();
      if (!state.exists) return { ok: true, detail: "already off" };
      if (!state.managed && !options.force) return { ok: false, detail: "task was not written by bastra" };
      if (state.loaded) {
        const stopped = await run(["/End", "/TN", taskName]);
        if (!stopped.ok) return stopped;
        const ended = await waitForRunning(false);
        if (!ended.ok) return ended;
      }
      return run(["/Delete", "/TN", taskName, "/F"]);
    },
  };
}
