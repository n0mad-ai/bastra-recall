/**
 * Locating, pinning and version-checking the Graphify binary (#573).
 *
 * Graphify is an optional third-party companion, not a Recall component. Three
 * rules come out of the evaluation on 2026-09-17 and the pre-build
 * counter-review, and they are the whole reason this module exists rather than
 * a bare `spawn("graphify")`.
 *
 * RECALL OWNS ITS OWN COPY. The install goes into a Bastra-scoped uv tool
 * directory and every call uses the resulting ABSOLUTE path. A Graphify the
 * user installed themselves is detected and reported, and then left completely
 * alone — never upgraded, downgraded, modified or removed. Recall has no
 * business changing a tool it did not install, and the counter-review flagged
 * exactly this collision risk.
 *
 * THE VERSION IS PINNED HARD. Graphify shipped six releases in the six days
 * before the pin was chosen, and it has relicensed once (MIT -> Apache-2.0).
 * A floating version would mean the format this daemon parses, and the license
 * we tell users about, could both change under us without a commit. So the pin
 * is a constant here, a new version is an explicit bump, and a binary that
 * reports something else is refused rather than trusted.
 *
 * NEVER ITS INSTALLERS. `graphify install`, `claude install`, `codex install`
 * and `hook install` append to the global ~/.claude/CLAUDE.md, register a
 * competing skill, and add PreToolUse hooks that print a MANDATORY block on
 * every Read and Grep with no dedupe — the context-runaway pattern Recall
 * already had to fix in its own reflex layer. Recall calls exactly one
 * subcommand family: `extract`, and `--version`.
 */

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { access, constants } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * The pinned Graphify release. Verified on PyPI 2026-09-17: 0.9.63 is current
 * and Apache-2.0. Bumping this is a deliberate act — re-check the license, the
 * graph format and the relation set (see limits.ts) when you do.
 */
export const GRAPHIFY_PIN = "0.9.63";

/** PyPI distribution name. Note the double y — the CLI is `graphify`. */
export const GRAPHIFY_PACKAGE = "graphifyy";

/** Recall's own uv tool directory. Never the user's default one. */
export function bastraToolDir(home: string = homedir()): string {
  return join(home, ".bastra", "tools");
}

/** Absolute path of the binary Recall installed, whether or not it exists. */
export function bastraGraphifyPath(home: string = homedir()): string {
  return join(bastraToolDir(home), "bin", "graphify");
}

/**
 * The environment every Graphify call runs under.
 *
 * `GRAPHIFY_QUERY_LOG_DISABLE` because Graphify otherwise writes every query
 * to ~/.cache/graphify-queries.log — a second, unmanaged record of what the
 * user searched for, outside Recall's own retention rules.
 *
 * `PYTHONHASHSEED` because community numbering depends on hash order, and a
 * graph whose community ids move between builds makes every stored reference
 * to them meaningless.
 */
export function graphifyEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, GRAPHIFY_QUERY_LOG_DISABLE: "1", PYTHONHASHSEED: "0" };
}

export type ToolOrigin = "bastra" | "external";

export interface ToolProbe {
  origin: ToolOrigin;
  path: string;
  /** Version the binary reports, or null when it could not be asked. */
  version: string | null;
  /** True only when the version matches the pin exactly. */
  pinned: boolean;
}

export interface ToolStatus {
  /** The binary Recall will actually use, or null when the feature is off. */
  usable: ToolProbe | null;
  /** A Graphify the user installed themselves. Reported, never touched. */
  external: ToolProbe | null;
  /** Why the feature is unavailable, for `bastra doctor`. */
  reason: "ok" | "not-installed" | "version-mismatch" | "unreadable" | "unsupported-platform";
}

/**
 * Ask a binary for its version. Returns null rather than throwing: a missing
 * or broken Graphify turns the feature off, it never breaks a Recall command.
 *
 * `execFile`, not a shell: the path comes from disk and a shell would give a
 * crafted directory name a way to run.
 */
export async function probeVersion(binPath: string): Promise<string | null> {
  try {
    const { stdout } = await run(binPath, ["--version"], {
      env: graphifyEnv(),
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    // Reports e.g. "graphify 0.9.63".
    const m = /(\d+\.\d+\.\d+)/.exec(stdout);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Is this platform in scope for the current sub-release? (C-094) */
export function platformSupported(platform: NodeJS.Platform = process.platform): boolean {
  // Windows is deliberately out until locking, git path resolution, worktrees
  // and process termination are covered by Windows CI. Reporting the feature
  // as unavailable is honest; shipping it half-working is not.
  return platform === "darwin" || platform === "linux";
}

/**
 * What Recall will use, and what it found lying around.
 *
 * `lookupExternal` is injected so the probe stays testable without a PATH
 * search; in production it is `whichGraphify`.
 */
export async function probeTool(options: {
  home?: string;
  platform?: NodeJS.Platform;
  lookupExternal?: () => Promise<string | null>;
} = {}): Promise<ToolStatus> {
  const platform = options.platform ?? process.platform;
  if (!platformSupported(platform)) {
    return { usable: null, external: null, reason: "unsupported-platform" };
  }

  const external = await probeExternal(options.lookupExternal ?? whichGraphify);
  const ownPath = bastraGraphifyPath(options.home);

  if (!(await isExecutable(ownPath))) {
    return { usable: null, external, reason: "not-installed" };
  }
  const version = await probeVersion(ownPath);
  if (version === null) {
    return { usable: null, external, reason: "unreadable" };
  }
  const pinned = version === GRAPHIFY_PIN;
  const probe: ToolProbe = { origin: "bastra", path: ownPath, version, pinned };
  // A binary that is not the pinned version is refused, not used with a
  // warning: the parser, the relation allowlist and the license statement are
  // all tied to a specific release.
  return pinned
    ? { usable: probe, external, reason: "ok" }
    : { usable: null, external, reason: "version-mismatch" };
}

/**
 * The install command Recall runs, as an argv rather than a string. Exported
 * so a test can assert what it is WITHOUT running it — the acceptance
 * criterion of #573 is that Recall never invokes a Graphify install
 * subcommand, and that is checked here rather than by reading the code.
 */
export function installArgv(home: string = homedir()): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
  return {
    file: "uv",
    args: ["tool", "install", `${GRAPHIFY_PACKAGE}==${GRAPHIFY_PIN}`],
    env: {
      ...graphifyEnv(),
      // Scoped to Bastra, so the user's own uv tools are untouched.
      UV_TOOL_DIR: bastraToolDir(home),
      UV_TOOL_BIN_DIR: join(bastraToolDir(home), "bin"),
    },
  };
}

/**
 * Graphify subcommands Recall must never call, with what each one does to the
 * user's setup. Exported so the guard below and its test share one list.
 */
export const FORBIDDEN_SUBCOMMANDS: ReadonlyMap<string, string> = new Map([
  ["install", "writes a skill and appends to the global ~/.claude/CLAUDE.md"],
  ["claude", "registers MANDATORY PreToolUse hooks on Read/Grep and edits the project CLAUDE.md"],
  ["codex", "writes an AGENTS.md section and a .codex hook"],
  ["hook", "installs git hooks and a merge driver into the user's repository"],
]);

/**
 * Throws if an argv would invoke one of Graphify's own installers. Called on
 * every spawn: a guard that only exists in review is a guard that a later edit
 * removes without anyone noticing.
 */
export function assertNoInstaller(args: readonly string[]): void {
  const first = args[0];
  if (first !== undefined && FORBIDDEN_SUBCOMMANDS.has(first)) {
    throw new Error(
      `refusing to run \`graphify ${first}\`: ${FORBIDDEN_SUBCOMMANDS.get(first)!} (#573)`,
    );
  }
}

async function probeExternal(lookup: () => Promise<string | null>): Promise<ToolProbe | null> {
  const path = await lookup();
  if (path === null) return null;
  const version = await probeVersion(path);
  // Reported so `bastra doctor` can explain the overlap. Recall does not use
  // it and does not change it.
  return { origin: "external", path, version, pinned: version === GRAPHIFY_PIN };
}

/** A Graphify on PATH that Recall did not install, or null. */
async function whichGraphify(): Promise<string | null> {
  try {
    const { stdout } = await run("which", ["graphify"], { timeout: 5_000 });
    const path = stdout.trim();
    return path.length > 0 ? path : null;
  } catch {
    return null;
  }
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
