/** #1304: registration evidence survives the installed Node/stub boundary. */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexRuntimeVersion } from "../src/cli/codex-cli.js";
import { fileURLToPath } from "node:url";
import { codexGateSupported } from "../src/codex-gate-capability.js";
import { codexGateRegistered, inspectCodexGateRegistration, planCodexHooks } from "../src/cli/adapters/codex.js";
import { hookGateAvailable } from "../src/hook-surface.js";
import { hookWrapper } from "../src/cli/adapters/command-paths.js";

const VERSION = "0.162.1";
const entries = (hooks: Record<string, unknown[]>) => Object.values(hooks).flat() as Array<{matcher?: string; hooks: Array<{command: string}>}>;

for (const version of [undefined, null, "", "0.161.9", "0.162.0", "0.162.1-alpha.1", "0.162.2", "1.0.0", "unknown", "0.162.1"]) {
  test(`#1304 strict evidence gate: ${version ?? "unknown"}`, () => {
    const capable = version === VERSION;
    assert.equal(codexGateSupported(version), capable);
    assert.equal(hookGateAvailable({bastra_client: "codex", bastra_codex_version: version}), capable);
    const installed = planCodexHooks("install", {}, {includeStop: true, codexVersion: version, stubPresent: false}).after;
    const gate = entries(installed).filter(e => e.matcher === "*");
    assert.equal(gate.length, capable ? 1 : 0);
    assert.equal(codexGateRegistered(installed, version), capable);
    for (const entry of entries(installed)) {
      assert.equal(entry.hooks[0]!.command.includes("BASTRA_CODEX_VERSION="), capable);
    }
    assert.match((installed.SessionStart[0] as {matcher: string}).matcher, /\|fork$/);
  });
}

test("#1304 upgrade preserves old SessionStart wrappers; downgrade removes gate and owned markers", () => {
  for (const platform of ["darwin", "win32"]) for (const stubPresent of [true, false]) {
    const opts = {includeStop: true, stubPresent, platform};
    const old = planCodexHooks("install", {}, opts).after;
    const session = old.SessionStart[0] as {matcher: string; hooks: Array<{command: string}>};
    session.matcher = "startup|resume|clear|compact";
    session.hooks[0]!.command = `hook-timer --tag session ${session.hooks[0]!.command} >> hook.log`;
    const upgraded = planCodexHooks("install", old, {...opts, codexVersion: VERSION}).after;
    const command = (upgraded.SessionStart[0] as typeof session).hooks[0]!.command;
    assert.match(command, /^hook-timer --tag session /);
    assert.match(command, / >> hook.log$/);
    assert.ok(codexGateRegistered(upgraded, VERSION));
    assert.deepEqual(planCodexHooks("install", upgraded, {...opts, codexVersion: VERSION}).after, upgraded);
    const downgraded = planCodexHooks("install", upgraded, opts).after;
    assert.ok(!JSON.stringify(downgraded).includes("CODEX_VERSION"));
    assert.ok(!JSON.stringify(downgraded).includes("--codex-version="));
    assert.equal(entries(downgraded).filter(e => e.matcher === "*").length, 0);
    assert.match((downgraded.SessionStart[0] as typeof session).hooks[0]!.command, /^hook-timer --tag session /);
    assert.equal(entries(planCodexHooks("uninstall", upgraded, opts).after).length, 0);
  }
});

test("#1304 doctor rejects a gate without matching prompt/session evidence or catch-all", () => {
  assert.equal(codexGateRegistered({PreToolUse: [null, {hooks: [null]}]}, VERSION), false);
  const installed = planCodexHooks("install", {}, {includeStop: false, codexVersion: VERSION, stubPresent: false}).after;
  for (const event of ["PreToolUse", "SessionStart", "UserPromptSubmit"] as const) {
    const stale = structuredClone(installed);
    const target = entries({event: stale[event]}).find(e => event !== "PreToolUse" || e.matcher === "*")!;
    target.hooks[0]!.command = target.hooks[0]!.command.replace("BASTRA_CODEX_VERSION=0.162.1 ", "");
    assert.equal(codexGateRegistered(stale, VERSION), false, event);
  }
  const restricted = structuredClone(installed);
  entries({event: restricted.PreToolUse}).find(e => e.matcher === "*")!.matcher = "^Bash$";
  assert.equal(codexGateRegistered(restricted, VERSION), false);
  assert.deepEqual(hookWrapper('node /pkg/gate-hook.js --client=codex --codex-version=0.162.1 >> log', 'gate-hook.js'), {prefix: '', suffix: ' >> log'});
});

test("#1304 both client markers cross Node/stub transport, with env and Windows argv", async () => {
  const received: unknown[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received.push(JSON.parse(body));
    res.end('{}');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    for (const stub of [false, true]) for (const argv of [false, true]) {
      const path = fileURLToPath(new URL(stub ? "../stub/bastra-hook.ts" : "../src/gate-hook.ts", import.meta.url));
      const args = ["--import", "tsx", path, ...(stub ? ["gate"] : []), ...(argv ? ["--client=codex", "--codex-version=0.162.1"] : [])];
      const child: ChildProcessWithoutNullStreams = spawn(process.execPath, args, {env: {...process.env,
        BASTRA_DAEMON_URL: `http://127.0.0.1:${address.port}`, BASTRA_HOOK_TIMEOUT_MS: "1500",
        BASTRA_HOOK_CLIENT: argv ? "claude-code" : "codex", BASTRA_CODEX_VERSION: argv ? "0.162.0" : VERSION,
      }, stdio: ["pipe", "pipe", "pipe"]});
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => stderr += chunk);
      child.stdin.end(JSON.stringify({hook_event_name: "PreToolUse", session_id: "codex-gate-transport", tool_name: "view_image", tool_input: {path: "/tmp/a.png"}}));
      const [status] = await once(child, "close") as [number | null, NodeJS.Signals | null];
      assert.equal(status, 0, stderr);
      const payload = (received.at(-1) as {payload?: Record<string, unknown>}).payload;
      assert.equal(payload?.bastra_client, "codex", `${stub}/${argv}`);
      assert.equal(payload?.bastra_codex_version, VERSION, `${stub}/${argv}`);
      assert.equal(hookGateAvailable(payload), true);
    }
    assert.equal(received.length, 4);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});


test("#1304 version probe reads only the selected executable's stable --version output", {skip: process.platform === "win32"}, async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-version-1304-"));
  try {
    const bin = join(dir, "codex-fixture");
    for (const [output, expected] of [["codex-cli 0.162.1", VERSION], ["codex-cli 0.162.0", "0.162.0"], ["codex-cli 0.162.2", "0.162.2"], ["codex-cli 0.162.1-alpha.1", null], ["unrecognized", null]] as const) {
      await writeFile(bin, `#!${process.execPath}\nif (process.argv.slice(2).join(' ') !== '--version') process.exit(2);\nconsole.log(${JSON.stringify(output)});\n`, {mode: 0o700});
      assert.equal(codexRuntimeVersion(bin), expected);
    }
    await writeFile(bin, `#!${process.execPath}\nprocess.exit(1);\n`);
    assert.equal(codexRuntimeVersion(bin), null);
  } finally { await rm(dir, {recursive: true, force: true}); }
});


test("#1304 doctor reports stale registration broken after runtime upgrade/downgrade, including orphaned hint markers", () => {
  const hooks = planCodexHooks("install", {}, {includeStop: true, codexVersion: VERSION, stubPresent: false}).after;
  assert.deepEqual(inspectCodexGateRegistration(hooks, VERSION), {registered: true, stale: false, broken: false});
  for (const version of ["0.163.0", "0.161.0", null]) {
    assert.deepEqual(inspectCodexGateRegistration(hooks, version), {registered: false, stale: true, broken: true});
    const withoutGate = {...hooks, PreToolUse: hooks.PreToolUse.filter(e => (e as {matcher?: string}).matcher !== "*")};
    assert.deepEqual(inspectCodexGateRegistration(withoutGate, version), {registered: false, stale: true, broken: true});
    const repaired = planCodexHooks("install", hooks, {includeStop: true, codexVersion: version, stubPresent: false}).after;
    assert.deepEqual(inspectCodexGateRegistration(repaired, version), {registered: false, stale: false, broken: false});
  }
});


test("#1304 reinstall/downgrade preserve quoted wrapper marker literals while replacing owned assignments", () => {
  for (const stubPresent of [false, true]) for (const label of [
    "'note BASTRA_CODEX_VERSION=custom value BASTRA_HOOK_CLIENT=codex text'",
    '\"note BASTRA_CODEX_VERSION=0.162.1 value BASTRA_HOOK_CLIENT=codex text\"',
    "'BASTRA_HOOK_CLIENT=codex'",
    "'BASTRA_CODEX_VERSION=0.162.1'",
  ]) {
    const opts = {includeStop: true, stubPresent, codexVersion: VERSION};
    const installed = planCodexHooks("install", {}, opts).after;
    const session = installed.SessionStart[0] as {hooks: Array<{command: string}>};
    const prefix = `hook-timer --label ${label} `;
    session.hooks[0]!.command = `${prefix}${session.hooks[0]!.command} >> hook.log`;
    const again = planCodexHooks("install", installed, opts).after;
    assert.equal((again.SessionStart[0] as typeof session).hooks[0]!.command, session.hooks[0]!.command);
    assert.deepEqual(planCodexHooks("install", again, opts).after, again);
    const downgraded = planCodexHooks("install", again, {...opts, codexVersion: "0.163.0"}).after;
    const plain = planCodexHooks("install", {}, {...opts, codexVersion: "0.163.0"}).after;
    const legacyCommand = (plain.SessionStart[0] as typeof session).hooks[0]!.command;
    assert.equal((downgraded.SessionStart[0] as typeof session).hooks[0]!.command, `${prefix}${legacyCommand} >> hook.log`);
    assert.deepEqual(planCodexHooks("install", downgraded, {...opts, codexVersion: "0.163.0"}).after, downgraded);
  }
});
