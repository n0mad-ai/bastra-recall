/**
 * #1514 — characterization of `bastra update` (`performUpdate`) before it is
 * split up. Each scenario runs `cmdUpdate` against injected lifecycle seams and
 * records ONE ordered event list: every line written to stdout/stderr and every
 * seam call (npm, preflight, reapply, baseline, re-registration, address
 * refresh, autostart, restart, closing question), plus the exit code. The
 * snapshot pins output, write order and failure exits; a structural change must
 * leave it identical.
 *
 * Nothing real is installed, spawned or restarted: npm, the CLI hand-off and the
 * autostart service are all fakes, and the test environment points HOME at a
 * throwaway directory. Not covered here because they cannot run without the real
 * tool: the non-dry-run Homebrew upgrade (resolves the real `brew`) and the
 * source-checkout verification (needs a git checkout and a live daemon).
 *
 * Update deliberately with `--test-update-snapshots` only when the behaviour is
 * meant to change.
 */
import { test } from "node:test";
import type { spawnSync } from "node:child_process";
import { cmdUpdate, type UpdateIo } from "../src/cli/update.js";
import { parseArgs } from "../src/cli/commands.js";
import { resolveDaemonEndpoint } from "../src/daemon-endpoint.js";

type Event = string | [string, unknown];

const posixNode = "/usr/local/bin/node";
const posixNpm = "/usr/local/bin/npm";
const directRoot = "/usr/local/lib/node_modules/@bastra-recall/daemon";
const npxRoot = "/Users/jane/.npm/_npx/abc/node_modules/@bastra-recall/daemon";
const brewCli = "/opt/homebrew/Cellar/bastra-recall/1.2.0/libexec/packages/daemon/dist/cli/update.js";
const unknownCli = "/nowhere-1514/bastra/dist/cli/update.js";

const winNode = "C:\\Program Files\\nodejs\\node.exe";
const winNpmWrapper = "C:\\Program Files\\nodejs\\npm.cmd";
const winNpmCli = "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js";
const winNpmPackage = "C:\\Program Files\\nodejs\\node_modules\\npm\\package.json";
const winPrefix = "C:\\Users\\Jane Doe\\AppData\\Roaming\\npm";
const winRoot = winPrefix + "\\node_modules\\@bastra-recall\\daemon";

interface Fixture {
  io: UpdateIo;
  files: Map<string, string>;
  events: Event[];
}

function service(events: Event[], state: { managed?: boolean; loaded?: boolean }, kickOk = true) {
  return ((platform: string) => {
    events.push(["service", platform]);
    return {
      status: async () => {
        events.push(["service.status", state]);
        return state;
      },
      kickstart: async () => {
        events.push("service.kickstart");
        return { ok: kickOk, detail: kickOk ? "ok" : "failed" };
      },
    };
  }) as unknown as UpdateIo["service"];
}

function fixture(
  platform: "darwin" | "linux" | "win32",
  cliPath: string,
  prefix: string,
  installRoot: string
): Fixture {
  const sep = platform === "win32" ? "\\" : "/";
  const files = new Map<string, string>([
    [`${installRoot}${sep}dist${sep}index.js`, "daemon"],
    [`${installRoot}${sep}dist${sep}cli.js`, "new cli"],
    [`${installRoot}${sep}package.json`, JSON.stringify({ version: "9.0.0" })],
    [`${prefix}/bin/bastra`, "bin"],
  ]);
  if (platform === "win32") {
    files.set(winNpmCli, "npm cli");
    files.set(winNpmPackage, JSON.stringify({ name: "npm", bin: { npm: "bin/npm-cli.js" } }));
  }
  const events: Event[] = [];
  const io: UpdateIo = {
    platform,
    node: platform === "win32" ? winNode : posixNode,
    cliPath,
    find: (name) => {
      events.push(["find", name]);
      return platform === "win32" ? winNpmWrapper : posixNpm;
    },
    exists: (path) => files.has(path),
    file: (path) => files.has(path),
    read: (path) => {
      const content = files.get(path);
      if (content === undefined) throw new Error("not found");
      return content;
    },
    run: (bin, args) => {
      events.push(["run", [bin, ...args]]);
      return { ok: true, signal: false, detail: "ok" };
    },
    captured: (bin, args) => {
      events.push(["captured", [bin, ...args]]);
      return { ok: true, signal: false, detail: "ok", stdout: prefix + "\n", stderr: "" };
    },
    spawn: ((bin: string, args: string[]) => {
      events.push(["spawn", [bin, ...args]]);
      return { status: 0, stdout: "", stderr: "" };
    }) as unknown as typeof spawnSync,
    preflight: async (options) => {
      const { verify, ...rest } = options;
      events.push(["preflight", { ...rest, verify: typeof verify }]);
      return { ok: true, dirty: [], notes: [] };
    },
    reapply: (mode, root) => {
      events.push(["reapply", [mode.mode, root]]);
    },
    manifest: async (path, version) => {
      events.push(["manifest", [path, version]]);
      return { root: path, version: "9", created_at: "now", files: [] };
    },
    writeManifest: async (m) => {
      events.push(["writeManifest", m.files.length]);
    },
    clearBlocked: async () => {
      events.push("clearBlocked");
    },
    install: async (a) => {
      events.push([
        "install",
        {
          command: a.command,
          surface: a.surface,
          yes: a.yes,
          ollama: a.ollama,
          withStopHook: a.withStopHook,
          staged: a.staged,
          force: a.force,
        },
      ]);
      return 0;
    },
    refreshAddress: async () => {
      events.push("refreshAddress");
    },
    refresh: async (_write, options) => {
      events.push(["refresh", options]);
      return { ok: true, detail: "ok" };
    },
    service: ((p: string) => {
      events.push(["service", p]);
      return null;
    }) as unknown as UpdateIo["service"],
    ask: (installed) => {
      events.push(["ask", installed]);
      return null;
    },
  };
  return { io, files, events };
}

const posix = (cliPath = `${directRoot}/dist/cli/update.js`, root = directRoot) =>
  fixture("darwin", cliPath, "/usr/local", root);
const windows = () => fixture("win32", winRoot + "\\dist\\cli\\update.js", winPrefix, winRoot);

const scenarios: Array<[string, string[], () => Fixture]> = [
  ["dry-run npm", ["--dry-run"], () => posix()],
  ["dry-run npm staged", ["--dry-run", "--staged"], () => posix()],
  [
    "dry-run brew",
    ["--dry-run"],
    () => posix(brewCli, "/opt/homebrew/Cellar/bastra-recall/1.2.0/libexec/packages/daemon"),
  ],
  ["dry-run unknown", ["--dry-run"], () => posix(unknownCli, "/nowhere-1514/bastra")],
  ["npm plain, no autostart service", [], () => posix()],
  ["npm staged", ["--staged"], () => posix()],
  ["npm --yes --force", ["--yes", "--force"], () => posix()],
  [
    "preflight refuses, interactive",
    [],
    () => {
      const f = posix();
      f.io.preflight = async () => ({ ok: false, dirty: [], notes: ["a note"], refusal: "local changes found" });
      return f;
    },
  ],
  [
    "preflight refuses, staged",
    ["--staged"],
    () => {
      const f = posix();
      f.io.preflight = async () => ({ ok: false, dirty: [], notes: [], refusal: "local changes found" });
      return f;
    },
  ],
  [
    "preflight passes with notes",
    [],
    () => {
      const f = posix();
      f.io.preflight = async () => ({ ok: true, dirty: [], notes: ["backed up 2 files"] });
      return f;
    },
  ],
  [
    "npm install fails",
    [],
    () => {
      const f = posix();
      f.io.run = (bin, args) => {
        f.events.push(["run", [bin, ...args]]);
        return { ok: false, signal: false, detail: "exit 1" };
      };
      return f;
    },
  ],
  [
    "baseline written",
    [],
    () => {
      const f = posix();
      f.io.manifest = async (path) => ({
        root: path,
        version: "9",
        created_at: "now",
        files: [{ path: "dist/index.js", hash: "x" }],
      });
      return f;
    },
  ],
  [
    "baseline throws",
    [],
    () => {
      const f = posix();
      f.io.manifest = async () => {
        throw new Error("disk full");
      };
      return f;
    },
  ],
  [
    "re-register fails",
    [],
    () => {
      const f = posix();
      f.io.install = async () => 2;
      return f;
    },
  ],
  [
    "address refresh throws",
    [],
    () => {
      const f = posix();
      f.io.refreshAddress = async () => {
        throw new Error("address broken");
      };
      return f;
    },
  ],
  [
    "address refresh through the installed runtime",
    [],
    () => {
      const f = posix();
      delete f.io.refreshAddress;
      return f;
    },
  ],
  [
    "address refresh without an installed runtime",
    [],
    () => {
      const f = posix();
      delete f.io.refreshAddress;
      f.files.delete(`${directRoot}/dist/index.js`);
      return f;
    },
  ],
  [
    "autostart cannot be re-pointed",
    [],
    () => {
      const f = posix();
      f.io.refresh = async (_w, options) => {
        f.events.push(["refresh", options]);
        return { ok: false, detail: "no" };
      };
      return f;
    },
  ],
  [
    "darwin managed autostart",
    [],
    () => {
      const f = posix();
      f.io.service = service(f.events, { managed: true, loaded: true });
      return f;
    },
  ],
  [
    "darwin loaded autostart, kickstart ok",
    [],
    () => {
      const f = posix();
      f.io.service = service(f.events, { managed: false, loaded: true });
      return f;
    },
  ],
  [
    "darwin loaded autostart, kickstart fails",
    [],
    () => {
      const f = posix();
      f.io.service = service(f.events, { managed: false, loaded: true }, false);
      return f;
    },
  ],
  [
    "linux without autostart",
    [],
    () => {
      const f = posix();
      f.io.platform = "linux";
      return f;
    },
  ],
  [
    "npx hands the re-registration to the installed CLI",
    ["--staged"],
    () => posix(`${npxRoot}/dist/cli/update.js`, npxRoot),
  ],
  [
    "npx without an installed CLI registers inline",
    [],
    () => {
      const f = posix(`${npxRoot}/dist/cli/update.js`, npxRoot);
      f.files.delete("/usr/local/bin/bastra");
      return f;
    },
  ],
  [
    "npx hand-off spawn fails",
    [],
    () => {
      const f = posix(`${npxRoot}/dist/cli/update.js`, npxRoot);
      f.io.spawn = ((bin: string, args: string[]) => {
        f.events.push(["spawn", [bin, ...args]]);
        return { status: null, error: new Error("ENOENT") };
      }) as unknown as typeof spawnSync;
      return f;
    },
  ],
  ["unknown install mode", [], () => posix(unknownCli, "/nowhere-1514/bastra")],
  ["windows npm staged", ["--staged"], () => windows()],
  [
    "windows managed autostart",
    [],
    () => {
      const f = windows();
      f.io.service = service(f.events, { managed: true, loaded: true });
      return f;
    },
  ],
  ["windows without autostart", [], () => windows()],
  [
    "windows hand-off cannot find the new CLI",
    ["--staged"],
    () => {
      const f = windows();
      f.files.delete(winRoot + "\\dist\\cli.js");
      return f;
    },
  ],
];

test("#1514 bastra update: output, seam order and exit codes per scenario", async (t) => {
  const port = String(resolveDaemonEndpoint().port);
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);
  const results: Array<{ scenario: string; rc: number; events: Event[] }> = [];
  for (const [scenario, flags, make] of scenarios) {
    const f = make();
    // The test runner's own frames (Buffers) pass through untouched.
    const out = t.mock.method(process.stdout, "write", (s: string | Uint8Array) => {
      if (typeof s !== "string") return stdoutWrite(s);
      f.events.push(["out", s]);
      return true;
    });
    const err = t.mock.method(process.stderr, "write", (s: string | Uint8Array) => {
      if (typeof s !== "string") return stderrWrite(s);
      f.events.push(["err", s]);
      return true;
    });
    let rc: number;
    try {
      rc = await cmdUpdate(parseArgs(["update", ...flags]), f.io);
    } finally {
      out.mock.restore();
      err.mock.restore();
    }
    results.push({ scenario, rc, events: f.events });
  }
  const text = JSON.stringify(results)
    .split(`:${port}`)
    .join(":<port>")
    .split(`LocalPort ${port}`)
    .join("LocalPort <port>");
  t.assert.snapshot(JSON.parse(text));
});
