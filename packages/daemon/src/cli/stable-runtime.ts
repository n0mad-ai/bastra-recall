/**
 * Stable runtime for npx-based installs (#180).
 *
 * `npx …` runs this CLI out of the npm exec cache
 * (~/.npm/_npx/<hash>/node_modules/…). Registering FORWARDER_SCRIPT_PATH from
 * there plants a time bomb: npm evicts _npx entries at will, and every MCP
 * registration then points at a file that no longer exists. Fix: when install
 * detects it is running from an npx cache, it copies the resolved runtime to
 * ~/.bastra/runtime/<version>/ and registers THAT forwarder path.
 *
 * What gets copied: the cache's flat node_modules tree — the daemon package
 * plus exactly the production deps npx materialized. dist/ alone would NOT
 * suffice: the forwarder imports @bastra-recall/core and the MCP SDK at
 * runtime and spawns dist/index.js (the daemon), which needs the full
 * dependency set. Copying the tree verbatim keeps ESM resolution untouched.
 *
 * Idempotent: same version = reuse the existing copy (marker + forwarder
 * present). After a successful copy, OTHER version dirs are pruned
 * (best-effort) so ~/.bastra/runtime never grows unbounded — a live daemon
 * spawned from an old dir keeps running via its open fds; the next spawn
 * uses the new path.
 */
import { realpathSync } from "node:fs";
import { cp, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { homedir } from "node:os";
import { FORWARDER_SCRIPT_PATH } from "./paths.js";
import { VERSION, fileExists } from "./helpers.js";

/**
 * True when the path lives inside an npm exec cache. "_npx" is matched as a
 * path SEGMENT, never a substring — "my_npx_tools" is a permanent install.
 * Both separators: npx caches exist on Windows too.
 */
export function isEphemeralInstallPath(p: string): boolean {
  return p.split(/[\\/]+/).includes("_npx");
}

/**
 * A path inside a Homebrew keg of this formula —
 * `<prefix>/Cellar/bastra-recall/<version>/<rest>` — split into its parts, or
 * null. Matched on path segments, either separator.
 */
export function homebrewKeg(p: string): { prefix: string; keg: string; version: string; rest: string } | null {
  const parts = p.split(/[\\/]+/);
  for (let i = 0; i + 2 < parts.length; i++) {
    if (parts[i] === "Cellar" && parts[i + 1] === "bastra-recall" && parts[i + 2]) {
      // `1.0.0_1` is a formula revision of 1.0.0 — the same package version.
      const keg = parts[i + 2];
      return { prefix: parts.slice(0, i).join("/"), keg, version: keg.replace(/_\d+$/, ""), rest: parts.slice(i + 3).join("/") };
    }
  }
  return null;
}

/**
 * The version-independent spelling of a Homebrew keg path, for anything that is
 * WRITTEN INTO A CLIENT CONFIG.
 *
 * Node resolves the `bastra` symlink to its real file, so every path this CLI
 * derives from `import.meta.url` names the keg: `/opt/homebrew/Cellar/
 * bastra-recall/1.0.0/…`. Registered that way, a surface keeps running the
 * superseded keg after `brew upgrade` (doctor said "ok" — the file exists) and
 * loses the MCP server, hooks and statusline at `brew cleanup`. Homebrew's own
 * answer is `<prefix>/opt/<formula>`, a symlink it re-points on every upgrade.
 *
 * Only rewritten when `opt/bastra-recall` currently resolves to that very keg:
 * pointing a registration at different code than the installer just checked is
 * not this function's call. Anything that is not a keg path passes through.
 */
export function homebrewStablePath(p: string, realpath: (path: string) => string = realpathSync): string {
  const keg = homebrewKeg(p);
  if (!keg) return p;
  const opt = `${keg.prefix}/opt/bastra-recall`;
  try {
    if (realpath(opt) !== realpath(`${keg.prefix}/Cellar/bastra-recall/${keg.keg}`)) return p;
  } catch {
    return p;
  }
  return keg.rest ? `${opt}/${keg.rest}` : opt;
}

export interface RuntimeTarget {
  /** ~/.bastra/runtime/<version> */
  rootDir: string;
  /** <rootDir>/node_modules/@bastra-recall/daemon/dist/mcp-forwarder.js */
  forwarderPath: string;
  /** <rootDir>/runtime-source.json — records where the copy came from */
  markerPath: string;
}

export function stableRuntimeTarget(version: string, home: string = homedir()): RuntimeTarget {
  const rootDir = join(home, ".bastra", "runtime", version);
  return {
    rootDir,
    forwarderPath: join(rootDir, "node_modules", "@bastra-recall", "daemon", "dist", "mcp-forwarder.js"),
    markerPath: join(rootDir, "runtime-source.json"),
  };
}

/**
 * The node_modules dir hosting the daemon package
 * (…/node_modules/@bastra-recall/daemon → …/node_modules), or null when the
 * layout is not a node_modules install (source checkout: packages/daemon).
 */
export function resolveNodeModulesRoot(packageRoot: string): string | null {
  const nmDir = dirname(dirname(packageRoot));
  return basename(nmDir) === "node_modules" ? nmDir : null;
}

/**
 * Copies the flat node_modules tree into the versioned runtime dir. Staging
 * dir + rename, so a killed install never leaves a half-copied tree at the
 * final path.
 */
export async function copyRuntimeTree(
  sourceNodeModules: string,
  target: RuntimeTarget,
  version: string,
): Promise<void> {
  const staging = `${target.rootDir}.tmp-${process.pid}`;
  try {
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    await cp(sourceNodeModules, join(staging, "node_modules"), { recursive: true });
    const marker = { version, source: sourceNodeModules, copied_at: new Date().toISOString() };
    await writeFile(join(staging, basename(target.markerPath)), JSON.stringify(marker, null, 2) + "\n", "utf8");
    await rm(target.rootDir, { recursive: true, force: true });
    await rename(staging, target.rootDir);
  } catch (e) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw e;
  }
}

export interface ForwarderResolution {
  /** The forwarder path install should register. */
  path: string;
  action: "native" | "reused" | "copied" | "would-copy" | "fallback";
  /** Human line for the install output (`runtime: …`); absent on "native". */
  note?: string;
  /** ~/.bastra/runtime/<version> when the stable runtime is (or would be) active. */
  rootDir?: string;
  /** The source node_modules the runtime is copied from — bins under it map into the copy. */
  sourceNodeModules?: string;
}

/**
 * Maps a bin from the install source tree into the stable runtime copy (#180).
 * Everything the claude-code adapter registers (hooks, statusline) must point
 * into ~/.bastra/runtime too — not just the forwarder — or npm evicting the
 * npx cache breaks 6-7 registrations silently. The copied tree mirrors the
 * source node_modules verbatim, so a bin under it lives at the same relative
 * path under <rootDir>/node_modules. Non-stable resolutions and bins outside
 * the copied tree (source checkouts) pass through untouched — non-npx
 * installs stay byte-identical.
 */
export function mapBinToStableRuntime(
  bin: string,
  res: Pick<ForwarderResolution, "rootDir" | "sourceNodeModules">,
): string {
  if (!res.rootDir || !res.sourceNodeModules) return homebrewStablePath(bin);
  const rel = relative(res.sourceNodeModules, bin);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return bin;
  return join(res.rootDir, "node_modules", rel);
}

/**
 * Best-effort prune after a successful copy: every sibling of the version dir
 * just installed goes (old versions, stale .tmp staging). Never the fresh one.
 * Constraint: a live daemon spawned from an old dir keeps running via its
 * open fds; the next spawn uses the new path. Never throws — an unpruned dir
 * is only disk usage.
 */
export async function pruneOldRuntimes(target: RuntimeTarget): Promise<void> {
  try {
    const runtimeBase = dirname(target.rootDir);
    const keep = basename(target.rootDir);
    for (const entry of await readdir(runtimeBase)) {
      if (entry === keep) continue;
      await rm(join(runtimeBase, entry), { recursive: true, force: true }).catch(() => undefined);
    }
  } catch {
    // readdir failed (dir gone?) — nothing to prune.
  }
}

/**
 * Full-uninstall cleanup (`uninstall all`): with every surface registration
 * gone nothing references ~/.bastra/runtime anymore — remove it entirely.
 * Constraint: a live daemon spawned from a runtime dir keeps running via its
 * open fds; the next install re-creates the dir. Best-effort, never throws.
 * Returns true when a dir was actually removed (caller prints a line then).
 */
export async function removeRuntimeBase(home: string = homedir()): Promise<boolean> {
  try {
    const dir = join(home, ".bastra", "runtime");
    if (!(await fileExists(dir))) return false;
    await rm(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves the forwarder path install should register. Permanent installs
 * (source checkout, Homebrew, global npm) pass through untouched; npx-cache
 * installs get the runtime pinned under ~/.bastra/runtime/<version>/ first.
 * Best-effort: a failed copy falls back to the cache path (today's behavior)
 * with a note — install never throws over this.
 */
export async function ensureStableForwarder(
  opts: { dryRun: boolean },
  io: { forwarderPath?: string; version?: string; home?: string; stablePath?: (p: string) => string } = {},
): Promise<ForwarderResolution> {
  const fwd = io.forwarderPath ?? FORWARDER_SCRIPT_PATH;
  if (!isEphemeralInstallPath(fwd)) return { path: (io.stablePath ?? homebrewStablePath)(fwd), action: "native" };

  const version = io.version ?? VERSION;
  const target = stableRuntimeTarget(version, io.home);
  // FORWARDER_SCRIPT_PATH is <packageRoot>/dist/mcp-forwarder.js.
  const nmRoot = resolveNodeModulesRoot(dirname(dirname(fwd)));
  // Attached to every stable resolution so the claude-code adapter can map
  // its hook/statusline bins into the copy (#180 — see mapBinToStableRuntime).
  const stable = { rootDir: target.rootDir, sourceNodeModules: nmRoot ?? undefined };
  if ((await fileExists(target.markerPath)) && (await fileExists(target.forwarderPath))) {
    return { path: target.forwarderPath, action: "reused", note: `stable runtime ${version} reused (${target.rootDir})`, ...stable };
  }
  if (opts.dryRun) {
    return { path: target.forwarderPath, action: "would-copy", note: `would copy runtime to ${target.rootDir} (npx cache is ephemeral)`, ...stable };
  }

  if (!nmRoot) {
    return { path: fwd, action: "fallback", note: "npx cache detected but package layout unexpected — registering the cache path (prefer a permanent install: npm i -g)" };
  }
  try {
    await copyRuntimeTree(nmRoot, target, version);
    await pruneOldRuntimes(target);
    return { path: target.forwarderPath, action: "copied", note: `copied to ${target.rootDir} (npx cache is ephemeral — registrations now survive cache eviction)`, ...stable };
  } catch (e) {
    // Concurrent install may have won the rename race — the copy is there.
    if (await fileExists(target.forwarderPath)) {
      return { path: target.forwarderPath, action: "reused", note: `stable runtime ${version} reused (${target.rootDir})`, ...stable };
    }
    return { path: fwd, action: "fallback", note: `runtime copy failed (${(e as Error).message}) — registering the npx cache path` };
  }
}

export interface ForwarderPathCheck {
  detail: string;
  broken: boolean;
}

/**
 * The version a registration is pinned to, read from the path itself, or null
 * when the path is not inside `~/.bastra/runtime/<version>/`.
 *
 * The directory name is the authority here, not `runtime-source.json`. The
 * marker records what a copy CLAIMED at write time; what the surfaces actually
 * execute is whatever sits at the registered path. When the two disagree the
 * path wins, because the path is what runs.
 */
export function pinnedRuntimeVersion(fwd: string, home: string = homedir()): string | null {
  // A Homebrew keg pins its version in the path exactly the same way.
  const keg = homebrewKeg(fwd);
  if (keg) return keg.version;
  const base = join(home, ".bastra", "runtime") + sep;
  const norm = fwd.split(/[\\/]+/).join(sep);
  if (!norm.startsWith(base)) return null;
  const rest = norm.slice(base.length);
  const version = rest.split(sep)[0];
  return version && version.length > 0 ? version : null;
}

/**
 * Doctor's forwarder-path line (#180; the stale-pin case is #304).
 *
 * Two failure shapes, and the second one is the quiet one:
 *
 *  - a registration inside the npx cache still works today but breaks silently
 *    when npm evicts the cache entry;
 *  - a registration pinned to `~/.bastra/runtime/<old-version>/` keeps working
 *    forever and never breaks — it just runs code from a version that was
 *    replaced. Everything reports success: the installer, `bastra version`, the
 *    surfaces. Only the pinned path still says what is actually executing.
 *
 * The second one is how an update can be "installed" and simultaneously not in
 * effect, which is exactly what a version-pinning scheme must never hide.
 */
export function checkForwarderRegistration(
  fwd: string,
  exists: boolean,
  surface: string,
  runningVersion: string = VERSION,
  home: string = homedir(),
  stablePath: (p: string) => string = homebrewStablePath,
): ForwarderPathCheck {
  if (!exists) {
    return { detail: `${fwd} (MISSING — re-run 'bastra install ${surface}')`, broken: true };
  }
  if (isEphemeralInstallPath(fwd)) {
    return {
      detail: `${fwd} (EPHEMERAL npx cache — breaks when npm evicts it; re-run 'bastra install ${surface}' to pin ~/.bastra/runtime)`,
      broken: true,
    };
  }
  const pinned = pinnedRuntimeVersion(fwd, home);
  if (pinned && pinned !== runningVersion) {
    return {
      detail:
        `${fwd} (STALE PIN — this surface runs ${pinned}, but ${runningVersion} is installed; ` +
        `the update is on disk and not in effect. Fix: 'bastra install ${surface}')`,
      broken: true,
    };
  }
  // "It exists" is not "it will keep existing". A registration at the CURRENT
  // keg passes every check above today and dies at the next `brew upgrade` +
  // `brew cleanup` — the same shape as the npx cache, one package manager over.
  if (stablePath(fwd) !== fwd) {
    return {
      detail:
        `${fwd} (VERSION-PINNED Homebrew keg — runs now, breaks after the next brew upgrade + cleanup; ` +
        `re-run 'bastra install ${surface}' to register ${stablePath(fwd)})`,
      broken: true,
    };
  }
  return { detail: `${fwd} (exists)`, broken: false };
}
