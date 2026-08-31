/** Installer update orchestration and cross-client restart guidance (#15). */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cmdInstall } from "./commands.js";
import { findExecutable, run } from "./exec.js";
import { VERSION } from "./helpers.js";
import { buildManifest, formatPreflight, preflight, writeManifest } from "./update-preflight.js";
import { activePatches, applySeries, formatApplyOutcome, writeLastRun } from "../patch-registry.js";
import { isEphemeralInstallPath } from "./stable-runtime.js";
import { clearBlockedUpdate, recordBlockedUpdate } from "../update-blocked.js";
import type { ParsedArgs } from "./types.js";

import { refreshManagedAutostart } from "./autostart.js";

const LAUNCH_AGENT_LABEL = "ai.n0mad.bastra-recall";

export type InstallSource = "brew" | "npm-global" | "source" | "unknown";

export interface InstallMode {
  mode: InstallSource;
  cliPath: string;
  detail: string;
  updateCommand: string;
}

/**
 * Heuristic — uses the on-disk path of this CLI module:
 *   /opt/homebrew or /Cellar    → brew
 *   …/node_modules/@bastra-recall/daemon/dist/cli/update.js
 *     (npm prefix root)        → npm-global
 *   path under a git working tree (sibling package.json + .git up the tree)
 *                                → source
 *   else                          → unknown
 */
export function detectInstallMode(cliPathOverride?: string): InstallMode {
  const cliPath = cliPathOverride ?? fileURLToPath(import.meta.url);

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

  // npm-global: cliPath sits inside a `node_modules/@bastra-recall/daemon/` tree.
  if (cliPath.includes("/node_modules/@bastra-recall/") || cliPath.includes("/lib/node_modules/")) {
    return {
      mode: "npm-global",
      cliPath,
      detail: "installed via npm (global)",
      updateCommand: "npm install -g @bastra-recall/daemon@latest",
    };
  }

  // source: walk up from the cli file, look for a .git directory next to a package.json.
  if (hasGitAncestor(cliPath)) {
    return {
      mode: "source",
      cliPath,
      detail: "running from source checkout",
      updateCommand: "git pull && npm ci && npm run build",
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
export function packageRootFromCliPath(cliPath: string): string {
  return resolve(dirname(cliPath), "..", "..");
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
function reRegisterViaInstalledBinary(args: ParsedArgs): number | null {
  const npmBin = findExecutable("npm");
  if (!npmBin) return null;
  const prefix = spawnSync(npmBin, ["prefix", "-g"], { encoding: "utf8", timeout: 30_000 });
  const root = `${prefix.stdout ?? ""}`.trim();
  if (prefix.status !== 0 || !root) return null;

  // `bastra` is the bin the daemon package has always declared — v0.7.9 already
  // shipped it under that name. `bastra-recall` is checked only as a second
  // guess: it is the name of the npm WRAPPER package (`npx bastra-recall`) and
  // has been seen in a Homebrew prefix, so a global root may carry it. Never
  // assumed to exist; the list is ordered by what is actually declared.
  const candidates = [resolve(root, "bin", "bastra"), resolve(root, "bin", "bastra-recall")];
  const bin = candidates.find((p) => existsSync(p));
  if (!bin) return null;

  process.stdout.write(`  → handing the re-registration to ${bin}\n`);
  process.stdout.write("    (this process runs from the npx cache and would pin its own old version)\n\n");
  const installArgs = ["install", "all", "--no-ollama", "--no-stop-hook"];
  if (args.yes || args.staged) installArgs.push("--yes");
  if (args.vaultPath) installArgs.push("--vault", args.vaultPath);
  const r = spawnSync(bin, installArgs, { stdio: "inherit", timeout: 300_000 });
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
function installedVersion(root: string): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" && pkg.version ? pkg.version : VERSION;
  } catch {
    return VERSION;
  }
}

function launchAgentPresent(uid: string): boolean {
  const r = spawnSync("/bin/launchctl", ["print", `gui/${uid}/${LAUNCH_AGENT_LABEL}`], { stdio: "pipe", timeout: 15_000 });
  return r.status === 0;
}

export async function cmdUpdate(args: ParsedArgs): Promise<number> {
  const mode = detectInstallMode();
  if (args.staged) {
    process.stdout.write("→ staged update: swapping files only, no daemon restart\n");
  }
  process.stdout.write(`→ install mode: ${mode.detail}\n`);
  process.stdout.write(`  cli path: ${mode.cliPath}\n\n`);

  // #268 + #226 — the preflight guards the step that replaces an installation
  // IN PLACE, and only npm-global does that (see hasInPlacePreflight below).
  // A source checkout is git-managed (every local change is already tracked and
  // nothing here overwrites it), and the "unknown" branch installs nothing at
  // all — guarding those would mean a dirty tree could veto a re-registration
  // that never touched a single package file.
  const packageRoot = packageRootFromCliPath(mode.cliPath);
  const preflightSupported = hasInPlacePreflight(mode.mode);
  const runsInstaller = mode.mode === "brew" || mode.mode === "npm-global";

  if (args.dryRun) {
    process.stdout.write("(dry-run — describing what would happen, writing nothing)\n\n");
    process.stdout.write(`→ install source: ${mode.mode}\n`);
    process.stdout.write(`  update command: ${mode.updateCommand}\n\n`);
    if (preflightSupported) {
      process.stdout.write("  would: 0) preflight: back up locally modified files, then refuse or proceed\n");
      const pending = activePatches();
      if (pending.length > 0) {
        process.stdout.write(
          `  would: 1a) reapply ${pending.length} registered local patch${pending.length === 1 ? "" : "es"} ` +
            `(#269) — 'bastra patches status' shows what each would do\n`,
        );
      }
    } else if (mode.mode === "brew") {
      process.stdout.write(
        "  would: 0) skip the preflight — Homebrew installs each version into its own\n" +
        "            Cellar directory, so there is no in-place file to modify or back up\n",
      );
    }
    process.stdout.write("  would: 1) run the update command above\n");
    process.stdout.write("         2) re-register every surface (idempotent)\n");
    process.stdout.write(
      args.staged
        ? "         3) leave the daemon running (staged — no restart mid-session)\n"
        : "         3) restart the daemon\n",
    );
    return 0;
  }

  // Runs ONCE, in front of both install branches — two guards that can each veto
  // the same action is how auto-updates die (see update-preflight.ts).
  if (preflightSupported) {
    process.stdout.write(
      `→ preflight: locally modified files${mode.mode === "npm-global" ? " + npm provenance (#226)" : ""}\n`,
    );
    const verdict = await preflight({
      root: packageRoot,
      // --staged is the detached SessionStart path: it cannot ask, so a finding
      // ends it rather than being silently overridden.
      unattended: args.staged === true,
      force: args.force === true,
      // brew and source carry no registry attestation — only npm publishes one.
      checkProvenance: mode.mode === "npm-global",
    });
    const rendered = formatPreflight(verdict);
    // Printed on the way through as well, not only on refusal: a backup nobody
    // was told about is a backup nobody restores from.
    process.stdout.write(rendered ? `${rendered}\n\n` : "  ✓ nothing local to protect\n\n");
    if (!verdict.ok) {
      // #268 — on the staged path this stdout goes to /dev/null (detached,
      // stdio:"ignore") while the SessionStart hook already announced the
      // update as happening. Leave the verdict on disk so the next session
      // reports the refusal instead of repeating that claim. Only unattended:
      // an interactive refusal is being read right now, and recording it would
      // pause the automatic path over a decision the user already saw.
      if (args.staged) await recordBlockedUpdate(verdict, installedVersion(packageRoot));
      process.stdout.write("  Nothing was installed — the current version is untouched.\n");
      return 1;
    }
  } else if (mode.mode === "brew") {
    // Honest note instead of a check that can only ever skip itself.
    process.stdout.write("→ preflight: not applicable to a Homebrew install\n");
    process.stdout.write("  Homebrew never replaces this directory: 'brew upgrade' builds a new keg under\n");
    process.stdout.write("  Cellar/bastra-recall/<version>/ and re-points the symlinks, so a locally modified\n");
    process.stdout.write("  file here is left behind with the old keg rather than overwritten.\n");
    process.stdout.write("  No baseline is recorded either — the path it would be taken from is version-pinned\n");
    process.stdout.write("  and gone from the next version's point of view. Keep local patches outside the keg.\n\n");
  }

  // 1. Update the binary itself
  // Resolved absolute paths + hard timeouts (#91): the staged path runs
  // unattended from the SessionStart hook (detached, stdio:"ignore"), so a
  // bare-name spawn would inherit the stripped GUI PATH (the #79 root cause)
  // and a network-stalled brew/npm would hang unbounded. ETIMEDOUT/ENOENT/
  // signal all surface as failure via run() — never as silent success.
  if (mode.mode === "brew") {
    process.stdout.write(`→ ${mode.updateCommand}\n`);
    if (!args.dryRun) {
      const brewBin = findExecutable("brew");
      if (!brewBin) {
        process.stdout.write("\n✗ brew not found on a trusted PATH — run 'brew upgrade bastra-recall' manually\n");
        return 1;
      }
      const r = run(brewBin, ["upgrade", "bastra-recall"], { timeoutMs: 300_000, showProgress: true });
      if (!r.ok) {
        process.stdout.write(`\n✗ brew upgrade failed (${r.detail}) — fix it manually, then re-run 'bastra update'\n`);
        return 1;
      }
    } else {
      process.stdout.write(`  would run: ${mode.updateCommand}\n`);
    }
    process.stdout.write("\n");
  } else if (mode.mode === "npm-global") {
    process.stdout.write(`→ ${mode.updateCommand}\n`);
    if (!args.dryRun) {
      const npmBin = findExecutable("npm");
      if (!npmBin) {
        process.stdout.write("\n✗ npm not found on a trusted PATH — run 'npm install -g @bastra-recall/daemon@latest' manually\n");
        return 1;
      }
      const r = run(npmBin, ["install", "-g", "@bastra-recall/daemon@latest"], { timeoutMs: 300_000, showProgress: true });
      if (!r.ok) {
        process.stdout.write(`\n✗ npm install failed (${r.detail}) — fix it manually, then re-run 'bastra update'\n`);
        return 1;
      }
    } else {
      process.stdout.write(`  would run: ${mode.updateCommand}\n`);
    }
    process.stdout.write("\n");
  } else if (mode.mode === "source") {
    process.stdout.write("→ source install — rebuild yourself first if you haven't:\n");
    process.stdout.write(`    cd <bastra-recall> && ${mode.updateCommand}\n`);
    process.stdout.write("  Then re-run 'bastra update' to refresh configs + restart the daemon.\n\n");
  } else {
    process.stdout.write("⚠ install mode unknown — install manually from:\n");
    process.stdout.write(`    ${mode.updateCommand}\n\n`);
  }

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
  //     Scoped to the same install modes as the preflight, for the same reason:
  //     a Homebrew upgrade builds a new keg and abandons the old one, so there
  //     is no in-place tree whose patches would have been lost.
  if (preflightSupported && !args.dryRun) {
    const series = activePatches();
    if (series.length > 0) {
      process.stdout.write(`→ reapplying ${series.length} local patch${series.length === 1 ? "" : "es"} (#269)\n`);
      try {
        const outcome = applySeries(packageRoot);
        writeLastRun(outcome);
        process.stdout.write(formatApplyOutcome(outcome));
        if (outcome.setAside.length > 0) {
          process.stdout.write(
            `  Patches set aside stay registered — 'bastra patches status' shows them,\n` +
              `  and the pre-update backup above still holds your files.\n`,
          );
        }
        process.stdout.write("\n");
      } catch (e) {
        // A patch step that throws must never fail an update whose install
        // already succeeded — the new version is on disk and working, only the
        // local additions are missing. Say so and continue.
        process.stdout.write(`  ⚠ patch reapply failed (${(e as Error).message}) — the update itself stands\n\n`);
      }
    }
  }

  // 1b. Baseline for the NEXT update (#268). Without this write the dirty check
  //     above can never say more than "unknown" — this is the step that starts
  //     the chain, so it runs even if the re-registration below fails: the files
  //     on disk are already the new ones. Same scope as the check it feeds:
  //     writing one from a Homebrew keg would pin it to a path the next version
  //     no longer runs from, and every later preflight would skip on
  //     `manifest.root !== opts.root` while claiming a baseline had been taken.
  if (preflightSupported) {
    try {
      const manifest = await buildManifest(packageRoot, installedVersion(packageRoot));
      if (manifest.files.length === 0) {
        // The install root we hashed from is empty — an npm prefix that moved,
        // a partially written install. An empty manifest would read as "clean"
        // on every future update, which is strictly worse than no manifest: that
        // at least reports itself as an unknown.
        process.stdout.write(`  ⚠ no baseline written — ${packageRoot} is empty now (install root moved?)\n\n`);
      } else {
        await writeManifest(manifest);
        process.stdout.write(`  ✓ baseline recorded (${manifest.files.length} files) — the next update can tell local changes apart\n\n`);
      }
    } catch (e) {
      // A baseline that cannot be written must never fail an update that already
      // succeeded; the next preflight just reports "could not check".
      process.stdout.write(`  ⚠ baseline not written (${(e as Error).message}) — the next update reports 'unknown' instead\n\n`);
    }
  }

  // 1c. An installer that ran is the one event that resolves a held-back
  //     automatic update (#268), whatever the recorded reason was. Drop the
  //     record so the next SessionStart stops reporting a block that no longer
  //     stands, and the unattended path is allowed to stage again.
  if (runsInstaller) await clearBlockedUpdate();

  // 2. Re-register every surface (idempotent — refreshes skill content if SKILL.md changed)
  process.stdout.write("→ re-registering with every supported surface (idempotent)\n\n");
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
  if (runsInstaller && isEphemeralInstallPath(mode.cliPath) && !args.dryRun) {
    installRC = reRegisterViaInstalledBinary(args);
    if (installRC === null) {
      // Could not find the freshly installed binary — fall through and register
      // inline. That reproduces the stale pin, so say it instead of letting the
      // run look clean.
      process.stdout.write(
        "  ⚠ could not locate the newly installed 'bastra' — registering from this (old) process.\n" +
          "    The surfaces may stay pinned to the previous version; run 'bastra doctor' afterwards.\n\n",
      );
    }
  }
  if (installRC === null) installRC = await cmdInstall(installArgs);
  if (installRC !== 0) {
    process.stdout.write("✗ re-register failed — fix the surface errors above, then re-run\n");
    return installRC;
  }

  // 3. Daemon restart.
  //    --staged deliberately skips the kickstart: the running daemon keeps the
  //    old code in memory and a current session stays intact. The new code goes
  //    live on the next daemon boot (idle-shutdown after 30 min → forwarder
  //    respawns with the new code), or immediately when the user restarts.
  if (args.staged) {
    process.stdout.write("→ staged — daemon left running on old code (no restart mid-session)\n");
    process.stdout.write("  New code goes live on the next daemon restart:\n");
    process.stdout.write("    · automatically after 30 min idle (forwarder mode — a LaunchAgent daemon stays warm, #78), or\n");
    process.stdout.write("    · now — run 'bastra update' without --staged (kickstarts a LaunchAgent daemon), or restart your AI clients\n");
    return 0;
  }

  // Der Schritt, der bisher fehlte: Ein Update verschiebt die Installation
  // (Homebrew legt jede Version in ein eigenes Verzeichnis), und ein
  // LaunchAgent zeigt auf einen ABSOLUTEN Pfad. Zeigt er noch auf die alte,
  // startet er danach entweder nichts mehr oder weiter den alten Code — genau
  // der gemeldete Fall. Fremde plists bleiben unangetastet.
  await refreshManagedAutostart((s) => process.stdout.write(s));

  process.stdout.write("→ restarting daemon\n");
  const uid = String(process.getuid?.() ?? 0);
  if (launchAgentPresent(uid)) {
    if (args.dryRun) {
      process.stdout.write("  would kickstart LaunchAgent\n\n");
    } else {
      const kick = spawnSync(
        "/bin/launchctl",
        ["kickstart", "-k", `gui/${uid}/${LAUNCH_AGENT_LABEL}`],
        { stdio: "inherit", timeout: 15_000 },
      );
      if (kick.status === 0) process.stdout.write("  ✓ LaunchAgent kicked — daemon restarted with new code\n\n");
      else process.stdout.write("  ✗ kickstart failed — restart the daemon manually\n\n");
    }
  } else {
    process.stdout.write("  no LaunchAgent registered — running daemon (if any) still holds the old code in memory\n");
    process.stdout.write("  Restart it manually:\n");
    process.stdout.write("    lsof -i :6723             # find the daemon pid\n");
    process.stdout.write("    kill <pid>                 # forwarder respawns it with new code on next call\n\n");
  }

  process.stdout.write("→ done. Restart any open AI clients (Claude Code, Claude Desktop, Codex, ChatGPT Desktop, Cursor) to pick up the new code.\n");
  return 0;
}
