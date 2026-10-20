import { test } from "node:test";
import assert from "node:assert/strict";
import type { spawnSync } from "node:child_process";
import { cmdUpdate, detectInstallMode, packageRootFromCliPath, resolveInstalledRuntime, type UpdateIo } from "../src/cli/update.js";
import { parseArgs } from "../src/cli/commands.js";
import { npmInvocation, globalDaemonScript } from "../src/cli/update-npm.js";
import { verifyProvenance } from "../src/cli/update-preflight.js";

const node = 'C:\\Program Files\\nodejs\\node.exe';
const wrapper = 'C:\\Program Files\\nodejs\\npm.cmd';
const npmCli = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';
const npmPackage = 'C:\\Program Files\\nodejs\\node_modules\\npm\\package.json';
const prefix = 'C:\\Users\\Jane Doe\\AppData\\Roaming\\npm';
const root = prefix + '\\node_modules\\@bastra-recall\\daemon';
const script = root + '\\dist\\index.js';
const cli = root + '\\dist\\cli.js';

function fixture() {
  const files = new Map<string, string>([
    [npmCli, "npm cli"], [npmPackage, JSON.stringify({ name: "npm", bin: { npm: "bin/npm-cli.js" } })],
    [script, "daemon"], [cli, "new cli"], [root + '\\package.json', JSON.stringify({ version: "9.0.0" })],
  ]);
  const calls: Array<{ bin: string; args: string[]; opts: unknown }> = [];
  const refreshes: unknown[] = [];
  const questions: unknown[] = [];
  let inline = false;
  const spawn = ((bin: string, args: string[], opts: unknown) => {
    calls.push({ bin, args, opts });
    return { status: 0, stdout: "", stderr: "" };
  }) as typeof spawnSync;
  const io: UpdateIo = {
    platform: "win32", node, cliPath: root + '\\dist\\cli\\update.js',
    find: name => { assert.equal(name, "npm"); return wrapper; },
    exists: path => files.has(path), file: path => files.has(path),
    read: path => { const content = files.get(path); if (content === undefined) throw new Error("not found"); return content; },
    run: (bin, args, opts) => { calls.push({ bin, args, opts }); return { ok: true, signal: false, detail: "ok" }; },
    captured: (bin, args, opts) => { calls.push({ bin, args, opts }); return { ok: true, signal: false, detail: "ok", stdout: prefix, stderr: "" }; },
    spawn,
    preflight: async options => { assert.equal(options.root, root); assert.ok(options.verify); assert.equal(options.verify(root).ok, true); return { ok: true, dirty: [], notes: [] }; },
    reapply: () => {},
    manifest: async path => ({ root: path, version: "9", created_at: "now", files: [] }),
    clearBlocked: async () => {},
    install: async () => { inline = true; return 0; },
    refresh: async (_, options) => { refreshes.push(options); return { ok: true, detail: "ok" }; },
    service: () => null,
    ask: installed => { questions.push(installed); return null; },
  };
  return { io, files, calls, refreshes, questions, inline: () => inline };
}

test("Windows npm paths detect global and ephemeral installs and derive the correct package root", () => {
  assert.equal(detectInstallMode(root + '\\dist\\cli\\update.js').mode, "npm-global");
  assert.equal(detectInstallMode('C:\\Users\\Jane\\npm-cache\\_npx\\abc\\node_modules\\@bastra-recall\\daemon\\dist\\cli\\update.js').mode, "npm-global");
  assert.equal(packageRootFromCliPath(root + '\\dist\\cli\\update.js', "win32"), root);
  assert.equal(globalDaemonScript(prefix, fixture().io), script);
  assert.equal(globalDaemonScript("relative-prefix", fixture().io), null);
  assert.equal(detectInstallMode("/opt/homebrew/Cellar/bastra-recall/1/libexec/packages/daemon/dist/cli/update.js").mode, "brew");
  assert.equal(detectInstallMode("/usr/local/lib/node_modules/@bastra-recall/daemon/dist/cli/update.js").mode, "npm-global");
});

for (const staged of [true, false]) {
  test(`cmdUpdate Windows npm-global executes npm and the new CLI via Node (staged=${staged})`, async t => {
    t.mock.method(process.stdout, "write", () => true);
    const f = fixture();
    const args = parseArgs(["update", "--yes", "--vault", 'C:\\Vault & notes', ...(staged ? ["--staged"] : [])]);
    assert.equal(await cmdUpdate(args, f.io), 0);
    const audit = f.calls.find(c => c.args.includes("audit"))!;
    assert.deepEqual([audit.bin, ...audit.args], [node, npmCli, "audit", "signatures"]);
    const install = f.calls.find(c => c.args.includes("-g") && c.args.includes("install"))!;
    assert.deepEqual([install.bin, ...install.args], [node, npmCli, "install", "-g", "@bastra-recall/daemon@latest"]);
    const register = f.calls.find(c => c.args[0] === cli)!;
    assert.deepEqual([register.bin, ...register.args], [node, cli, "install", "all", "--no-ollama", "--no-stop-hook", "--yes", "--vault", 'C:\\Vault & notes']);
    assert.equal(f.inline(), false, "never pin registration from the old in-memory CLI");
    assert.deepEqual(f.questions, staged ? [] : [{ node, script, version: "9.0.0" }], "interactive asks once using the installed runtime; staged never asks");
    assert.deepEqual(f.refreshes, [{ target: { node, script, version: "9.0.0" }, reload: !staged, platform: "win32" }]);
    for (const call of f.calls) {
      assert.equal(call.bin, node, "all Windows update subprocesses execute Node, never .cmd");
      assert.equal((call.opts as { shell?: unknown }).shell, undefined);
    }
  });
}

test("ephemeral Windows updater hands off to the installed global CLI", async t => {
  t.mock.method(process.stdout, "write", () => true);
  const f = fixture();
  f.io.cliPath = 'C:\\Users\\Jane\\npm-cache\\_npx\\abc\\node_modules\\@bastra-recall\\daemon\\dist\\cli\\update.js';
  f.io.preflight = async () => ({ ok: true, dirty: [], notes: [] });
  assert.equal(await cmdUpdate(parseArgs(["update", "--staged"]), f.io), 0);
  assert.ok(f.calls.some(c => c.bin === node && c.args[0] === cli));
  assert.equal(f.inline(), false);
});

test("unknown npm wrapper or adjacent package fails explicitly without shell fallback or stale registration", async t => {
  t.mock.method(process.stdout, "write", () => true);
  t.mock.method(process.stderr, "write", () => true);
  for (const mutation of [
    (f: ReturnType<typeof fixture>) => { f.io.find = () => 'C:\\Tools\\npm.exe'; },
    (f: ReturnType<typeof fixture>) => { f.files.delete(npmCli); },
    (f: ReturnType<typeof fixture>) => { f.files.set(npmPackage, JSON.stringify({ name: "other", bin: { npm: "bin/npm-cli.js" } })); },
  ]) {
    const f = fixture(); mutation(f);
    assert.equal(await cmdUpdate(parseArgs(["update", "--staged"]), f.io), 1);
    assert.equal(f.inline(), false);
    assert.equal(f.refreshes.length, 0);
    assert.equal(f.calls.length, 0);
  }
});

test("missing newly installed CLI refuses the old-process fallback and leaves autostart alone", async t => {
  t.mock.method(process.stdout, "write", () => true);
  t.mock.method(process.stderr, "write", () => true);
  const f = fixture(); f.files.delete(cli);
  assert.equal(await cmdUpdate(parseArgs(["update", "--staged"]), f.io), 1);
  assert.equal(f.inline(), false);
  assert.equal(f.refreshes.length, 0);
});

test("Windows installed runtime is resolved from npm prefix and never from the updater's script", () => {
  const f = fixture();
  const mode = detectInstallMode(f.io.cliPath);
  assert.deepEqual(resolveInstalledRuntime(mode, f.io), { node, script, version: "9.0.0" });
  f.files.delete(script);
  assert.equal(resolveInstalledRuntime(mode, f.io), null);
});

test("POSIX npm invocation and global layout retain the existing executable and lib directory", () => {
  const invocation = npmInvocation({ platform: "linux", find: () => "/usr/local/bin/npm" });
  assert.deepEqual(invocation, { bin: "/usr/local/bin/npm", args: [] });
  assert.equal(globalDaemonScript("/usr/local", { platform: "linux", exists: path => path === "/usr/local/lib/node_modules/@bastra-recall/daemon/dist/index.js" }), "/usr/local/lib/node_modules/@bastra-recall/daemon/dist/index.js");
  assert.equal(packageRootFromCliPath("/usr/local/lib/node_modules/@bastra-recall/daemon/dist/cli/update.js", "darwin"), "/usr/local/lib/node_modules/@bastra-recall/daemon");
});

test("provenance audit uses the same shell-free Windows npm invocation", () => {
  const f = fixture();
  assert.equal(verifyProvenance(root, f.io, f.io.spawn).ok, true);
  assert.deepEqual(f.calls[0].args, [npmCli, "audit", "signatures"]);
  assert.equal((f.calls[0].opts as { cwd: string }).cwd, root);
});
