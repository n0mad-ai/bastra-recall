/**
 * `bastra code` — code awareness per repository (#573, #574).
 *
 * Five subcommands, all of them explicit acts by the user:
 *
 *   status    what is enabled, which binary, which graph, how fresh  (default)
 *   enable    turn it on for a repository and build the graph once
 *   disable   turn it off; files stay where they are
 *   index     rebuild the graph for a repository, incrementally
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
import { relative } from "node:path";
import { buildCodeGraph, scanFileState } from "../code-graph/build.js";
import { gitPath, isGitRepo } from "../code-graph/git-paths.js";
import { graphDirOf, graphFileOf, GRAPH_DIR_NAME } from "../code-graph/reader.js";
import { isStale, readManifest } from "../code-graph/manifest.js";
import { enabledRepos, isRepoEnabled, setRepoEnabled } from "../code-graph/enabled-repos.js";
import { GRAPHIFY_PIN, probeTool } from "../code-graph/graphify-tool.js";
import { confirm } from "./prompt.js";

const out = (s: string): void => void process.stdout.write(s);

export async function cmdCode(opts: {
  sub: string | null;
  positional?: string[];
  yes?: boolean;
}): Promise<number> {
  const sub = opts.sub ?? "status";
  // `bastra code enable <dir>` — positional[2] is the first argument after
  // the command and subcommand.
  const dir = opts.positional?.[2] ?? process.cwd();

  switch (sub) {
    case "status":
      return await cmdStatus();
    case "enable":
      return await cmdEnable(dir);
    case "disable":
      return await cmdDisable(dir);
    case "index":
      return await cmdIndex(dir, false, opts.yes === true);
    case "rebuild":
      return await cmdIndex(dir, true, opts.yes === true);
    default:
      out(`unknown subcommand '${sub}' — try: status, enable, disable, index, rebuild\n`);
      return 1;
  }
}

async function cmdStatus(): Promise<number> {
  const tool = await probeTool();
  out("→ graphify\n");
  if (tool.usable !== null) {
    out(`  ✓ ${tool.usable.version} (pinned ${GRAPHIFY_PIN})\n`);
    out(`  path: ${tool.usable.path}\n`);
  } else {
    out(`  ✗ unavailable: ${reasonWording(tool.reason)}\n`);
  }
  if (tool.external !== null) {
    // Reported, never touched (#573).
    out(`  note: you have your own Graphify at ${tool.external.path}`);
    out(tool.external.version !== null ? ` (${tool.external.version})` : "");
    out(" — Recall leaves it alone and uses its own pinned copy\n");
  }

  const repos = await enabledRepos();
  out("\n→ repositories\n");
  if (repos.length === 0) {
    out("  none enabled — run 'bastra code enable' inside a repository\n");
    return 0;
  }
  for (const repo of repos) {
    out(`  ${repo}\n`);
    const manifest = await readManifest(graphDirOf(repo));
    if (manifest === null) {
      out("    no graph yet — run 'bastra code index'\n");
      continue;
    }
    const size = await graphSizeMB(repo);
    const state = await scanFileState(repo).catch(() => null);
    const stale = isStale(manifest, state?.newestMtimeMs ?? 0);
    out(`    built: ${manifest.builtAt ?? "never"}${stale ? "  (may be outdated)" : ""}\n`);
    out(`    graphify ${manifest.graphifyVersion}, ${manifest.fileState.count} files`);
    out(size === null ? "\n" : `, ${size} MB\n`);
    if (manifest.lastError !== null) out(`    last error: ${manifest.lastError}\n`);
    if (manifest.dirty) out("    a build did not finish — it will be retried\n");
  }
  return 0;
}

async function cmdEnable(dir: string): Promise<number> {
  const tool = await probeTool();
  if (tool.usable === null) {
    out(`✗ code awareness unavailable: ${reasonWording(tool.reason)}\n`);
    if (tool.reason === "not-installed") {
      out(`  run 'bastra install' and say yes to code awareness, which installs graphifyy==${GRAPHIFY_PIN}\n`);
    }
    return 1;
  }

  const changed = await setRepoEnabled(dir, true);
  out(changed ? `✓ code awareness enabled for ${dir}\n` : `code awareness was already enabled for ${dir}\n`);
  await ensureExcluded(dir);
  return await cmdIndex(dir, false, true);
}

async function cmdDisable(dir: string): Promise<number> {
  const changed = await setRepoEnabled(dir, false);
  if (!changed) {
    out(`code awareness was not enabled for ${dir}\n`);
    return 0;
  }
  // Files stay: deleting them as a side effect of a settings change is not
  // what the user asked for, and re-enabling would cost a full rebuild.
  out(`✓ code awareness disabled for ${dir}\n`);
  if (existsSync(graphDirOf(dir))) {
    out(`  the graph is kept at ${graphDirOf(dir)} — delete it yourself if you want it gone\n`);
  }
  return 0;
}

async function cmdIndex(dir: string, rebuild: boolean, yes: boolean): Promise<number> {
  if (!(await isRepoEnabled(dir))) {
    out(`${dir} is not enabled — run 'bastra code enable' first\n`);
    return 1;
  }

  if (rebuild && !yes) {
    // --force overrides Graphify's own refusal to replace a good graph with a
    // smaller one. Naming what it overrides is the point of the question.
    const ok = await confirm(
      "Rebuild with --force? This overrides Graphify's refusal to replace a larger graph with a smaller one.",
      { defaultYes: false },
    );
    if (!ok) {
      out("cancelled — nothing was changed\n");
      return 1;
    }
  }

  out(rebuild ? "rebuilding (forced)…\n" : "indexing…\n");
  const started = Date.now();
  const result = await buildCodeGraph({ repoRoot: dir, rebuild });
  const secs = ((Date.now() - started) / 1000).toFixed(2);

  if (!result.ok) {
    out(`✗ build failed after ${secs}s (${result.reason}): ${result.detail}\n`);
    // Graphify replaces the graph atomically, so a failed run never leaves a
    // half-written one behind.
    out("  the previous graph is untouched\n");
    return 1;
  }
  if (result.tookOverLock) {
    out("  note: took over a lock left by a daemon that died mid-build\n");
  }
  const size = await graphSizeMB(dir);
  out(`✓ indexed in ${secs}s${size === null ? "" : ` (${size} MB)`}\n`);
  return 0;
}

/**
 * Make sure the graph directory is ignored, without touching a file git
 * tracks. `.gitignore` is the project's; `.git/info/exclude` is this
 * checkout's, and it never shows up as a change.
 */
async function ensureExcluded(repoRoot: string): Promise<void> {
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
    out(`  added ${entry} to ${relative(repoRoot, exclude) || exclude}\n`);
  } catch {
    out(`  could not write the exclude file — add ${entry} to .gitignore yourself\n`);
  }
}

async function graphSizeMB(repoRoot: string): Promise<string | null> {
  try {
    return ((await stat(graphFileOf(repoRoot))).size / 1024 / 1024).toFixed(1);
  } catch {
    return null;
  }
}

function reasonWording(reason: string): string {
  switch (reason) {
    case "not-installed":
      return "Graphify is not installed for Recall";
    case "version-mismatch":
      return `the installed Graphify is not the pinned ${GRAPHIFY_PIN}`;
    case "unsupported-platform":
      return "this platform is not supported yet (macOS and Linux only)";
    case "unreadable":
      return "the Graphify binary did not report a version";
    default:
      return reason;
  }
}
