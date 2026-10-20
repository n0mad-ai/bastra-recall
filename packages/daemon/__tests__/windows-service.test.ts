import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { windowsService, renderTaskXml, quoteWindowsArg, decodeServiceOutput, type ServiceExec } from "../src/cli/windows-service.js";
import { autostartWarning, refreshWindowsAutostart, autostartEnv } from "../src/cli/autostart.js";
import { configuredState, daemonOriginLines } from "../src/cli/daemon-origin-note.js";
import { daemonOrigin } from "../src/daemon-spawn-env.js";

const env = { BASTRA_AUTOSTART_MANAGED: "1", BASTRA_VAULT_PATH: 'C:\\Vault & notes', BASTRA_DAEMON_URL: "http://127.0.0.1:26723", BASTRA_HTTP_PORT: "26723", BASTRA_DAEMON_IDLE_SHUTDOWN_MS: "0" };
async function fixture(t: { after(fn: () => unknown): void }) {
  const directory = await mkdtemp(join(tmpdir(), "bastra-task-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = join(directory, "daemon & notes.js");
  await writeFile(script, "");
  const program = [process.execPath, script];
  let definition: string | null = null;
  let running = false;
  let failure: Error | null = null;
  let stopPolls = 0;
  let ending = false;
  let runFailure = false;
  const calls: Array<{ file: string; args: string[] }> = [];
  const exec: ServiceExec = async (file, args) => {
    calls.push({ file, args });
    if (failure) throw failure;
    if (file.endsWith("powershell.exe")) {
      if (ending && stopPolls-- <= 0) { running = false; ending = false; }
      return definition ? (running ? "4\r\n" : "3\r\n") : "MISSING\r\n";
    }
    assert.ok(file.endsWith("schtasks.exe"));
    if (args[0] === "/Query") return definition!;
    if (args[0] === "/Create") {
      const buffer = await readFile(args[args.indexOf("/XML") + 1]);
      assert.equal(buffer.readUInt16LE(), 0xfeff, "XML is UTF-16LE with BOM");
      definition = buffer.toString("utf16le").slice(1);
    }
    if (args[0] === "/Run") {
      assert.equal(ending, false, "Run must wait for asynchronous End to finish");
      if (runFailure) throw new Error("task launch refused");
      running = true;
    }
    if (args[0] === "/End") ending = true;
    if (args[0] === "/Delete") definition = null;
    return "SUCCESS";
  };
  const service = windowsService({ exec, directory, user: 'DOMAIN\\Jane & Doe', taskName: "Bastra-test" });
  return { directory, program, service, calls, setDefinition: (s: string) => { definition = s; }, setRunning: (v: boolean) => { running = v; }, setFailure: (e: Error) => { failure = e; }, delayStop: () => { stopPolls = 2; }, failRun: () => { runFailure = true; } };
}

test("Windows install is opt-in and registers an interactive logon task with failure supervision", async t => {
  const f = await fixture(t);
  assert.equal((await f.service.status()).exists, false);
  assert.equal(f.calls.some(c => c.args[0] === "/Create"), false);
  assert.deepEqual(await f.service.install(env, f.program, { reload: true }), { ok: true, detail: "" });
  const state = await f.service.status();
  assert.equal(state.managed, true);
  assert.equal(state.loaded, true);
  assert.deepEqual(state.program, f.program);
  assert.deepEqual(state.env, env);
  assert.equal(state.endpoint, env.BASTRA_DAEMON_URL);
  const create = f.calls.find(c => c.args[0] === "/Create")!;
  assert.deepEqual(create.args.slice(0, 4), ["/Create", "/TN", "Bastra-test", "/XML"]);
  assert.equal(create.args.includes("/F"), false, "new tasks never overwrite a collision");
  const definition = renderTaskXml(env, f.program, 'DOMAIN\\Jane & Doe');
  assert.match(definition, /<LogonTrigger>/);
  assert.match(definition, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(definition, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.match(definition, /<UserId>DOMAIN\\Jane &amp; Doe<\/UserId>/);
  assert.match(definition, /<ExecutionTimeLimit>PT0S/);
  assert.match(definition, /<RestartOnFailure><Interval>PT1M<\/Interval><Count>255/);
  assert.ok(f.calls.some(c => c.args[0] === "/Run"));
});

test("staged refresh preserves endpoint/env and never ends or runs the task", async t => {
  const f = await fixture(t);
  f.setDefinition(renderTaskXml(env, f.program, "Jane"));
  f.setRunning(true);
  const newScript = join(f.directory, "new version.js");
  await writeFile(newScript, "");
  const out = await refreshWindowsAutostart(() => {}, { target: { node: process.execPath, script: newScript, version: "2" }, reload: false }, f.service);
  assert.equal(out.ok, true);
  assert.deepEqual((await f.service.status()).env, env);
  assert.equal((await f.service.status()).program[1], newScript);
  assert.equal(f.calls.some(c => c.args[0] === "/Run" || c.args[0] === "/End"), false);
  assert.ok(f.calls.find(c => c.args[0] === "/Create")?.args.includes("/F"));
});

test("interactive refresh waits for an asynchronous End before Run", async t => {
  const f = await fixture(t);
  f.setDefinition(renderTaskXml(env, f.program, "Jane"));
  f.setRunning(true);
  f.delayStop();
  const result = await refreshWindowsAutostart(() => {}, { target: { node: f.program[0], script: f.program[1], version: "1" }, reload: true }, f.service);
  assert.equal(result.ok, true);
  assert.deepEqual(f.calls.filter(c => ["/End", "/Run"].includes(c.args[0])).map(c => c.args[0]), ["/End", "/Run"]);
});

test("foreign or edited tasks are never overwritten, deleted or kicked implicitly", async t => {
  const f = await fixture(t);
  f.setDefinition(renderTaskXml(env, f.program, "Jane").replace(/<Command>[^<]*<\/Command>/, "<Command>C:\\Foreign.exe</Command>"));
  assert.equal((await f.service.status()).managed, false);
  assert.equal((await f.service.install(env, f.program, { reload: true })).ok, false);
  assert.equal((await f.service.uninstall()).ok, false);
  assert.equal((await f.service.kickstart()).ok, false);
  assert.equal(f.calls.some(c => ["/Create", "/Delete", "/Run", "/End"].includes(c.args[0])), false);
  assert.equal((await refreshWindowsAutostart(() => {}, { target: null, reload: true }, f.service)).ok, true);
});

test("explicit force permits replacing a foreign task; uninstall ends and deletes only the managed task", async t => {
  const f = await fixture(t);
  f.setDefinition("<Task />");
  assert.equal((await f.service.install(env, f.program, { reload: true, force: true })).ok, true);
  assert.equal((await f.service.uninstall()).ok, true);
  assert.deepEqual(f.calls.filter(c => ["/End", "/Delete"].includes(c.args[0])).map(c => c.args[0]), ["/End", "/Delete"]);
  assert.equal((await f.service.status()).exists, false);
});

test("doctor reports a stopped task and a scheduler query error instead of claiming off", async t => {
  const f = await fixture(t);
  f.setDefinition(renderTaskXml(env, f.program, "Jane"));
  assert.match((await autostartWarning(f.service))!, /not running/);
  f.setRunning(true);
  assert.equal(await autostartWarning(f.service), null);
  f.setFailure(new Error("Access denied"));
  assert.match((await autostartWarning(f.service))!, /could not query.*Access denied/);
  await assert.rejects(f.service.install(env, f.program, { reload: true }), /Access denied/);
  assert.equal(f.calls.some(c => c.args[0] === "/Create"), false);
});

test("refresh neither enables missing autostart nor destroys a managed task when runtime is missing", async t => {
  const f = await fixture(t);
  assert.equal((await refreshWindowsAutostart(() => {}, { target: null, reload: true }, f.service)).ok, true);
  f.setDefinition(renderTaskXml(env, f.program, "Jane"));
  assert.equal((await refreshWindowsAutostart(() => {}, { target: null, reload: true }, f.service)).ok, false);
  assert.equal((await refreshWindowsAutostart(() => {}, { target: { node: f.program[0], script: join(f.directory, "missing"), version: null }, reload: true }, f.service)).ok, false);
  assert.equal(f.calls.some(c => c.args[0] === "/Create"), false);
});

test("Windows arguments preserve spaces, quotes and trailing backslashes without a command shell", () => {
  assert.equal(quoteWindowsArg('C:\\Program Files\\'), '"C:\\Program Files\\\\"');
  assert.equal(quoteWindowsArg('x"y'), '"x\\"y"');
});

test("managed Windows daemon is service-owned; forwarder retains priority over inherited service marker", () => {
  assert.equal(daemonOrigin(env, "win32").startedBy, "scheduled-task");
  assert.equal(daemonOrigin(env, "darwin").startedBy, "launchagent");
  assert.equal(daemonOrigin({ ...env, BASTRA_DAEMON_STARTED_BY: "forwarder" }, "win32").startedBy, "forwarder");
  assert.equal(autostartEnv("V", "C:\\node.exe", null, "win32").BASTRA_DAEMON_IDLE_SHUTDOWN_MS, "0");
});


test("a rejected scheduler Run fails the refresh instead of claiming the daemon restarted", async t => {
  const f = await fixture(t);
  f.setDefinition(renderTaskXml(env, f.program, "Jane"));
  f.failRun();
  const result = await refreshWindowsAutostart(() => assert.fail("must not report success"), { target: { node: f.program[0], script: f.program[1], version: null }, reload: true }, f.service);
  assert.equal(result.ok, false);
  assert.match(result.detail, /task launch refused/);
});


test("scheduler query uses a locale-independent numeric state and unwraps nested COM not-found errors", async t => {
  const f = await fixture(t);
  await f.service.status();
  const query = f.calls.find(c => c.file.endsWith("powershell.exe"))!;
  assert.deepEqual(query.args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
  const script = Buffer.from(query.args[3], "base64").toString("utf16le");
  // Structural check only: executing COM and confirming HRESULTs is part of
  // the explicitly outstanding real-Windows acceptance.
  assert.match(script, /ErrorActionPreference='Stop'/);
  assert.match(script, /while\(\$e.InnerException\)\{\$e=\$e.InnerException\}/);
  assert.match(script, /\$e.HResult -eq -2147024894/);
  assert.match(script, /else\{throw\}/);
  assert.match(script, /GetTask\('Bastra-test'\).State/);
});

test("scheduler output decoding supports Unicode XML with and without BOM and UTF-8", () => {
  const xml = '<Task><Description>äö\u6f22</Description></Task>';
  assert.equal(decodeServiceOutput(Buffer.from('\ufeff' + xml, "utf16le")), xml);
  assert.equal(decodeServiceOutput(Buffer.from(xml, "utf16le")), xml);
  assert.equal(decodeServiceOutput(Buffer.from(xml, "utf8")), xml);
});


test("Windows doctor labels Task Scheduler and its data directory while preserving Mac labels", () => {
  const configured = configuredState({ BASTRA_TASKS: "1" }, env, "win32")!;
  assert.ok(configured.sources.includes("the bastra Task Scheduler env"));
  assert.ok(configured.sources.includes("daemon.env in %LOCALAPPDATA%\\Bastra\\cli-settings.json"));
  const lines = daemonOriginLines({ ok: true, detail: "healthy", startedBy: "forwarder", envOrigin: "client+settings" }, configured, "win32").join("\n");
  assert.match(lines, /managed service is installed/);
  assert.match(lines, /%LOCALAPPDATA%/);
  assert.doesNotMatch(lines, /~\/\.bastra/);
  const owned = daemonOriginLines({ ok: true, detail: "healthy", startedBy: "scheduled-task" }, undefined, "win32").join("\n");
  assert.match(owned, /the bastra Task Scheduler task/);
  assert.ok(configuredState(undefined, env, "darwin")!.sources.includes("the bastra LaunchAgent env"));
});
