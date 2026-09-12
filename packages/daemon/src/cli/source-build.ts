/**
 * #528 — does this source checkout's build match its sources?
 *
 * `bastra update` never ran `git pull && npm ci && npm run build` for a source
 * checkout, although `--dry-run` announced exactly that. It printed the command
 * as advice and then re-registered every surface and restarted the daemon from
 * whatever `dist` happened to be there — so following the documented sequence
 * (pull, then `bastra update`) could end with "done" while the pulled revision
 * had never been built, let alone activated.
 *
 * Of the two contracts the issue offers, this is the second: `bastra update`
 * refreshes an ALREADY BUILT checkout and refuses otherwise. The first one —
 * update owns pull/install/build — would have this process replace the code it
 * is itself running from, on a tree that may carry uncommitted work, with a
 * failure mode ("npm ci died halfway") that leaves exactly the half-updated
 * installation the issue is about. Refusing costs the user one command and
 * leaves the checkout untouched; that is the cheaper wrong answer.
 *
 * The comparison is mtime-based, like the core/dist freshness guard the test
 * suite already relies on: every build writes its output, so a `dist` older
 * than the newest `.ts` is a build that has not seen the current source. The
 * git revision is reported alongside so success names what went live.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync, type Dirent } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type SourceBuildReason = "current" | "unbuilt" | "stale" | "unknown";

export interface SourceBuildState {
  /** May the update proceed to re-registration and restart? */
  ok: boolean;
  reason: SourceBuildReason;
  /** Short HEAD of the checkout, or null when git could not be asked. */
  revision: string | null;
  /** Newest `.ts` under the workspace `src` dirs, epoch ms. */
  newestSourceMs: number | null;
  /** Newest build output, epoch ms; null when a package has no `dist` at all. */
  newestBuildMs: number | null;
}

/**
 * Pure verdict, so every state can be tested without a checkout.
 *
 * `unknown` (no sources found — a packed or stripped tree) proceeds: a check
 * that cannot see the sources must not veto an update it knows nothing about.
 */
export function decideSourceBuild(i: {
  newestSourceMs: number | null;
  newestBuildMs: number | null;
  revision: string | null;
}): SourceBuildState {
  const base = { revision: i.revision, newestSourceMs: i.newestSourceMs, newestBuildMs: i.newestBuildMs };
  if (i.newestSourceMs === null) return { ...base, ok: true, reason: "unknown" };
  if (i.newestBuildMs === null) return { ...base, ok: false, reason: "unbuilt" };
  if (i.newestBuildMs < i.newestSourceMs) return { ...base, ok: false, reason: "stale" };
  return { ...base, ok: true, reason: "current" };
}

/** What the user is told, and what to do about it. `rebuild` is the manual command. */
export function describeSourceBuild(s: SourceBuildState, rebuild: string): string {
  const rev = s.revision ? ` (HEAD ${s.revision})` : "";
  switch (s.reason) {
    case "current":
      return `  ✓ the build in this checkout is current${rev}\n`;
    case "unknown":
      return "  ⚠ no workspace sources found here — the build could not be verified\n";
    case "unbuilt":
      return (
        `  ✗ this checkout${rev} has no build output — nothing to re-register.\n` +
        `    Build it first, then re-run 'bastra update':\n      ${rebuild}\n`
      );
    case "stale":
      return (
        `  ✗ the build in this checkout${rev} is older than its sources` +
        `${s.newestSourceMs !== null && s.newestBuildMs !== null ? ` (built ${new Date(s.newestBuildMs).toISOString()}, newest source ${new Date(s.newestSourceMs).toISOString()})` : ""}.\n` +
        `    Re-registering now would pin every surface to the OLD code.\n` +
        `    Build it first, then re-run 'bastra update':\n      ${rebuild}\n`
      );
  }
}

/** Checkout root of `start`: the nearest ancestor holding a `.git` entry. */
export function gitRootFor(start: string): string | null {
  let dir = dirname(start);
  for (let i = 0; i < 12; i++) {
    if (existsSync(resolve(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** Newest mtime of files matching `ext` below `dir`; 0 when there is none. */
function newestBelow(dir: string, ext: string): number {
  let newest = 0;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) newest = Math.max(newest, newestBelow(full, ext));
    else if (e.name.endsWith(ext)) {
      try {
        newest = Math.max(newest, statSync(full).mtimeMs);
      } catch {
        /* raced with a build — the next file decides */
      }
    }
  }
  return newest;
}

/**
 * Reads the checkout: every `packages/<p>/src` is a source dir, and each one
 * must have a `packages/<p>/dist` that is not older than it. A package with
 * sources but no dist makes the whole checkout `unbuilt` — that is the
 * pulled-but-never-built case.
 */
export function inspectSourceBuild(repoRoot: string, gitBin: string | null = "git"): SourceBuildState {
  let packages: Dirent[] = [];
  try {
    packages = readdirSync(join(repoRoot, "packages"), { withFileTypes: true });
  } catch {
    /* no packages/ dir — handled as "no sources" below */
  }
  const revision = headRevision(repoRoot, gitBin);
  let anySource = false;
  let newestSourceMs = 0;
  let newestBuildMs = 0;
  // The comparison is PER PACKAGE: a change in the daemon does not make core's
  // dist stale, and reporting it as such would refuse updates nobody can fix.
  let offender: { src: number; built: number } | null = null;
  for (const p of packages) {
    if (!p.isDirectory()) continue;
    const src = join(repoRoot, "packages", p.name, "src");
    if (!existsSync(src)) continue;
    const s = newestBelow(src, ".ts");
    if (s === 0) continue;
    anySource = true;
    newestSourceMs = Math.max(newestSourceMs, s);
    const dist = join(repoRoot, "packages", p.name, "dist");
    const built = existsSync(dist) ? newestBelow(dist, ".js") : 0;
    // One package with sources and no build output at all: the pulled-but-never-
    // built case. Nothing further needs measuring.
    if (built === 0) return decideSourceBuild({ newestSourceMs: s, newestBuildMs: null, revision });
    newestBuildMs = Math.max(newestBuildMs, built);
    if (built < s && (offender === null || s - built > offender.src - offender.built)) {
      offender = { src: s, built };
    }
  }
  if (!anySource) return decideSourceBuild({ newestSourceMs: null, newestBuildMs: null, revision });
  return offender
    ? decideSourceBuild({ newestSourceMs: offender.src, newestBuildMs: offender.built, revision })
    : decideSourceBuild({ newestSourceMs, newestBuildMs, revision });
}

/** Short HEAD of the checkout, or null when git is absent or the call fails. */
export function headRevision(repoRoot: string, gitBin: string | null = "git"): string | null {
  if (!gitBin) return null;
  const r = spawnSync(gitBin, ["-C", repoRoot, "rev-parse", "--short", "HEAD"], {
    encoding: "utf8",
    timeout: 15_000,
  });
  if (r.status !== 0) return null;
  const out = `${r.stdout ?? ""}`.trim();
  return out === "" ? null : out;
}
