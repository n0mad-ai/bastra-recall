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
 * ── The counter-review finding, and why mtimes are not enough ────────────────
 *
 * The first version compared mtimes only: a `dist` newer than the newest `.ts`
 * counted as current, and the closing line then named HEAD as what went live.
 * A timestamp says WHEN output was written, never WHICH sources wrote it.
 * Three ordinary situations passed that check while the build belonged to some
 * other revision:
 *
 *   1. `dist` copied in from another checkout — newer than everything here.
 *   2. the checkout moved to a different revision afterwards; if the two
 *      revisions differ outside `packages/*​/src` (a test, a script, a doc) no
 *      source mtime moves at all.
 *   3. `touch dist/**` on a stale build — one command, and it reads as fresh.
 *
 * So the build states its own revision instead: every package build ends in
 * `scripts/write-build-revision.mjs`, which writes `dist/.build-revision` with
 * the commit it was produced from (see build-stamp.ts). The check compares that
 * against HEAD. mtimes stay as the cheap first pass — they still catch the
 * ordinary "pulled and forgot to build" — but the revision is what decides.
 *
 * A build without a stamp is REFUSED rather than accepted on its timestamps:
 * that is the pre-#528 state of the world, and letting it through would keep
 * every bypass above alive for exactly the builds that carry no proof.
 *
 * ── A dirty worktree ─────────────────────────────────────────────────────────
 *
 * A build from HEAD plus uncommitted changes is not a build from HEAD, and it
 * is not refused either. Refusing would break the one workflow source mode
 * exists for — edit, build, `bastra update` — over a state that is honest work
 * in progress, and the sources on disk really are what produced this build.
 * What it must not do is CLAIM a revision: the reason is `dirty`, the update
 * proceeds, and every line about it says "HEAD <rev> plus uncommitted changes",
 * never "verified HEAD <rev>". Proof is reserved for the case that can be
 * proved.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { readBuildStamp, type BuildStamp } from "../build-stamp.js";

export type SourceBuildReason =
  | "current"
  | "dirty"
  | "unbuilt"
  | "stale"
  | "unstamped"
  | "mismatch"
  | "unverifiable"
  | "unknown";

/** HEAD as git reports it right now. */
export interface HeadState {
  /** Full commit sha. */
  revision: string;
  /** Does the worktree differ from that commit (tracked or untracked)? */
  dirty: boolean;
}

export interface SourceBuildState {
  /** May the update proceed to re-registration and restart? */
  ok: boolean;
  reason: SourceBuildReason;
  /** Short HEAD of the checkout, for messages; null when git could not be asked. */
  revision: string | null;
  /** Full HEAD sha, or null when git could not be asked. */
  headRevision: string | null;
  /** Full sha the build stamped itself with, or null when it carries no stamp. */
  builtRevision: string | null;
  /** Worktree dirty right now; null when git could not be asked. */
  dirty: boolean | null;
  /** Newest `.ts` under the workspace `src` dirs, epoch ms. */
  newestSourceMs: number | null;
  /** Newest build output, epoch ms; null when a package has no `dist` at all. */
  newestBuildMs: number | null;
}

/** First 7 of a sha, which is what the rest of the CLI shows. */
export function shortRevision(full: string | null): string | null {
  return full === null ? null : full.slice(0, 7);
}

/**
 * The full sha this state PROVES is built and about to be re-registered, or
 * null when nothing is proved. Only `current` proves anything: `dirty` is a
 * build of sources that are not any commit, and every refusing reason speaks
 * for itself. Full rather than short, because it is compared against what the
 * daemon reports, not printed.
 */
export function provenRevision(s: SourceBuildState): string | null {
  return s.reason === "current" ? s.headRevision : null;
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
  head: HeadState | null;
  built: BuildStamp | null;
}): SourceBuildState {
  const base = {
    revision: shortRevision(i.head?.revision ?? null),
    headRevision: i.head?.revision ?? null,
    builtRevision: i.built?.revision ?? null,
    dirty: i.head?.dirty ?? null,
    newestSourceMs: i.newestSourceMs,
    newestBuildMs: i.newestBuildMs,
  };
  if (i.newestSourceMs === null) return { ...base, ok: true, reason: "unknown" };
  if (i.newestBuildMs === null) return { ...base, ok: false, reason: "unbuilt" };
  if (i.newestBuildMs < i.newestSourceMs) return { ...base, ok: false, reason: "stale" };
  // From here the timestamps agree — which is exactly where the three bypasses
  // above used to end, with "current".
  if (i.built === null) return { ...base, ok: false, reason: "unstamped" };
  if (i.head === null) return { ...base, ok: false, reason: "unverifiable" };
  if (i.built.revision !== i.head.revision) return { ...base, ok: false, reason: "mismatch" };
  // Built from HEAD, but from a tree that was not (or is no longer) HEAD alone.
  if (i.built.dirty || i.head.dirty) return { ...base, ok: true, reason: "dirty" };
  return { ...base, ok: true, reason: "current" };
}

/** What the user is told, and what to do about it. `rebuild` is the manual command. */
export function describeSourceBuild(s: SourceBuildState, rebuild: string): string {
  const rev = s.revision ? ` (HEAD ${s.revision})` : "";
  const built = shortRevision(s.builtRevision) ?? "unknown";
  const buildFirst =
    `    Build it first, then re-run 'bastra update':\n      ${rebuild}\n`;
  switch (s.reason) {
    case "current":
      return `  ✓ the build in this checkout was produced from HEAD ${s.revision}\n`;
    case "dirty":
      return (
        `  ✓ the build in this checkout was produced from HEAD ${s.revision} plus uncommitted changes\n` +
        `    That build is what will be re-registered — but it is not any commit,\n` +
        `    so this command will not claim a verified revision for it.\n`
      );
    case "unknown":
      return "  ⚠ no workspace sources found here — the build could not be verified\n";
    case "unbuilt":
      return (
        `  ✗ this checkout${rev} has no build output — nothing to re-register.\n` + buildFirst
      );
    case "stale":
      return (
        `  ✗ the build in this checkout${rev} is older than its sources` +
        `${s.newestSourceMs !== null && s.newestBuildMs !== null ? ` (built ${new Date(s.newestBuildMs).toISOString()}, newest source ${new Date(s.newestSourceMs).toISOString()})` : ""}.\n` +
        `    Re-registering now would pin every surface to the OLD code.\n` +
        buildFirst
      );
    case "unstamped":
      return (
        `  ✗ the build in this checkout${rev} does not say which revision it came from.\n` +
        `    Its timestamps look current, and a timestamp proves nothing: output copied\n` +
        `    from another checkout, or simply touched, looks exactly the same (#528).\n` +
        buildFirst
      );
    case "mismatch":
      return (
        `  ✗ the build in this checkout was produced from ${built}, not from HEAD ${s.revision}.\n` +
        `    Re-registering now would pin every surface to that OTHER revision.\n` +
        buildFirst
      );
    case "unverifiable":
      return (
        `  ✗ git could not be asked for HEAD, so the built revision (${built}) cannot be checked.\n` +
        `    Put git on PATH and re-run 'bastra update'.\n`
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
 * Does this package produce a build at all? `packages/eval` carries `src` and
 * runs straight from tsx; demanding a `dist` from it would report every
 * checkout in the repo as unbuilt.
 */
function buildsOutput(packageRoot: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    return typeof pkg.scripts?.build === "string";
  } catch {
    return false;
  }
}

/**
 * Reads the checkout: every `packages/<p>` that declares a `build` script and
 * has sources must have a `packages/<p>/dist` that is not older than them AND
 * stamped with HEAD. A package with sources but no dist makes the whole
 * checkout `unbuilt` — that is the pulled-but-never-built case.
 */
export function inspectSourceBuild(repoRoot: string, gitBin: string | null = "git"): SourceBuildState {
  let packages: Dirent[] = [];
  try {
    packages = readdirSync(join(repoRoot, "packages"), { withFileTypes: true });
  } catch {
    /* no packages/ dir — handled as "no sources" below */
  }
  const head = headState(repoRoot, gitBin);
  let anySource = false;
  let newestSourceMs = 0;
  let newestBuildMs = 0;
  // The comparison is PER PACKAGE: a change in the daemon does not make core's
  // dist stale, and reporting it as such would refuse updates nobody can fix.
  let offender: { src: number; built: number } | null = null;
  // One entry per built package; `null` means that package carries no stamp.
  const stamps: (BuildStamp | null)[] = [];
  for (const p of packages) {
    if (!p.isDirectory()) continue;
    const packageRoot = join(repoRoot, "packages", p.name);
    const src = join(packageRoot, "src");
    if (!existsSync(src) || !buildsOutput(packageRoot)) continue;
    const s = newestBelow(src, ".ts");
    if (s === 0) continue;
    anySource = true;
    newestSourceMs = Math.max(newestSourceMs, s);
    const dist = join(packageRoot, "dist");
    const built = existsSync(dist) ? newestBelow(dist, ".js") : 0;
    // One package with sources and no build output at all: the pulled-but-never-
    // built case. Nothing further needs measuring.
    if (built === 0) {
      return decideSourceBuild({ newestSourceMs: s, newestBuildMs: null, head, built: null });
    }
    newestBuildMs = Math.max(newestBuildMs, built);
    if (built < s && (offender === null || s - built > offender.src - offender.built)) {
      offender = { src: s, built };
    }
    stamps.push(readBuildStamp(dist));
  }
  if (!anySource) {
    return decideSourceBuild({ newestSourceMs: null, newestBuildMs: null, head, built: null });
  }
  // The weakest evidence decides: one unstamped package makes the checkout
  // unstamped, and one package built elsewhere makes it a mismatch — reporting
  // the agreeing sibling instead would hide exactly the package that is wrong.
  const built = stamps.some((s) => s === null)
    ? null
    : (head !== null ? stamps.find((s) => s?.revision !== head.revision) : undefined) ?? stamps[0] ?? null;
  return offender
    ? decideSourceBuild({ newestSourceMs: offender.src, newestBuildMs: offender.built, head, built })
    : decideSourceBuild({ newestSourceMs, newestBuildMs, head, built });
}

/** One git call, trimmed; null when git is absent or the call fails. */
function git(gitBin: string | null, repoRoot: string, args: string[]): string | null {
  if (!gitBin) return null;
  const r = spawnSync(gitBin, ["-C", repoRoot, ...args], { encoding: "utf8", timeout: 15_000 });
  if (r.status !== 0) return null;
  return `${r.stdout ?? ""}`.trim();
}

/**
 * HEAD and whether the worktree still matches it. Null when git cannot be
 * asked at all — the caller then has no revision to compare against and says
 * so instead of falling back to timestamps.
 *
 * A failing `status` is NOT read as clean: "I could not tell" and "nothing
 * changed" are different answers, and only one of them may be called proof.
 */
export function headState(repoRoot: string, gitBin: string | null = "git"): HeadState | null {
  const revision = git(gitBin, repoRoot, ["rev-parse", "HEAD"]);
  if (!revision) return null;
  const status = git(gitBin, repoRoot, ["status", "--porcelain"]);
  return { revision, dirty: status === null || status !== "" };
}
