/**
 * `bastra code` — code awareness per repository (#573, #574).
 *
 * Five subcommands, all of them explicit acts by the user:
 *
 *   status    what is enabled, which binary, which graph, how fresh, and
 *             whether the daemon's refresh is paused or stopped      (default)
 *   enable    turn it on for a repository and build the graph once
 *   disable   turn it off; files stay where they are
 *   index     rebuild the graph for a repository, incrementally, and resume
 *             the daemon's automatic refresh if it had paused or stopped
 *   rebuild   the same, with --force — a confirmed repair, never automatic
 *
 * WHY `rebuild` IS ITS OWN SUBCOMMAND. Graphify refuses to replace a good
 * graph with a smaller one, and `--force` overrides that refusal. That refusal
 * is a safety property, not an obstacle: it is what stops a half-finished
 * extraction from destroying a working graph. So `--force` never rides along
 * with an ordinary refresh (C-091) — it needs a subcommand whose name says
 * what it does, and a confirmation that names what it overrides.
 *
 * WHY `enable` ALSO WRITES AN EXCLUDE ENTRY. The graph lives in the project at
 * `graphify-out/`, and a user's repository must not gain an untracked
 * directory that shows up in `git status` and might get committed. The entry
 * goes in `.git/info/exclude`, which is repo-local and never itself a change.
 * If the repository already ignores the directory, nothing is written.
 */

import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { buildCodeGraph, scanFileState } from "../code-graph/build.js";
import { gitPath, isGitRepo, repoRootSync } from "../code-graph/git-paths.js";
import { graphDirOf, graphFileOf, GRAPH_DIR_NAME } from "../code-graph/reader.js";
import { isStale, readManifest } from "../code-graph/manifest.js";
import { enabledRepos, isRepoEnabled, setRepoEnabled } from "../code-graph/enabled-repos.js";
import { coverageMapStatus } from "../code-graph/coverage-map.js";
import { getCoverageMapEnabled } from "../code-graph/coverage-map-settings.js";
import { confirm, isInteractive } from "./prompt.js";
import { findExecutable, run } from "./exec.js";
import { GRAPHIFY_PIN, installArgv, probeTool } from "../code-graph/graphify-tool.js";
import { refreshStatusLines } from "../code-graph/refresh-status.js";
import { fetchRefreshStatus, resumeRefreshIfGivenUp } from "./code-refresh-client.js";
import { codeCmdWordsIn, type CodeCmdWords } from "./code-cmd-words.js";
import { taskCliLanguage } from "./task-cli-words.js";

const out = (s: string): void => void process.stdout.write(s);

export async function cmdCode(opts: { sub: string | null; positional?: string[]; yes?: boolean }): Promise<number> {
  const sub = opts.sub ?? "status";
  // `bastra code enable <dir>` — positional[2] is the first argument after
  // the command and subcommand.
  const given = resolve(opts.positional?.[2] ?? process.cwd());
  // The checkout root, not the directory the command was typed in (#586):
  // the Write/Edit lane and `find_code` look a repository up by its root, so
  // enabling `packages/daemon/` stored a key nothing ever asked for. A linked
  // worktree is its own root on purpose — its own checkout, its own graph.
  const dir = repoRootSync(given) ?? given;
  const language = await taskCliLanguage().catch(() => "en");
  const w = codeCmdWordsIn(language);

  switch (sub) {
    case "status":
      return await cmdStatus(w, language);
    case "enable":
      return await cmdEnable(dir, w);
    case "disable":
      return await cmdDisable(dir, given, w);
    case "index":
      return await cmdIndex(dir, false, opts.yes === true, w);
    case "rebuild":
      return await cmdIndex(dir, true, opts.yes === true, w);
    default:
      out(w.unknownSub(sub));
      return 1;
  }
}

async function cmdStatus(w: CodeCmdWords, language: string): Promise<number> {
  const tool = await probeTool();
  out("→ graphify\n");
  if (tool.usable !== null) {
    out(w.pinned(tool.usable.version, GRAPHIFY_PIN));
    out(w.path(tool.usable.path));
  } else {
    out(w.unavailable(reasonWording(tool.reason, w)));
  }
  if (tool.external !== null) {
    // Reported, never touched (#573).
    out(w.ownGraphify(tool.external.path));
    out(tool.external.version !== null ? ` (${tool.external.version})` : "");
    out(w.ownGraphifyLeft);
  }

  const repos = await enabledRepos();
  out(w.repositories);
  if (repos.length === 0) {
    out(w.noneEnabled);
    return 0;
  }
  // The running daemon's view (#1148): a paused or stopped refresh is state
  // the manifest cannot show. Null without a daemon, and then nothing to add.
  const refresh = await fetchRefreshStatus();
  for (const repo of repos) {
    out(`  ${repo}\n`);
    const manifest = await readManifest(graphDirOf(repo));
    if (manifest === null) {
      out(w.noGraphYet);
      continue;
    }
    const size = await graphSizeMB(repo);
    const state = await scanFileState(repo).catch(() => null);
    const stale = isStale(manifest, state?.newestMtimeMs ?? 0);
    out(w.built(manifest.builtAt, stale));
    out(w.graphFiles(manifest.graphifyVersion, manifest.fileState.count));
    out(size === null ? "\n" : `, ${size} MB\n`);
    if (manifest.lastError !== null) out(w.lastError(manifest.lastError));
    if (manifest.dirty) out(w.unfinished);
    out(w.coverage(await coverageMapStatus(repo, Date.now(), language), await getCoverageMapEnabled()));
    const refreshState = refresh?.get(repo);
    if (refreshState !== undefined)
      for (const line of refreshStatusLines(refreshState, new Date(), language)) out(`    ${line}\n`);
  }
  return 0;
}

async function cmdEnable(dir: string, w: CodeCmdWords): Promise<number> {
  const tool = await probeTool();
  if (tool.usable === null) {
    out(w.enableUnavailable(reasonWording(tool.reason, w)));
    if (tool.reason === "not-installed") {
      out(w.enableInstallHint(GRAPHIFY_PIN));
    }
    return 1;
  }

  const changed = await setRepoEnabled(dir, true);
  out(w.enabled(dir, changed));
  out(w.experimental);
  await ensureExcluded(dir, w);
  return await cmdIndex(dir, false, true, w);
}

async function cmdDisable(dir: string, given: string, w: CodeCmdWords): Promise<number> {
  // Also the literal directory: before #586, enabling from a subdirectory
  // stored that subdirectory, and it must stay possible to switch it off.
  const changed = (await setRepoEnabled(dir, false)) || (given !== dir && (await setRepoEnabled(given, false)));
  if (!changed) {
    out(w.notEnabled(dir));
    return 0;
  }
  // Files stay: deleting them as a side effect of a settings change is not
  // what the user asked for, and re-enabling would cost a full rebuild.
  out(w.disabled(dir));
  if (existsSync(graphDirOf(dir))) {
    out(w.graphKept(graphDirOf(dir)));
  }
  return 0;
}

async function cmdIndex(dir: string, rebuild: boolean, yes: boolean, w: CodeCmdWords): Promise<number> {
  if (!(await isRepoEnabled(dir))) {
    out(w.enableFirst(dir));
    return 1;
  }

  if (rebuild && !yes) {
    // --force overrides Graphify's own refusal to replace a good graph with a
    // smaller one. Naming what it overrides is the point of the question.
    const ok = await confirm(w.confirmForce, { defaultYes: false });
    if (!ok) {
      out(w.cancelled);
      return 1;
    }
  }

  out(w.building(rebuild));
  const started = Date.now();
  const result = await buildCodeGraph({ repoRoot: dir, rebuild });
  const secs = ((Date.now() - started) / 1000).toFixed(2);

  if (!result.ok) {
    out(w.buildFailed(secs, result.reason, result.detail));
    // Graphify replaces the graph atomically, so a failed run never leaves a
    // half-written one behind.
    out(w.previousUntouched);
    return 1;
  }
  if (result.tookOverLock) {
    out(w.tookOverLock);
  }
  const size = await graphSizeMB(dir);
  out(w.indexed(secs, size));
  // The daemon's automatic refresh may be paused on a busy lock or stopped
  // after failed builds (#1148). The user asking is the one signal that clears
  // that, so a running daemon that gave up on this repository is told to resume.
  // A healthy daemon is left alone: a manual request would start a second build
  // on the graph that was just made.
  if (await resumeRefreshIfGivenUp(dir)) {
    out(w.resumes);
  }
  return 0;
}

/**
 * Make sure the graph directory is ignored, without touching a file git
 * tracks. `.gitignore` is the project's; `.git/info/exclude` is this
 * checkout's, and it never shows up as a change.
 */
async function ensureExcluded(repoRoot: string, w: CodeCmdWords): Promise<void> {
  if (!(await isGitRepo(repoRoot))) return;
  const entry = `${GRAPH_DIR_NAME}/`;

  // Already ignored by the project itself? Then leave it alone.
  try {
    const gitignore = await readFile(`${repoRoot}/.gitignore`, "utf8");
    if (gitignore.split(/\r?\n/).some((l) => l.trim() === entry || l.trim() === GRAPH_DIR_NAME)) return;
  } catch {
    /* no .gitignore is not a problem */
  }

  const exclude = await gitPath(repoRoot, "info/exclude");
  if (exclude === null) return;
  try {
    let current = "";
    try {
      current = await readFile(exclude, "utf8");
    } catch {
      await mkdir(exclude.slice(0, exclude.lastIndexOf("/")), { recursive: true });
    }
    if (current.split(/\r?\n/).some((l) => l.trim() === entry)) return;
    const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
    await appendFile(exclude, `${prefix}${entry}\n`, "utf8");
    out(w.excludeAdded(entry, relative(repoRoot, exclude) || exclude));
  } catch {
    out(w.excludeFailed(entry));
  }
}

async function graphSizeMB(repoRoot: string): Promise<string | null> {
  try {
    return ((await stat(graphFileOf(repoRoot))).size / 1024 / 1024).toFixed(1);
  } catch {
    return null;
  }
}

function reasonWording(reason: string, w: CodeCmdWords): string {
  switch (reason) {
    case "not-installed":
      return w.notInstalled;
    case "version-mismatch":
      return w.versionMismatch(GRAPHIFY_PIN);
    case "unsupported-platform":
      return w.unsupportedPlatform;
    case "unreadable":
      return w.unreadable;
    default:
      return reason;
  }
}

/**
 * The one-time question during `bastra install` (#573).
 *
 * Three rules, and all three exist because Graphify is a COMPANION, not a
 * component:
 *
 *   - It never blocks the Recall install. No uv, a declined question, a failed
 *     download — every one of them continues, and Recall works unchanged
 *     without a code graph (§22, C-090 is a release obligation, not a runtime
 *     one).
 *   - It installs the exact pin into Recall's own tool directory, and never
 *     calls a Graphify installer subcommand.
 *   - Silence is not consent. A non-interactive install asks nothing and does
 *     nothing, matching `confirm()`'s own posture on downloads.
 */
export async function installCodeAwarenessStep(args: {
  dryRun: boolean;
  yes: boolean;
  /** language.primary as `bastra install` read it at its entry (#1602). */
  language: string;
}): Promise<void> {
  if (args.dryRun) return;

  const tool = await probeTool();
  if (tool.reason === "unsupported-platform") return; // nothing to offer here yet
  const w = codeCmdWordsIn(args.language);
  if (tool.usable !== null) {
    out(w.alreadyInstalled(tool.usable.version));
    return;
  }

  // `--yes` means "do not ask me", not "install everything optional". An
  // opt-in feature that arrives because someone passed --yes is not opt-in.
  if (!isInteractive() || args.yes) return;

  const accepted = await confirm(w.offer(GRAPHIFY_PIN), { defaultYes: false });
  if (!accepted) {
    out(w.skipped);
    return;
  }

  const uv = findExecutable("uv");
  if (uv === null) {
    // Explained, not failed: the user may not want another toolchain.
    out(w.needsUv);
    return;
  }

  const { args: installArgs, env } = installArgv();
  // `run` wants a fully defined environment; process.env carries optional
  // values, so the undefined ones are dropped rather than cast away.
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...env })) {
    if (typeof v === "string") merged[k] = v;
  }
  out(w.installing(GRAPHIFY_PIN));
  const result = await run(uv, installArgs, { timeoutMs: 5 * 60_000, env: merged });
  if (!result.ok) {
    out(w.installFailed(result.detail));
    return;
  }
  out(w.installed);
}
