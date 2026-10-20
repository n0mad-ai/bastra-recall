/** npm invocation for the update lifecycle only. Never execute a Windows .cmd
 * through a shell or guess a different npm from PATH when a wrapper is unknown.
 * npm's Windows shim names node_modules/npm/bin/npm-cli.js beside itself:
 * https://github.com/npm/cli/blob/latest/bin/npm.cmd
 * Global Windows packages live under <prefix>/node_modules (no lib directory):
 * https://docs.npmjs.com/cli/configuring-npm/folders
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, resolve, win32 } from "node:path";
import { findExecutable, run, runCaptured } from "./exec.js";

export interface UpdateRuntimeIo {
  platform?: NodeJS.Platform;
  node?: string;
  find?: typeof findExecutable;
  exists?: (path: string) => boolean;
  read?: (path: string) => string;
  file?: (path: string) => boolean;
  run?: typeof run;
  captured?: typeof runCaptured;
}
export interface NpmInvocation { bin: string; args: string[] }
export function updatePaths(platform: NodeJS.Platform = process.platform) { return platform === "win32" ? win32 : { basename, dirname, resolve }; }

export function npmInvocation(io: UpdateRuntimeIo = {}): NpmInvocation {
  // Preserve the existing trusted executable lookup. No bare-name fallback.
  const npm = (io.find ?? findExecutable)("npm");
  if (!npm) throw new Error("npm not found on a trusted PATH");
  if ((io.platform ?? process.platform) !== "win32") return { bin: npm, args: [] };
  const paths = updatePaths("win32");
  if (paths.basename(npm).toLowerCase() !== "npm.cmd") throw new Error(`unsupported Windows npm wrapper: ${npm}; install the standard Node/npm distribution`);
  const root = paths.resolve(paths.dirname(npm), "node_modules", "npm");
  const cli = paths.resolve(root, "bin", "npm-cli.js");
  const file = io.file ?? ((path: string) => { try { return statSync(path).isFile(); } catch { return false; } });
  try {
    const pkg = JSON.parse((io.read ?? (path => readFileSync(path, "utf8")))(paths.resolve(root, "package.json")));
    // The adjacent package is the npm the trusted shim belongs to; do not
    // resolve modules from CWD, inspect arbitrary shell commands or run a shim.
    if (pkg.name !== "npm" || pkg.bin?.npm !== "bin/npm-cli.js" || !file(cli)) throw new Error("unrecognized adjacent npm package");
  } catch {
    throw new Error(`cannot resolve npm-cli.js beside ${npm}; unsupported npm wrapper layout, update manually`);
  }
  const node = io.node ?? process.execPath;
  if (!win32.isAbsolute(node)) throw new Error("the current Node executable is not an absolute Windows path");
  return { bin: node, args: [cli] };
}

export function runUpdateNpm(args: string[], opts: Parameters<typeof run>[2], io: UpdateRuntimeIo = {}) {
  const command = npmInvocation(io);
  return (io.run ?? run)(command.bin, [...command.args, ...args], opts);
}
export function captureUpdateNpm(args: string[], opts: Parameters<typeof runCaptured>[2], io: UpdateRuntimeIo = {}) {
  let command: NpmInvocation;
  try { command = npmInvocation(io); }
  catch (error) {
    if ((io.platform ?? process.platform) === "win32") throw error;
    return { ok: false, signal: false, detail: (error as Error).message, stdout: "", stderr: "" };
  }
  return (io.captured ?? runCaptured)(command.bin, [...command.args, ...args], opts);
}
export function globalDaemonScript(prefix: string, io: UpdateRuntimeIo = {}): string | null {
  const platform = io.platform ?? process.platform;
  const paths = updatePaths(platform);
  if (!(platform === "win32" ? win32.isAbsolute(prefix) : prefix.startsWith("/"))) return null;
  const script = paths.resolve(prefix, ...(platform === "win32" ? [] : ["lib"]), "node_modules", "@bastra-recall", "daemon", "dist", "index.js");
  return (io.exists ?? existsSync)(script) ? script : null;
}
