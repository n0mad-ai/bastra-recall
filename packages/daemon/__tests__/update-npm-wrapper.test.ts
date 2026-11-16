/**
 * `bastra update` for an `npm install -g bastra-recall` installation.
 *
 * The README installs the wrapper package `bastra-recall`, which pins
 * `@bastra-recall/daemon` and nests it below itself. Both packages declare the
 * `bastra` command, so the old `npm install -g @bastra-recall/daemon@latest`
 * ended in EEXIST on every wrapper install, and the daemon was looked up only
 * at <prefix>/lib/node_modules/@bastra-recall/daemon. Every npm call and file
 * lookup here is injected — no test touches a real global npm prefix.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { spawnSync } from "node:child_process";
import {
  cmdUpdate,
  detectInstallMode,
  npmInstallFailure,
  resolveInstalledRuntime,
  type UpdateIo,
} from "../src/cli/update.js";
import { parseArgs } from "../src/cli/commands.js";
import { globalDaemonScript, isWrapperInstallPath } from "../src/cli/update-npm.js";

const node = "/usr/local/bin/node";
const npm = "/usr/local/bin/npm";

function posixFixture(prefix: string, cliPath: string, installedRoot: string) {
  const script = installedRoot + "/dist/index.js";
  const files = new Map<string, string>([
    [script, "daemon"],
    [installedRoot + "/package.json", JSON.stringify({ version: "9.0.0" })],
  ]);
  const npmCalls: string[][] = [];
  const refreshes: unknown[] = [];
  let out = "";
  const io: UpdateIo = {
    platform: "darwin",
    node,
    cliPath,
    find: () => npm,
    exists: (path) => files.has(path),
    read: (path) => {
      const content = files.get(path);
      if (content === undefined) throw new Error("not found");
      return content;
    },
    run: (_bin, args) => {
      npmCalls.push(args);
      return { ok: true, signal: false, detail: "ok" };
    },
    captured: (_bin, args) => {
      npmCalls.push(args);
      return { ok: true, signal: false, detail: "ok", stdout: prefix + "\n", stderr: "" };
    },
    spawn: (() => ({ status: 0, stdout: "", stderr: "" })) as unknown as typeof spawnSync,
    preflight: async () => ({ ok: true, dirty: [], notes: [] }),
    reapply: () => {},
    manifest: async (path) => ({ root: path, version: "9", created_at: "now", files: [] }),
    clearBlocked: async () => {},
    install: async () => 0,
    refreshAddress: async () => {},
    refresh: async (_, options) => {
      refreshes.push(options);
      return { ok: true, detail: "ok" };
    },
    service: () => null,
    ask: () => null,
  };
  return { io, files, npmCalls, refreshes, script, out: () => out, capture: (s: string) => (out += s) };
}

const homebrewNodePrefix = "/opt/homebrew";
const wrapperRoot = `${homebrewNodePrefix}/lib/node_modules/bastra-recall/node_modules/@bastra-recall/daemon`;
const directRoot = "/usr/local/lib/node_modules/@bastra-recall/daemon";

test("detects the wrapper layout on POSIX and Windows, and only the nested one", () => {
  for (const cli of [
    `${wrapperRoot}/dist/cli/update.js`,
    "/home/jane/.nvm/versions/node/v24.1.0/lib/node_modules/bastra-recall/node_modules/@bastra-recall/daemon/dist/cli/update.js",
    "C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\node_modules\\bastra-recall\\node_modules\\@bastra-recall\\daemon\\dist\\cli\\update.js",
  ]) {
    assert.equal(isWrapperInstallPath(cli), true, cli);
    const mode = detectInstallMode(cli);
    assert.equal(mode.mode, "npm-global", cli);
    assert.equal(mode.npmPackage, "bastra-recall");
    assert.equal(mode.updateCommand, "npm install -g bastra-recall@latest");
  }
  // An npx cache keeps wrapper and daemon side by side: not the wrapper layout.
  assert.equal(
    isWrapperInstallPath("/Users/jane/.npm/_npx/abc/node_modules/@bastra-recall/daemon/dist/cli/update.js"),
    false
  );
});

test("Homebrew's node prefix is an npm install, the Homebrew keg stays brew", () => {
  // Homebrew's node uses /opt/homebrew as npm prefix; that is not a brew install
  // of bastra-recall, and 'brew upgrade bastra-recall' cannot update it.
  assert.equal(
    detectInstallMode(`${homebrewNodePrefix}/lib/node_modules/@bastra-recall/daemon/dist/cli.js`).mode,
    "npm-global"
  );
  assert.equal(detectInstallMode(`${wrapperRoot}/dist/cli/update.js`).mode, "npm-global");
  assert.equal(
    detectInstallMode("/opt/homebrew/Cellar/bastra-recall/1.2.0/libexec/packages/daemon/dist/cli/update.js").mode,
    "brew"
  );
});

test("a direct daemon install keeps updating the daemon package", () => {
  const mode = detectInstallMode(`${directRoot}/dist/cli/update.js`);
  assert.equal(mode.mode, "npm-global");
  assert.equal(mode.npmPackage, "@bastra-recall/daemon");
  assert.equal(mode.updateCommand, "npm install -g @bastra-recall/daemon@latest");
});

test("the installed daemon is found below the wrapper on POSIX and Windows", () => {
  const posix = `${wrapperRoot}/dist/index.js`;
  assert.equal(globalDaemonScript(homebrewNodePrefix, { platform: "darwin", exists: (p) => p === posix }, true), posix);
  assert.equal(globalDaemonScript(homebrewNodePrefix, { platform: "darwin", exists: (p) => p === posix }), null);
  const prefix = "C:\\Users\\Jane Doe\\AppData\\Roaming\\npm";
  const win = prefix + "\\node_modules\\bastra-recall\\node_modules\\@bastra-recall\\daemon\\dist\\index.js";
  assert.equal(globalDaemonScript(prefix, { platform: "win32", exists: (p) => p === win }, true), win);
});

for (const staged of [true, false]) {
  test(`cmdUpdate on a wrapper install updates bastra-recall and runs the nested daemon (staged=${staged})`, async (t) => {
    const f = posixFixture(homebrewNodePrefix, `${wrapperRoot}/dist/cli/update.js`, wrapperRoot);
    t.mock.method(process.stdout, "write", (s: string) => f.capture(s));
    assert.equal(await cmdUpdate(parseArgs(["update", "--yes", ...(staged ? ["--staged"] : [])]), f.io), 0, f.out());
    const installs = f.npmCalls.filter((a) => a[0] === "install");
    assert.deepEqual(
      installs,
      [["install", "-g", "bastra-recall@latest"]],
      "never the daemon package over the wrapper"
    );
    assert.deepEqual(f.refreshes, [
      { target: { node, script: f.script, version: "9.0.0" }, reload: !staged, platform: "darwin" },
    ]);
  });
}

test("cmdUpdate on a direct daemon install is unchanged", async (t) => {
  const f = posixFixture("/usr/local", `${directRoot}/dist/cli/update.js`, directRoot);
  t.mock.method(process.stdout, "write", (s: string) => f.capture(s));
  assert.equal(await cmdUpdate(parseArgs(["update", "--staged"]), f.io), 0, f.out());
  assert.deepEqual(
    f.npmCalls.filter((a) => a[0] === "install"),
    [["install", "-g", "@bastra-recall/daemon@latest"]]
  );
  assert.deepEqual(resolveInstalledRuntime(detectInstallMode(f.io.cliPath), f.io), {
    node,
    script: f.script,
    version: "9.0.0",
  });
});

test("dry run names the wrapper's npm command", async (t) => {
  const f = posixFixture(homebrewNodePrefix, `${wrapperRoot}/dist/cli/update.js`, wrapperRoot);
  t.mock.method(process.stdout, "write", (s: string) => f.capture(s));
  assert.equal(await cmdUpdate(parseArgs(["update", "--dry-run"]), f.io), 0);
  assert.match(f.out(), /update command: npm install -g bastra-recall@latest/);
  assert.equal(f.npmCalls.length, 0);
});

test("a failed npm install names the manual command; an unclear layout names both", async (t) => {
  // npx run: the layout cannot show what is installed globally.
  const npx = "/Users/jane/.npm/_npx/abc/node_modules/@bastra-recall/daemon";
  const f = posixFixture("/usr/local", `${npx}/dist/cli/update.js`, npx);
  f.io.run = (_bin, args) => {
    f.npmCalls.push(args);
    return { ok: false, signal: false, detail: "exit 1" };
  };
  t.mock.method(process.stdout, "write", (s: string) => f.capture(s));
  assert.equal(await cmdUpdate(parseArgs(["update", "--staged"]), f.io), 1);
  assert.deepEqual(
    f.npmCalls.filter((a) => a[0] === "install"),
    [["install", "-g", "@bastra-recall/daemon@latest"]],
    "no guessing: the previous behaviour stays"
  );
  assert.match(f.out(), /npm install -g @bastra-recall\/daemon@latest/);
  assert.match(f.out(), /npm install -g bastra-recall@latest/);
  assert.equal(f.refreshes.length, 0, "nothing re-pointed after a failed install");

  const wrapperOnly = npmInstallFailure("bastra-recall", "exit 1");
  assert.match(wrapperOnly, /npm install -g bastra-recall@latest/);
  assert.doesNotMatch(wrapperOnly, /@bastra-recall\/daemon/);
});
