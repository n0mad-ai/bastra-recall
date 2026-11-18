import { stubFreshness, stubFreshnessLines, type StubFreshnessIo } from "./stub-freshness.js";
import { refreshAssistantAddressRuntime } from "../assistant-address.js";
/** Installer update orchestration and cross-client restart guidance (#15). */
import { spawnSync } from "node:child_process";
import {
  captureUpdateNpm,
  runUpdateNpm,
  globalDaemonScript,
  isWrapperInstallPath,
  DAEMON_NPM_PACKAGE,
  updatePaths,
  type UpdateRuntimeIo,
} from "./update-npm.js";
import { CLI_PACKAGE } from "./cli-on-path.js";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cmdInstall } from "./commands.js";
import { findExecutable, run, runCaptured } from "./exec.js";
import { VERSION } from "./helpers.js";
import { buildManifest, formatPreflight, preflight, writeManifest, verifyProvenance } from "./update-preflight.js";
import { activePatches, applySeries } from "../patch-registry.js";
import { formatApplyOutcome, writeLastRun } from "../patch-report.js";
import { isEphemeralInstallPath } from "./stable-runtime.js";
import {
  decideSourceBuild,
  describeSourceBuild,
  gitRootFor,
  inspectSourceBuild,
  provenRevision,
  type SourceBuildState,
} from "./source-build.js";
import { describeLiveRevision, liveRevisionOfDaemon } from "./live-revision.js";
import { clearBlockedUpdate, recordBlockedUpdate } from "../update-blocked.js";
import { unsupportedNode } from "../node-support.js";
import type { ParsedArgs } from "./types.js";
import { updateWordsIn, type UpdateWords } from "./update-words.js";
import { taskCliLanguage } from "./task-cli-words.js";
import { autostartWordsIn, type AutostartWords } from "./autostart-words.js";

/** The hand-off note of the npx re-registration; English when no words are given. */
function sayHandingOff(bin: string, w: UpdateWords = updateWordsIn("en")): void {
  say(w.handingOff(bin));
}

/** One write per line, as the lines were always written. */
function say(lines: readonly string[], write: (s: string) => void = (s) => process.stdout.write(s)): void {
  for (const line of lines) write(line);
}

import { autostartService, refreshManagedAutostart, stableNodeBin } from "./autostart.js";
import type { InstalledRuntime } from "./autostart.js";
import { DAEMON_SCRIPT_PATH } from "./paths.js";
import { resolveDaemonEndpoint } from "../daemon-endpoint.js";

export type InstallSource = "brew" | "npm-global" | "source" | "unknown";

export interface InstallMode {
  mode: InstallSource;
  cliPath: string;
  detail: string;
  updateCommand: string;
  /** npm-global only: the package `npm install -g` updates. */
  npmPackage?: string;
}

/**
 * Heuristic — uses the on-disk path of this CLI module:
 *   …/node_modules/bastra-recall/node_modules/@bastra-recall/daemon/…
 *                                → npm-global via the wrapper (`npm install -g bastra-recall`)
 *   …/node_modules/@bastra-recall/daemon/dist/cli/update.js
 *     (npm prefix root)        → npm-global, the daemon package itself
 *   /opt/homebrew or /Cellar    → brew
 *   path under a git working tree (sibling package.json + .git up the tree)
 *                                → source
 *   else                          → unknown
 */
export function detectInstallMode(cliPathOverride?: string): InstallMode {
  const cliPath = cliPathOverride ?? fileURLToPath(import.meta.url);
  const normalizedPath = cliPath.replace(/\\/g, "/");

  // npm-global: cliPath sits inside a `node_modules/@bastra-recall/daemon/` tree.
  // Checked BEFORE Homebrew: Homebrew's own node uses /opt/homebrew as the npm
  // prefix, so an npm install lands in /opt/homebrew/lib/node_modules — while
  // the Homebrew formula runs from Cellar/…/libexec/packages/daemon and never
  // from a node_modules path.
  if (normalizedPath.includes("/node_modules/@bastra-recall/") || normalizedPath.includes("/lib/node_modules/")) {
    const npmPackage = isWrapperInstallPath(cliPath) ? CLI_PACKAGE : DAEMON_NPM_PACKAGE;
    return {
      mode: "npm-global",
      cliPath,
      detail:
        npmPackage === CLI_PACKAGE
          ? `installed via npm (global, package ${CLI_PACKAGE})`
          : "installed via npm (global)",
      updateCommand: `npm install -g ${npmPackage}@latest`,
      npmPackage,
    };
  }

  // Homebrew Cellar
  if (
    cliPath.startsWith("/opt/homebrew/") ||
    cliPath.startsWith("/usr/local/Cellar/") ||
    cliPath.includes("/homebrew/Cellar/") ||
    cliPath.includes("/Cellar/bastra-recall/")
  ) {
    return {
      mode: "brew",
      cliPath,
      detail: "installed via Homebrew",
      updateCommand: "brew upgrade bastra-recall",
    };
  }

  // source: walk up from the cli file, look for a .git directory next to a package.json.
  if (hasGitAncestor(cliPath)) {
    return {
      mode: "source",
      cliPath,
      detail: "running from source checkout",
      updateCommand: "git pull && npm ci && npm run build:deploy",
    };
  }

  return {
    mode: "unknown",
    cliPath,
    detail: "unable to determine install mode",
    updateCommand: "see https://github.com/n0mad-ai/bastra-recall/releases",
  };
}

function hasGitAncestor(start: string): boolean {
  let dir = dirname(start);
  for (let i = 0; i < 12; i++) {
    if (existsSync(resolve(dir, ".git"))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
  return false;
}

/**
 * Package root of the installation this CLI runs from: `cliPath` points at
 * <root>/dist/cli/update.js, so the root is two levels above the cli dir.
 * Exported so the preflight wiring can be pinned without a real install.
 */
export function packageRootFromCliPath(cliPath: string, platform: NodeJS.Platform = process.platform): string {
  const paths = updatePaths(platform);
  return paths.resolve(paths.dirname(cliPath), "..", "..");
}

/**
 * Hand the re-registration to the binary the installer just put in place.
 *
 * Returns its exit code, or `null` when no installed binary could be found —
 * the caller then falls back to registering inline and says so, because that
 * path is the one that produces a stale pin.
 *
 * The lookup deliberately does NOT use `findExecutable("bastra")`: inside an
 * npx run the cache's own bin directory sits on PATH, so a name lookup can
 * resolve straight back to the old process this hand-off exists to escape.
 * `npm prefix -g` names the global root regardless of what PATH currently
 * prefers.
 */
export function reRegisterViaInstalledBinary(
  args: ParsedArgs,
  viaWrapper: boolean,
  io: UpdateRuntimeIo = {},
  spawn: typeof spawnSync = spawnSync,
  w?: UpdateWords
): number | null {
  const platform = io.platform ?? process.platform;
  const prefix = captureUpdateNpm(["prefix", "-g"], { timeoutMs: 30_000 }, io);
  const root = prefix.stdout.trim();
  if (!prefix.ok || !root) return null;

  // `bastra` is the bin the daemon package has always declared — v0.7.9 already
  // shipped it under that name. `bastra-recall` is checked only as a second
  // guess: it is the name of the npm WRAPPER package (`npx bastra-recall`) and
  // has been seen in a Homebrew prefix, so a global root may carry it. Never
  // assumed to exist; the list is ordered by what is actually declared.
  const script = platform === "win32" ? globalDaemonScript(root, io, viaWrapper) : null;
  const windowsCli = script ? updatePaths(platform).resolve(updatePaths(platform).dirname(script), "cli.js") : null;
  const candidates =
    platform === "win32"
      ? windowsCli
        ? [windowsCli]
        : []
      : [resolve(root, "bin", "bastra"), resolve(root, "bin", "bastra-recall")];
  const bin = candidates.find((p) => (io.exists ?? existsSync)(p));
  if (!bin) return null;

  sayHandingOff(bin, w);
  const installArgs = ["install", "all", "--no-ollama", "--no-stop-hook"];
  if (args.yes || args.staged) installArgs.push("--yes");
  if (args.vaultPath) installArgs.push("--vault", args.vaultPath);
  const r =
    platform === "win32"
      ? spawn(io.node ?? process.execPath, [bin, ...installArgs], { stdio: "inherit", timeout: 300_000 })
      : spawn(bin, installArgs, { stdio: "inherit", timeout: 300_000 });
  if (r.error || r.status === null) return null;
  return r.status;
}

/**
 * #268 — may the locally-modified-files preflight run for this install mode?
 *
 * Only where the update REPLACES the same directory. `npm install -g` does: the
 * package root stays put, so a hash baseline taken before an update is still
 * comparable after it, and a local patch really would be destroyed without a
 * word (the #253 case).
 *
 * Homebrew does not, and this is not a detail. `brew upgrade` builds a new keg
 * under Cellar/bastra-recall/<version>/libexec and re-points the symlinks; the
 * old keg is untouched until `brew cleanup` removes it. Two consequences:
 *
 *  1. A locally modified file in the current keg is abandoned, never
 *     overwritten — there is no in-place replacement to guard.
 *  2. `packageRootFromCliPath()` returns that version-pinned keg path, so a
 *     manifest written from it can never match the root the NEXT version runs
 *     from. Every later preflight would take the `manifest.root !== opts.root`
 *     branch and skip the check, silently, forever — while printing "no install
 *     manifest yet … (a baseline is written after this update)" on the first
 *     run, which for brew is never true.
 *
 * There is no version-independent anchor to fall back on either:
 * /opt/homebrew/opt/bastra-recall is a symlink whose target is a completely
 * different file set after every upgrade, so a baseline taken through it would
 * report every file as modified. A check that can only ever skip itself is
 * worse than none, so brew says so out loud instead (see cmdUpdate).
 */
export function hasInPlacePreflight(mode: InstallSource): boolean {
  return mode === "npm-global";
}

/**
 * Version of what is on disk right now. After the swap the running process
 * still reports the VERSION it was built with, and a baseline labelled with the
 * version it just replaced would send the NEXT update's backups into the wrong
 * directory. Falls back to VERSION when package.json is unreadable.
 */
function packageVersion(root: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" && pkg.version ? pkg.version : null;
  } catch {
    return null;
  }
}

/** #528 — build state of the checkout this CLI is running from. */
export function sourceBuildState(cliPath: string): SourceBuildState {
  const root = gitRootFor(cliPath);
  if (!root) {
    return decideSourceBuild({ newestSourceMs: null, newestBuildMs: null, head: null, built: null });
  }
  return inspectSourceBuild(root, findExecutable("git"));
}

/**
 * #528 — the whole source-mode "install" step: verify, and refuse to go on.
 *
 * `rc` 1 means the caller returns immediately — nothing is re-registered and
 * the daemon is not restarted, so a checkout that was pulled but never built
 * cannot end up pinned across every surface. `state` carries what may be
 * claimed afterwards — see provenRevision() in source-build.ts.
 */
export function verifySourceCheckout(
  cliPath: string,
  rebuild: string,
  write: (s: string) => void,
  w: UpdateWords = updateWordsIn("en")
): { rc: number; state: SourceBuildState } {
  write(w.verifyingSource);
  const state = sourceBuildState(cliPath);
  write(describeSourceBuild(state, rebuild));
  if (!state.ok) {
    write(`\n${w.leftAlone}`);
    return { rc: 1, state };
  }
  write("\n");
  return { rc: 0, state };
}

/** Refuse activation of a fresh daemon paired with old compiled hook code.
 * Node thin-client installations have no compiled binary to check. */
export async function verifySourceStubs(
  write: (s: string) => void,
  io: StubFreshnessIo = {},
  w: UpdateWords = updateWordsIn("en")
): Promise<number> {
  const report = await stubFreshness({ ...io, includeOwn: true });
  const invalid = report.findings.some((f) => f.state !== "ok" || f.statusline !== "ok");
  if (!invalid) return 0;
  for (const line of stubFreshnessLines(report)) write(`  ${line}\n`);
  if (report.findings.some((f) => !f.foreign && (f.state !== "ok" || f.statusline !== "ok"))) {
    write(w.buildTogether);
  }
  write(w.leftAlone);
  return 1;
}

export function installedVersion(root: string): string {
  return packageVersion(root) ?? VERSION;
}

/**
 * #435 — the daemon entry point of the installation that is on disk NOW.
 *
 * The managed LaunchAgent names an ABSOLUTE path, and after `brew upgrade` the
 * absolute path this process runs from is the keg the installer just
 * superseded: Homebrew builds every version into its own
 * Cellar/bastra-recall/<version>/ and re-points the symlinks, while this
 * process keeps executing the old modules it was started with. Writing a plist
 * from `DAEMON_SCRIPT_PATH` therefore pins the autostart back onto the old keg
 * — which either runs the replaced code or, after `brew cleanup`, is gone.
 *
 * So ASK the installer where it put things, exactly as the npx hand-off above
 * asks `npm prefix -g` instead of trusting PATH. No fallback to this process's
 * own path for brew/npm: a silent fallback is precisely the stale pin, and the
 * caller can say so out loud instead. Where the installer never moves anything
 * (source checkout, unknown), this process's entry point IS the installation.
 *
 * The node binary gets the same treatment for the same reason — see
 * `stableNodeBin()`: under Homebrew `process.execPath` is a version-pinned node
 * keg, and a plist naming it dies the next time node is upgraded and cleaned up.
 */
export function resolveInstalledRuntime(mode: InstallMode, io: UpdateRuntimeIo = {}): InstalledRuntime | null {
  const script = installedDaemonScript(mode, io);
  if (!script) return null;
  // dist/index.js → the daemon package root that carries the version.
  const paths = updatePaths(io.platform);
  const root = paths.resolve(paths.dirname(script), "..");
  let version: string | null = null;
  try {
    const candidate = io.read ? JSON.parse(io.read(paths.resolve(root, "package.json"))).version : packageVersion(root);
    version = typeof candidate === "string" && candidate ? candidate : null;
  } catch {
    /* leave unknown */
  }
  return { node: io.node ?? stableNodeBin(), script, version };
}

function installedDaemonScript(mode: InstallMode, io: UpdateRuntimeIo = {}): string | null {
  if (mode.mode === "brew") {
    const brewBin = findExecutable("brew");
    if (!brewBin) return null;
    const r = runCaptured(brewBin, ["--prefix", "bastra-recall"], { timeoutMs: 60_000 });
    const prefix = r.stdout.trim();
    if (!r.ok || !prefix) return null;
    return existsFile(resolve(prefix, "libexec", "packages", "daemon", "dist", "index.js"));
  }
  if (mode.mode === "npm-global") {
    const r = captureUpdateNpm(["prefix", "-g"], { timeoutMs: 60_000 }, io);
    const root = r.stdout.trim();
    if (!r.ok || !root) return null;
    return globalDaemonScript(root, io, mode.npmPackage === CLI_PACKAGE);
  }
  return existsFile(DAEMON_SCRIPT_PATH);
}

/**
 * Step 1a of `bastra update`: put the registered local patches back onto the
 * tree the installer just produced. `patchReapplyRoot` is only asked once there
 * is a series, because on Homebrew answering it spawns `brew --prefix`.
 */
export function reapplyPatchSeries(
  mode: InstallMode,
  packageRoot: string,
  io: {
    series?: () => readonly unknown[];
    root?: (m: InstallMode, p: string) => string | null;
    apply?: typeof applySeries;
    record?: typeof writeLastRun;
    version?: (root: string) => string;
    out?: (s: string) => void;
    words?: UpdateWords;
  } = {}
): void {
  const w = io.words ?? updateWordsIn("en");
  const out = io.out ?? ((t: string) => process.stdout.write(t));
  const series = (io.series ?? activePatches)();
  if (series.length === 0) return;
  const root = (io.root ?? patchReapplyRoot)(mode, packageRoot);
  if (!root) {
    if (mode.mode === "brew") {
      out(w.kegNotFound(series.length));
    }
    return;
  }
  out(w.reapplying(series.length));
  try {
    const outcome = (io.apply ?? applySeries)(root, { version: (io.version ?? installedVersion)(root) });
    (io.record ?? writeLastRun)(outcome);
    out(formatApplyOutcome(outcome));
    if (outcome.setAside.length > 0) {
      out(w.setAside);
    }
    out("\n");
  } catch (e) {
    // A patch step that throws must never fail an update whose install
    // already succeeded — the new version is on disk and working, only the
    // local additions are missing. Say so and continue.
    out(w.reapplyFailed((e as Error).message));
  }
}

/**
 * The daemon package root the patch series goes onto after an update, or null
 * where there is none to patch: a source checkout is the user's own git tree,
 * and "unknown" installed nothing.
 */
export function patchReapplyRoot(
  mode: InstallMode,
  packageRoot: string,
  installedScript: (m: InstallMode) => string | null = installedDaemonScript
): string | null {
  if (mode.mode === "npm-global") return packageRoot;
  if (mode.mode === "brew") {
    const script = installedScript(mode);
    return script ? resolve(dirname(script), "..") : null;
  }
  return null;
}

/**
 * The closing question of `bastra update`: is there a model recommendation the
 * user has not answered yet? (`bastra models ask` — a question on a terminal,
 * a plain notice anywhere else, nothing at all when there is nothing to say.)
 *
 * Asked by the INSTALLED cli, not by this process, for the reason
 * `resolveInstalledRuntime` exists: after the installer ran, this process is
 * still the old code, and a recommendation ships with the release — the old
 * process would ask about the recommendation that was just replaced, or about
 * none. Best-effort: if the installed cli cannot be found or started, the
 * SessionStart block and the CLI hint still carry the notice.
 */
export function askModelRecommendation(
  installed: InstalledRuntime | null,
  /** Tests capture the child's output; `bastra update` hands it the terminal. */
  stdio: "inherit" | "pipe" = "inherit"
): ReturnType<typeof spawnSync> | null {
  if (!installed) return null;
  const cli = existsFile(resolve(dirname(installed.script), "cli.js"));
  if (!cli) return null;
  // An hour: the answer may start a multi-GB pull. Without a terminal the
  // child prints and returns at once, so nothing unattended waits on this.
  // Its exit code is not the update's: the update is done at this point.
  return spawnSync(installed.node, [cli, "models", "ask"], { stdio, timeout: 3_600_000 });
}

/**
 * What to tell the user when `npm install -g` failed. Updating the daemon
 * package fails with EEXIST when the `bastra` command belongs to the wrapper
 * package, and the layout cannot always show which one is installed (an npx
 * run, for one) — so that case names the wrapper's command as well.
 */
export function npmInstallFailure(npmPackage: string, detail: string, w: UpdateWords = updateWordsIn("en")): string {
  const manual = `npm install -g ${npmPackage}@latest`;
  const wrapperHint = npmPackage === CLI_PACKAGE ? "" : w.npmWrapperHint(CLI_PACKAGE);
  return w.npmFailed(detail, manual) + wrapperHint + w.npmAgain;
}

/** Step 1 for npm installs: update the package that is actually installed. */
function installNpmUpdate(mode: InstallMode, io: UpdateRuntimeIo, w: UpdateWords): boolean {
  const npmPackage = mode.npmPackage ?? DAEMON_NPM_PACKAGE;
  const r = runUpdateNpm(["install", "-g", `${npmPackage}@latest`], { timeoutMs: 300_000, showProgress: true }, io);
  if (!r.ok) process.stdout.write(npmInstallFailure(npmPackage, r.detail, w));
  return r.ok;
}

function existsFile(path: string): string | null {
  return existsSync(path) ? path : null;
}

/** Injectable lifecycle boundaries let platform regressions run without touching live configs. */
export interface UpdateIo extends UpdateRuntimeIo {
  cliPath?: string;
  spawn?: typeof spawnSync;
  preflight?: typeof preflight;
  reapply?: typeof reapplyPatchSeries;
  manifest?: typeof buildManifest;
  writeManifest?: typeof writeManifest;
  clearBlocked?: typeof clearBlockedUpdate;
  install?: typeof cmdInstall;
  refresh?: typeof refreshManagedAutostart;
  refreshAddress?: typeof refreshAssistantAddressRuntime;
  ask?: typeof askModelRecommendation;
  service?: typeof autostartService;
  /** Test seam for the Node.js floor check; defaults to the running Node. */
  nodeVersion?: string;
}
/** Run the new package's helper module in its own Node process after installation. */
export async function refreshAddressFromInstalledRuntime(
  installed: InstalledRuntime,
  io: Pick<UpdateIo, "spawn"> = {}
): Promise<void> {
  const code =
    "const {pathToFileURL}=await import('node:url');const {dirname,join}=await import('node:path');const m=await import(pathToFileURL(join(dirname(process.argv[1]),'assistant-address.js')).href);await m.refreshAssistantAddressRuntime();";
  const result = (io.spawn ?? spawnSync)(installed.node, ["--input-type=module", "-e", code, installed.script], {
    stdio: "inherit",
    timeout: 15000,
  });
  if (result.error || result.status !== 0) throw Error("newly installed assistant runtime refresh failed");
}
/**
 * Below the supported Node.js floor nothing is installed: a newer release may
 * need what this Node lacks, and swapping the files first would leave the
 * surfaces and the autostart on code that cannot run. The staged path has no
 * reader, so it leaves the reason for the next SessionStart (#268 channel),
 * which also stops further unattended attempts until `bastra update` succeeds.
 */
async function refuseOnUnsupportedNode(args: ParsedArgs, io: UpdateIo, w: UpdateWords): Promise<boolean> {
  const reason = unsupportedNode(io.nodeVersion);
  if (!reason) return false;
  const refusal = `${reason}. Update Node.js first, then run 'bastra update'.`;
  process.stdout.write(w.nodeRefused(refusal, reason));
  if (args.staged) await recordBlockedUpdate({ ok: false, dirty: [], refusal, notes: [] }, VERSION);
  return true;
}

export async function cmdUpdate(args: ParsedArgs, io: UpdateIo = {}): Promise<number> {
  // language.primary, read once per run (English when unset or unreadable).
  const language = await taskCliLanguage().catch(() => "en");
  const w = updateWordsIn(language);
  try {
    if (await refuseOnUnsupportedNode(args, io, w)) return 1;
    return await performUpdate(args, io, w, autostartWordsIn(language));
  } catch (error) {
    process.stderr.write(w.stopped((error as Error).message));
    return 1;
  }
}
/** What every step of one `bastra update` run reads. */
interface UpdateRun {
  args: ParsedArgs;
  io: UpdateIo;
  platform: NodeJS.Platform;
  mode: InstallMode;
  packageRoot: string;
  /** See `hasInPlacePreflight`. */
  preflightSupported: boolean;
  /** Only brew and npm-global actually run an installer here. */
  runsInstaller: boolean;
  /** The words in language.primary, read once at the start. */
  w: UpdateWords;
  /** The autostart refresh's words, in the same language. */
  autostartWords: AutostartWords;
}

async function performUpdate(
  args: ParsedArgs,
  io: UpdateIo,
  w: UpdateWords,
  autostartWords: AutostartWords
): Promise<number> {
  const platform = io.platform ?? process.platform;
  const mode = detectInstallMode(io.cliPath);
  if (args.staged) {
    process.stdout.write(w.staged);
  }
  const wrapper = mode.npmPackage === CLI_PACKAGE ? CLI_PACKAGE : null;
  say(w.installMode(w.modeDetail(mode.mode, mode.detail, wrapper), mode.cliPath));

  // #268 + #226 — the preflight guards the step that replaces an installation
  // IN PLACE, and only npm-global does that (see hasInPlacePreflight below).
  // A source checkout is git-managed (every local change is already tracked and
  // nothing here overwrites it), and the "unknown" branch installs nothing at
  // all — guarding those would mean a dirty tree could veto a re-registration
  // that never touched a single package file.
  const u: UpdateRun = {
    args,
    io,
    platform,
    mode,
    packageRoot: packageRootFromCliPath(mode.cliPath, platform),
    preflightSupported: hasInPlacePreflight(mode.mode),
    runsInstaller: mode.mode === "brew" || mode.mode === "npm-global",
    w,
    autostartWords,
  };

  // Everything below the dry-run runs for real only: the plan returns here.
  if (args.dryRun) return describeUpdatePlan(u);

  if (!(await guardInstall(u))) return 1;

  // 1. Update the binary itself.
  const step = await installStep(u);
  if (step.rc !== 0) return step.rc;
  // #528 — set by the source branch. The closing line may only name a
  // revision this state PROVED, and only once the daemon confirms it serves it.
  const sourceState = step.sourceState;

  // 1a. Reapply the registered local patch series (#269) onto what the
  //     installer just wrote. This is the repair half of #268: that one detects
  //     and backs up, this one puts the user's own fixes back.
  //
  //     Order matters twice over. It runs AFTER the install, because there is
  //     nothing to patch until the new files are on disk. And it runs BEFORE the
  //     baseline below, because the baseline defines what the next update calls
  //     "unmodified" — taking it before the patches go on would report every
  //     registered patch as a local modification on the next run, which is
  //     exactly the noise #268 exists to avoid. The patched tree is the tree
  //     bastra produced; what the user changes after that is what is dirty.
  //
  //     Not scoped to the preflight's modes. The preflight guards a tree that is
  //     replaced in place, which a Homebrew upgrade never does — but the reapply
  //     is about the tree the user runs NEXT, and a fresh keg carries none of
  //     their patches. Scoping this to npm-global made `bastra patches` a no-op
  //     on every Homebrew install while `bastra help` promised the series is
  //     "reapplied onto the fresh install after every update". The keg to patch
  //     is the one the installer just linked, asked from brew, never this
  //     process's own (superseded) path.
  (io.reapply ?? reapplyPatchSeries)(mode, u.packageRoot, { words: w });

  // 1b. Baseline for the NEXT update (#268). Without this write the dirty check
  //     above can never say more than "unknown" — this is the step that starts
  //     the chain, so it runs even if the re-registration below fails: the files
  //     on disk are already the new ones. Same scope as the check it feeds:
  //     writing one from a Homebrew keg would pin it to a path the next version
  //     no longer runs from, and every later preflight would skip on
  //     `manifest.root !== opts.root` while claiming a baseline had been taken.
  if (u.preflightSupported) await recordBaseline(u);

  // 1c. An installer that ran is the one event that resolves a held-back
  //     automatic update (#268), whatever the recorded reason was. Drop the
  //     record so the next SessionStart stops reporting a block that no longer
  //     stands, and the unattended path is allowed to stage again.
  if (u.runsInstaller) await (io.clearBlocked ?? clearBlockedUpdate)();

  // 2. Re-register every surface (idempotent — refreshes skill content if SKILL.md changed)
  const registered = await reRegisterSurfaces(u);
  if (registered !== 0) return registered;

  const installed = resolveInstalledRuntime(mode, io);
  // Refresh from the newly installed package, never the old updater's module cache.
  await refreshAddressStep(u, installed);

  // 3. Der verwaltete Dienst, BEVOR irgendetwas Erfolg meldet.
  //
  //    Ein Update verschiebt die Installation (Homebrew legt jede Version in ein
  //    eigenes Verzeichnis), und ein LaunchAgent zeigt auf einen ABSOLUTEN Pfad.
  //    Zeigt er noch auf die alte, startet er danach entweder nichts mehr oder
  //    weiter den alten Code. Fremde plists bleiben unangetastet.
  //
  //    Beide Update-Wege laufen hier durch — das ist der Kern von #441: „jetzt
  //    nicht neu starten" ist eine andere Entscheidung als „den plist nicht
  //    umbiegen". Staged biegt um (`reload: false`), kickstartet aber nicht.
  //    Und die Laufzeit, auf die umgebogen wird, kommt vom Installer, nicht von
  //    diesem Prozess (#435) — siehe resolveInstalledRuntime.
  if (!(await pointAutostart(u, installed))) return 1;

  // 4. Daemon restart.
  //    --staged deliberately skips the kickstart: the running daemon keeps the
  //    old code in memory and a current session stays intact. The new code goes
  //    live on the next daemon boot (idle-shutdown after 30 min → forwarder
  //    respawns with the new code), or immediately when the user restarts.
  if (args.staged) {
    say(w.stagedRestart);
    return 0;
  }
  await restartDaemon(u);
  return finishUpdate(u, sourceState, installed);
}

/**
 * The preflight runs ONCE, in front of both install branches — two guards that
 * can each veto the same action is how auto-updates die (see
 * update-preflight.ts). False = refused, nothing installed.
 */
async function guardInstall(u: UpdateRun): Promise<boolean> {
  if (u.preflightSupported) return runPreflightStep(u);
  if (u.mode.mode === "brew") say(u.w.brewPreflight);
  return true;
}

/** Step 3: point the managed autostart at the new runtime; false = it could not. */
async function pointAutostart(u: UpdateRun, installed: InstalledRuntime | null): Promise<boolean> {
  const autostart = await (u.io.refresh ?? refreshManagedAutostart)(
    (s) => process.stdout.write(s),
    {
      target: installed,
      reload: !u.args.staged,
      platform: u.platform,
    },
    u.autostartWords
  );
  if (autostart.ok) return true;
  process.stdout.write(u.w.autostartFailed);
  return false;
}

/**
 * #528 — the closing line and the restart report have to tell one story. In
 * source mode the daemon itself is asked which build it serves; in every
 * other mode there is no local revision to compare against and the line stays
 * the plain one.
 */
async function finishUpdate(
  u: UpdateRun,
  sourceState: SourceBuildState | null,
  installed: InstalledRuntime | null
): Promise<number> {
  const { io } = u;
  if (sourceState !== null) {
    const { verdict, daemonRevision } = await liveRevisionOfDaemon(provenRevision(sourceState));
    const said = describeLiveRevision(verdict, { state: sourceState, daemonRevision });
    process.stdout.write(said.report);
    process.stdout.write(said.closing);
    (io.ask ?? askModelRecommendation)(installed);
    return 0;
  }

  process.stdout.write(u.w.done);
  (io.ask ?? askModelRecommendation)(installed);
  return 0;
}

/** `bastra update --dry-run`: the plan, written as the action (#528). */
function describeUpdatePlan(u: UpdateRun): number {
  const { args, mode, w } = u;
  say(w.planHeader(mode.mode));
  process.stdout.write(mode.mode === "source" ? w.planRebuild(mode.updateCommand) : w.planUpdate(mode.updateCommand));
  if (u.preflightSupported) {
    process.stdout.write(w.planPreflight);
  } else if (mode.mode === "brew") {
    process.stdout.write(w.planBrewPreflight);
  }
  // The plan names the reapply wherever the real run performs it (#528).
  const pending = u.runsInstaller ? activePatches() : [];
  if (pending.length > 0) {
    process.stdout.write(w.planReapply(pending.length));
  }
  // #528 — the plan has to be the action. Only brew/npm-global actually run
  // an update command here; source and unknown never did, however confidently
  // the old text said "would: run the update command above".
  if (u.runsInstaller) {
    process.stdout.write(w.planInstall);
  } else if (mode.mode === "source") {
    say(w.planSource);
  } else {
    process.stdout.write(w.planUnknown);
  }
  process.stdout.write(w.planRegister);
  process.stdout.write(w.planRestart(args.staged === true));
  return 0;
}

/** The preflight in front of an in-place install; false = refused, nothing installed. */
async function runPreflightStep(u: UpdateRun): Promise<boolean> {
  const { args, io, mode, w } = u;
  process.stdout.write(w.preflight(mode.mode === "npm-global"));
  const verdict = await (io.preflight ?? preflight)({
    root: u.packageRoot,
    // --staged is the detached SessionStart path: it cannot ask, so a finding
    // ends it rather than being silently overridden.
    unattended: args.staged === true,
    force: args.force === true,
    // brew and source carry no registry attestation — only npm publishes one.
    checkProvenance: mode.mode === "npm-global",
    verify: u.platform === "win32" ? (root) => verifyProvenance(root, io, io.spawn) : undefined,
  });
  const rendered = formatPreflight(verdict);
  // Printed on the way through as well, not only on refusal: a backup nobody
  // was told about is a backup nobody restores from.
  process.stdout.write(rendered ? `${rendered}\n\n` : w.nothingLocal);
  if (verdict.ok) return true;
  // #268 — on the staged path this stdout goes to /dev/null (detached,
  // stdio:"ignore") while the SessionStart hook already announced the
  // update as happening. Leave the verdict on disk so the next session
  // reports the refusal instead of repeating that claim. Only unattended:
  // an interactive refusal is being read right now, and recording it would
  // pause the automatic path over a decision the user already saw.
  if (args.staged) await recordBlockedUpdate(verdict, installedVersion(u.packageRoot));
  process.stdout.write(w.nothingInstalled);
  return false;
}

/**
 * Step 1, per install mode. `rc` non-zero ends the update with that code;
 * `sourceState` is what a source checkout proved about its build.
 *
 * Resolved absolute paths + hard timeouts (#91): the staged path runs
 * unattended from the SessionStart hook (detached, stdio:"ignore"), so a
 * bare-name spawn would inherit the stripped GUI PATH (the #79 root cause)
 * and a network-stalled brew/npm would hang unbounded. ETIMEDOUT/ENOENT/
 * signal all surface as failure via run() — never as silent success.
 */
async function installStep(u: UpdateRun): Promise<{ rc: number; sourceState: SourceBuildState | null }> {
  const { mode, w } = u;
  if (mode.mode === "brew") {
    process.stdout.write(`→ ${mode.updateCommand}\n`);
    if (!installBrewUpdate(w)) return { rc: 1, sourceState: null };
    process.stdout.write("\n");
  } else if (mode.mode === "npm-global") {
    process.stdout.write(`→ ${mode.updateCommand}\n`);
    if (!installNpmUpdate(mode, u.io, w)) return { rc: 1, sourceState: null };
    process.stdout.write("\n");
  } else if (mode.mode === "source") {
    return verifySourceStep(u);
  } else {
    say(w.unknownMode(mode.updateCommand));
  }
  return { rc: 0, sourceState: null };
}

/** Step 1 for Homebrew installs. */
function installBrewUpdate(w: UpdateWords): boolean {
  const brewBin = findExecutable("brew");
  if (!brewBin) {
    process.stdout.write(w.brewMissing);
    return false;
  }
  const r = run(brewBin, ["upgrade", "bastra-recall"], { timeoutMs: 300_000, showProgress: true });
  if (!r.ok) {
    process.stdout.write(w.brewFailed(r.detail));
    return false;
  }
  return true;
}

/**
 * #528 — the source branch installs nothing (see source-build.ts for why), so
 * the one thing it owes the user is certainty that what gets re-registered and
 * restarted is the code that is actually in this checkout. An unbuilt or stale
 * tree ends here: no re-registration, no restart, exit 1.
 */
async function verifySourceStep(u: UpdateRun): Promise<{ rc: number; sourceState: SourceBuildState | null }> {
  const { mode, packageRoot, platform, w } = u;
  const verdict = verifySourceCheckout(mode.cliPath, mode.updateCommand, (s) => process.stdout.write(s), w);
  if (verdict.rc !== 0) return { rc: verdict.rc, sourceState: null };
  if (
    (await verifySourceStubs(
      (s) => process.stdout.write(s),
      {
        packageRoot,
        ownBinary: resolve(packageRoot, "stub", platform === "win32" ? "bastra-hook.exe" : "bastra-hook"),
      },
      w
    )) !== 0
  )
    return { rc: 1, sourceState: null };
  return { rc: 0, sourceState: verdict.state };
}

/** Step 1b: the hash baseline the next update's preflight compares against. */
async function recordBaseline(u: UpdateRun): Promise<void> {
  const { io, packageRoot, w } = u;
  try {
    const manifest = await (io.manifest ?? buildManifest)(packageRoot, installedVersion(packageRoot));
    if (manifest.files.length === 0) {
      // The install root we hashed from is empty — an npm prefix that moved,
      // a partially written install. An empty manifest would read as "clean"
      // on every future update, which is strictly worse than no manifest: that
      // at least reports itself as an unknown.
      process.stdout.write(w.baselineEmpty(packageRoot));
    } else {
      await (io.writeManifest ?? writeManifest)(manifest);
      process.stdout.write(w.baselineRecorded(manifest.files.length));
    }
  } catch (e) {
    // A baseline that cannot be written must never fail an update that already
    // succeeded; the next preflight just reports "could not check".
    process.stdout.write(w.baselineFailed((e as Error).message));
  }
}

/** Step 2: re-register every surface. Returns the exit code; 0 = go on. */
async function reRegisterSurfaces(u: UpdateRun): Promise<number> {
  const { args, io, mode, platform, w } = u;
  process.stdout.write(w.reRegistering);
  // --staged runs unattended (spawned from the SessionStart hook), so never block
  // on a confirmation prompt.
  const installArgs: ParsedArgs = {
    ...args,
    command: "install",
    surface: "all",
    yes: args.yes || args.staged,
    // Re-registration is a surface-config refresh — never the place to provision
    // Ollama (a 620 MB download). Hard-skip on EVERY update path (staged from the
    // SessionStart hook, or an interactive `bastra update`); don't lean on the
    // TTY guard alone for an unattended background re-run. (With a provider
    // already effective the install step stays silent — no skip noise.)
    ollama: "skip",
    // Same reasoning for the Stop hook: a silent SessionStart auto-update must
    // NOT bolt the (now default-on) Stop hook onto a user who never opted in.
    // Hard-off here → the adapter's preserve-logic keeps an already-registered
    // one but adds none. Fresh default-on happens only at a real `bastra install`
    // / the wizard, never a background re-register. (Daniel, 2026-07-07)
    withStopHook: false,
  };
  // #304 — a process that runs from the npx cache must NOT do the
  // re-registration itself. This is the bug the 0.7.9→0.8.8 run surfaced.
  //
  // `ensureStableForwarder` pins `~/.bastra/runtime/<version>/`, and the version
  // it uses is `VERSION` — a constant compiled into the RUNNING process. After
  // the installer above, the new code is on disk, but this process is still the
  // old one. So it re-pins its own old version, finds the marker from last time,
  // reports `reused`, and every surface keeps executing the version that was
  // just replaced. Nothing fails: the installer succeeded, `bastra version`
  // reports the new number, and the update is simply not in effect.
  //
  // A permanent install has no such split — its path is the same before and
  // after, so `action: "native"` registers it directly. Only the ephemeral case
  // needs the hand-off, so only the ephemeral case pays for a second process.
  let installRC: number | null = null;
  if (
    u.runsInstaller &&
    (isEphemeralInstallPath(mode.cliPath) || (platform === "win32" && mode.mode === "npm-global"))
  ) {
    installRC = reRegisterViaInstalledBinary(args, mode.npmPackage === CLI_PACKAGE, io, io.spawn, w);
    if (installRC === null) {
      if (platform === "win32") {
        process.stderr.write(w.windowsCliMissing);
        return 1;
      }
      // Could not find the freshly installed binary — fall through and register
      // inline. That reproduces the stale pin, so say it instead of letting the
      // run look clean.
      process.stdout.write(w.oldProcess);
    }
  }
  if (installRC === null) installRC = await (io.install ?? cmdInstall)(installArgs);
  if (installRC !== 0) {
    process.stdout.write(w.reRegisterFailed);
  }
  return installRC;
}

/** The assistant address runtime, refreshed from the newly installed package. */
async function refreshAddressStep(u: UpdateRun, installed: InstalledRuntime | null): Promise<void> {
  const { io } = u;
  try {
    if (io.refreshAddress) await io.refreshAddress();
    else if (u.runsInstaller) {
      if (!installed) throw Error("new installed runtime could not be located");
      await refreshAddressFromInstalledRuntime(installed, io);
    } else await refreshAssistantAddressRuntime();
  } catch (error) {
    process.stderr.write(u.w.addressRefreshFailed((error as Error).message));
  }
}

/** Step 4: restart the daemon where an autostart service can, else say how. */
async function restartDaemon(u: UpdateRun): Promise<void> {
  const { io, platform, w } = u;
  process.stdout.write(w.restarting);
  const service = (io.service ?? autostartService)(platform);
  const state = await service?.status();
  if (platform === "darwin" && state?.managed) {
    process.stdout.write(w.launchAgentRefresh);
  } else if (service && state?.loaded && platform === "darwin") {
    const kick = await service.kickstart();
    if (kick.ok) process.stdout.write(w.kicked);
    else process.stdout.write(w.kickFailed);
  } else if (platform === "win32" && state?.managed) {
    process.stdout.write(w.taskSchedulerRefresh);
  } else {
    describeManualRestart(platform, w);
  }
}

/** #528 — no claim about what is in memory here: this branch cannot restart
 *  anything, so what a running daemon holds is asked afterwards, not guessed. */
function describeManualRestart(platform: NodeJS.Platform, w: UpdateWords): void {
  say(w.manualRestart);
  const port = resolveDaemonEndpoint().port;
  say(platform === "win32" ? w.windowsRestart(port) : w.unixRestart(port));
}
