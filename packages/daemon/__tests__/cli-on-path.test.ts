/**
 * Tests for the `bastra`-command-after-npx logic (#317): the verdict that
 * decides whether the setup has to offer anything at all, the PATH check that
 * keeps a "successful" global install honest, and the wording of every outcome.
 *
 * `installCliGlobally` never runs a real `npm install -g` here — that would
 * change the machine the test runs on. #1274 drives it with a stand-in
 * platform and recorded spawns instead; a real Windows run is not part of it.
 *
 * Run: npx tsx --test packages/daemon/__tests__/cli-on-path.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { delimiter } from "node:path";

import {
  CLI_DECLINED_NOTE,
  CLI_PACKAGE,
  NPX_FALLBACK_HINT,
  binDirOnPath,
  decideCliOnPath,
  formatGlobalInstallOutcome,
  installCliGlobally,
} from "../src/cli/cli-on-path.js";
import { VERSION } from "../src/cli/helpers.js";

const NPX_CLI = "/Users/x/.npm/_npx/0123abcd/node_modules/@bastra-recall/daemon/dist/mcp-forwarder.js";
const NPX_BIN = "/Users/x/.npm/_npx/0123abcd/node_modules/.bin/bastra";
const GLOBAL_CLI = "/opt/homebrew/lib/node_modules/@bastra-recall/daemon/dist/mcp-forwarder.js";

// ─── decideCliOnPath ─────────────────────────────────────────────────────────

test("decideCliOnPath: a permanent install already has its bin — nothing to offer", () => {
  assert.equal(decideCliOnPath({ cliPath: GLOBAL_CLI, resolvedBastra: null }), "permanent");
  assert.equal(
    decideCliOnPath({
      cliPath: "/Users/x/Projekte/bastra-recall/packages/daemon/dist/mcp-forwarder.js",
      resolvedBastra: null,
    }),
    "permanent"
  );
});

test("decideCliOnPath: npx run with nothing on PATH → offer (the #317 case)", () => {
  assert.equal(decideCliOnPath({ cliPath: NPX_CLI, resolvedBastra: null }), "offer");
});

test("decideCliOnPath: the npx cache's own bin on PATH proves nothing — still offer", () => {
  // npx puts <cache>/node_modules/.bin on PATH for the child, so a name lookup
  // resolves right back to the process asking. That entry disappears with the
  // cache; treating it as "already installed" is exactly the #317 dead end.
  assert.equal(decideCliOnPath({ cliPath: NPX_CLI, resolvedBastra: NPX_BIN }), "offer");
});

test("decideCliOnPath: a permanent bastra on PATH → never install over it", () => {
  assert.equal(decideCliOnPath({ cliPath: NPX_CLI, resolvedBastra: "/opt/homebrew/bin/bastra" }), "already-on-path");
  assert.equal(decideCliOnPath({ cliPath: NPX_CLI, resolvedBastra: "/usr/local/bin/bastra" }), "already-on-path");
});

// ─── binDirOnPath ────────────────────────────────────────────────────────────

test("binDirOnPath: the bin's own directory counts, a sibling does not", () => {
  const path = ["/usr/bin", "/opt/homebrew/bin"].join(delimiter);
  assert.equal(binDirOnPath("/opt/homebrew/bin/bastra", path), true);
  assert.equal(binDirOnPath("/usr/bin/bastra", path), true);
  // A custom npm prefix nobody's shell searches — success that isn't one.
  assert.equal(binDirOnPath("/Users/x/.npm-global/bin/bastra", path), false);
});

test("binDirOnPath: trailing slashes and empty entries do not change the answer", () => {
  const path = ["/opt/homebrew/bin/", "", "/usr/bin"].join(delimiter);
  assert.equal(binDirOnPath("/opt/homebrew/bin/bastra", path), true);
  assert.equal(binDirOnPath("/opt/homebrew/bin/bastra", ""), false);
});

// ─── outcome wording ─────────────────────────────────────────────────────────
// The whole point of #317 is that a setup can report success and leave the user
// without a command. So only the verifiably-reachable case may read as success,
// and every other shape has to name a way to run something.

test("formatGlobalInstallOutcome: reachable bin is the only success", () => {
  const line = formatGlobalInstallOutcome({
    ok: true,
    binPath: "/opt/homebrew/bin/bastra",
    offPath: false,
    detail: "installed",
  });
  assert.equal(line.level, "success");
  assert.match(line.text, /\/opt\/homebrew\/bin\/bastra/);
  assert.match(line.text, /bastra doctor/);
});

test("formatGlobalInstallOutcome: installed off PATH is a warning that names the directory", () => {
  const line = formatGlobalInstallOutcome({
    ok: true,
    binPath: "/Users/x/.npm-global/bin/bastra",
    offPath: true,
    detail: "installed",
  });
  assert.equal(line.level, "warn");
  assert.match(line.text, /\/Users\/x\/\.npm-global\/bin(?!\/bastra)/, "names the directory to add to PATH");
  assert.ok(line.text.includes(NPX_FALLBACK_HINT), "still offers a way to run commands now");
});

test("formatGlobalInstallOutcome: npm said ok but the bin is unfindable → warn, not success", () => {
  const line = formatGlobalInstallOutcome({ ok: true, detail: "installed" });
  assert.equal(line.level, "warn");
  assert.ok(line.text.includes(NPX_FALLBACK_HINT));
});

test("formatGlobalInstallOutcome: a failure carries npm's reason and both ways forward", () => {
  const line = formatGlobalInstallOutcome({ ok: false, detail: "exit 243" });
  assert.equal(line.level, "warn");
  assert.match(line.text, /exit 243/);
  assert.ok(line.text.includes(NPX_FALLBACK_HINT));
  assert.match(line.text, new RegExp(`npm install -g ${CLI_PACKAGE}`));
});

test("declining still leaves a usable CLI — the note names npx and the global install", () => {
  assert.ok(CLI_DECLINED_NOTE.includes(NPX_FALLBACK_HINT));
  assert.match(CLI_DECLINED_NOTE, new RegExp(`npm install -g ${CLI_PACKAGE}`));
});

test("the npx fallback is a runnable command, not a description", () => {
  assert.match(NPX_FALLBACK_HINT, /^npx bastra-recall <command>/);
  assert.match(NPX_FALLBACK_HINT, /npx bastra-recall doctor/);
});

// ─── installCliGlobally (#1274) ─────────────────────────────────────────────

const WIN_NODE = "C:\\Program Files\\nodejs\\node.exe";
const WIN_NPM = "C:\\Program Files\\nodejs\\npm.cmd";
const WIN_NPM_CLI = "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js";
const WIN_NPM_PKG = "C:\\Program Files\\nodejs\\node_modules\\npm\\package.json";
const WIN_PREFIX = "C:\\Users\\Jane Doe\\AppData\\Roaming\\npm";

function windowsIo(npm = WIN_NPM) {
  const spawns: Array<{ bin: string; args: string[] }> = [];
  const files = new Set([WIN_NPM_CLI, `${WIN_PREFIX}\\bastra.cmd`]);
  const io = {
    platform: "win32" as const,
    node: WIN_NODE,
    find: () => npm,
    file: (path: string) => files.has(path),
    exists: (path: string) => files.has(path),
    read: (path: string) => {
      if (path !== WIN_NPM_PKG) throw new Error("not found");
      return JSON.stringify({ name: "npm", bin: { npm: "bin/npm-cli.js" } });
    },
    run: (bin: string, args: string[]) => {
      spawns.push({ bin, args });
      return { ok: true, signal: false, detail: "ok" };
    },
    captured: (bin: string, args: string[]) => {
      spawns.push({ bin, args });
      return { ok: true, signal: false, detail: "ok", stdout: `${WIN_PREFIX}\r\n`, stderr: "" };
    },
  };
  return { io, spawns };
}

test("#1274 installCliGlobally on Windows runs node.exe + npm-cli.js, never npm.cmd", () => {
  const { io, spawns } = windowsIo();
  const out = installCliGlobally(io);
  assert.equal(out.ok, true, out.detail);
  assert.deepEqual(spawns, [
    { bin: WIN_NODE, args: [WIN_NPM_CLI, "install", "-g", `${CLI_PACKAGE}@${VERSION}`] },
    { bin: WIN_NODE, args: [WIN_NPM_CLI, "prefix", "-g"] },
  ]);
  assert.equal(out.binPath, `${WIN_PREFIX}\\bastra.cmd`, "global bins sit directly in the prefix on Windows");
});

test("#1274 Windows setup recognizes the npm prefix on PATH with different casing", () => {
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = `C:\\Windows\\System32;${WIN_PREFIX.toLowerCase()}`;
    const installed = installCliGlobally(windowsIo().io);
    assert.equal(installed.offPath, false);
    assert.equal(formatGlobalInstallOutcome(installed).level, "success");
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
});

test("#1274 installCliGlobally refuses an unknown Windows npm wrapper without spawning", () => {
  const { io, spawns } = windowsIo("C:\\Tools\\npm.exe");
  const out = installCliGlobally(io);
  assert.equal(out.ok, false);
  assert.match(out.detail, /unsupported Windows npm wrapper/);
  assert.deepEqual(spawns, []);
});

test("#1274 installCliGlobally elsewhere still runs the trusted npm directly", () => {
  const spawns: Array<{ bin: string; args: string[] }> = [];
  const out = installCliGlobally({
    platform: "linux",
    find: () => "/usr/local/bin/npm",
    exists: (path) => path === "/usr/local/bin/bastra",
    run: (bin, args) => {
      spawns.push({ bin, args });
      return { ok: true, signal: false, detail: "ok" };
    },
    captured: (bin, args) => {
      spawns.push({ bin, args });
      return { ok: true, signal: false, detail: "ok", stdout: "/usr/local\n", stderr: "" };
    },
  });
  assert.equal(out.ok, true);
  assert.equal(out.binPath, "/usr/local/bin/bastra");
  assert.deepEqual(
    spawns.map((s) => s.bin),
    ["/usr/local/bin/npm", "/usr/local/bin/npm"]
  );
  assert.equal(installCliGlobally({ find: () => null }).ok, false, "no npm on a trusted PATH is a failure");
});
