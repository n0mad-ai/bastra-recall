/**
 * The `bastra` command after an npx install (#317).
 *
 * `npx bastra-recall install` runs the guided setup to completion — vault
 * created, clients registered, the runtime pinned under ~/.bastra/runtime
 * (#180) — and then leaves nothing behind that the user can type. `npx`
 * executes a package, it never installs one, so every documented next step
 * (`bastra doctor`, `bastra map`, `bastra import`, `bastra onboard`) answers
 * with "command not found" on a machine that is in fact correctly installed.
 *
 * Fix: at the end of the guided setup, offer the global install ONCE and run
 * it only on an explicit yes — a global install is the user's machine, not
 * ours. Declining is a valid answer, so the decline branch has to leave a
 * working invocation too (`npx bastra-recall <command>`); what must not happen
 * is leaving the setup with no way to reach the CLI at all.
 *
 * Deliberately NOT a launcher shim into ~/.bastra/runtime/<version>/: there is
 * no directory on PATH this tool may write to unasked, and a shim would pin
 * the `bastra` command to one version forever — the stale-pin failure #304
 * exists to surface, reintroduced at the entry point.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, resolve } from "node:path";
import { findExecutable, run } from "./exec.js";
import { VERSION } from "./helpers.js";
import { isEphemeralInstallPath } from "./stable-runtime.js";

/** The npm package carrying the `bastra` bin — the name the README documents. */
export const CLI_PACKAGE = "bastra-recall";

/** Reaching the CLI without a global install. Always available, always works. */
export const NPX_FALLBACK_HINT = `npx ${CLI_PACKAGE} <command>   (e.g. npx ${CLI_PACKAGE} doctor)`;

/** Printed when the user says no — the setup must not end without a usable CLI. */
export const CLI_DECLINED_NOTE =
  `No 'bastra' command was installed — this run came from the npx cache.\n` +
  `  Run commands with: ${NPX_FALLBACK_HINT}\n` +
  `  Install it anytime: npm install -g ${CLI_PACKAGE}`;

export type CliOnPathVerdict = "permanent" | "already-on-path" | "offer";

/**
 * Pure decision — exported for tests. Only an npx run can end without a CLI,
 * and only when PATH has no permanent `bastra` already.
 *
 * The PATH hit is checked against isEphemeralInstallPath for the reason
 * update.ts documents: inside an npx run the cache's own node_modules/.bin
 * sits on PATH, so a name lookup resolves straight back to the process asking
 * the question. That hit proves nothing about tomorrow — npm evicts the cache.
 */
export function decideCliOnPath(i: { cliPath: string; resolvedBastra: string | null }): CliOnPathVerdict {
  if (!isEphemeralInstallPath(i.cliPath)) return "permanent";
  if (i.resolvedBastra && !isEphemeralInstallPath(i.resolvedBastra)) return "already-on-path";
  return "offer";
}

export interface GlobalInstallOutcome {
  ok: boolean;
  /** Absolute path of the installed bin, when it could be located afterwards. */
  binPath?: string;
  /** True when binPath's directory is not on this shell's PATH. */
  offPath?: boolean;
  detail: string;
}

/**
 * Is the directory holding this bin on PATH? Exported for tests.
 *
 * `npm install -g` reports success into whatever prefix it is configured with,
 * and that prefix is not always searched by the user's shell (a custom prefix,
 * an nvm version dir that is not the active one). Without this check the setup
 * would end with a confident "installed" and the user still typing `bastra`
 * into a command-not-found — #317 again, one layer down.
 */
export function binDirOnPath(binPath: string, pathEnv: string = process.env.PATH ?? ""): boolean {
  const dir = dirname(binPath);
  return pathEnv
    .split(delimiter)
    .filter(Boolean)
    .some((d) => {
      try {
        return resolve(d) === dir;
      } catch {
        return false;
      }
    });
}

/**
 * `<npm prefix -g>/bin/bastra`, or null when npm cannot say / the bin is not
 * there. `npm prefix -g` rather than findExecutable("bastra"): PATH inside an
 * npx run still prefers the cache's own bin, so a name lookup would report the
 * old process as the freshly installed one (same trap as update.ts's hand-off).
 */
function globalBinPath(npmBin: string): string | null {
  const prefix = spawnSync(npmBin, ["prefix", "-g"], { encoding: "utf8", timeout: 30_000 });
  const root = `${prefix.stdout ?? ""}`.trim();
  if (prefix.status !== 0 || !root) return null;
  const bin = resolve(root, "bin", "bastra");
  return existsSync(bin) ? bin : null;
}

/**
 * Runs `npm install -g bastra-recall@<VERSION>` and reports where the bin
 * landed. Never called without an explicit yes from the caller.
 *
 * Pinned to VERSION, never @latest: the registrations this same install just
 * wrote point at ~/.bastra/runtime/<VERSION>/, so a newer global CLI would
 * report every surface as a STALE PIN (#304) the first time `bastra doctor`
 * runs — a setup that ends by breaking its own health check.
 */
export function installCliGlobally(): GlobalInstallOutcome {
  const npmBin = findExecutable("npm");
  if (!npmBin) return { ok: false, detail: "npm not found on a trusted PATH" };
  const r = run(npmBin, ["install", "-g", `${CLI_PACKAGE}@${VERSION}`], {
    timeoutMs: 300_000,
    // npm streams its own progress — a spinner over it would hide the output
    // of the one step that most often needs reading (registry/permission errors).
    showProgress: true,
  });
  if (!r.ok) return { ok: false, detail: r.detail };
  const bin = globalBinPath(npmBin);
  if (!bin) return { ok: true, detail: "installed" };
  return { ok: true, binPath: bin, offPath: !binDirOnPath(bin), detail: "installed" };
}

export interface CliOutcomeLine {
  level: "success" | "warn";
  text: string;
}

/**
 * The user-facing line for an attempted global install — pure, exported for
 * tests. Only the case where the bin is verifiably reachable is a success;
 * every other shape names the npx fallback, because a setup that overstates
 * this is exactly how #317 stayed invisible.
 */
export function formatGlobalInstallOutcome(out: GlobalInstallOutcome): CliOutcomeLine {
  if (!out.ok) {
    return {
      level: "warn",
      text:
        `Could not install the 'bastra' command (${out.detail}).\n` +
        `  Run commands with: ${NPX_FALLBACK_HINT}\n` +
        `  Or install it later: npm install -g ${CLI_PACKAGE}`,
    };
  }
  if (!out.binPath) {
    return {
      level: "warn",
      text:
        `npm reported success but the 'bastra' bin could not be located.\n` +
        `  If 'bastra doctor' says command not found, use: ${NPX_FALLBACK_HINT}`,
    };
  }
  if (out.offPath) {
    return {
      level: "warn",
      text:
        `Installed to ${out.binPath}, but ${dirname(out.binPath)} is not on your PATH.\n` +
        `  Add that directory to PATH, or run commands with: ${NPX_FALLBACK_HINT}`,
    };
  }
  return { level: "success", text: `'bastra' is on your PATH now (${out.binPath}) — next: bastra doctor` };
}
