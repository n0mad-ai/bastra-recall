/**
 * bastra's git snapshots (#650, same mechanism as the archiving `rm`): a
 * `git` in `shims/` that the bash-pre lane puts first in PATH of a command
 * made only of these acts. It changes HOW each act runs, never WHAT the caller
 * observes afterwards:
 *
 * - `git clean -f…`  → the same paths (`git clean -n` with the same flags)
 *   go through the archiving `rm`; git's own "Removing <path>" lines are
 *   printed. Same end state, the files are in the archive.
 * - `git reset --hard`, `git checkout … -- <paths>`, `git restore …` → what
 *   dies is uncommitted work on tracked files. `git stash create` saves it as
 *   a commit WITHOUT touching the stash list or the worktree, a ref under
 *   `refs/bastra-archive/` pins it, then the act runs unchanged.
 * - `git branch -D`, `git stash drop|clear` → the commit(s) about to lose
 *   their last name are pinned the same way, then the act runs unchanged.
 *
 * Every pin is a manifest line tagged with the tool call; the PostToolUse
 * receipt names the ref and the command that puts it back, and the archive
 * lets the ref go after the user retention. Nothing else is intercepted: any
 * other git invocation runs the real git with the same argv.
 *
 * The act runs under the hook's allow, so the shim refuses — before acting —
 * in a repository that would run its own code on it: a repo-local
 * `core.fsmonitor`, `core.hooksPath` or `filter.*` driver, or a
 * `post-checkout` / `reference-transaction` hook. Its own plumbing runs with
 * fsmonitor off and hooks pointed at /dev/null.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { accessSync, appendFileSync, constants, existsSync, readdirSync, realpathSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { SHIM_DIR, archiveRoot, localIso, runRmShim, type ShimIo } from "./rm-archive.js";

export type GitAct =
  | { kind: "clean" }
  | { kind: "snapshot"; what: "reset --hard" | "checkout --" | "restore"; paths: string[] }
  | { kind: "branch"; names: string[] }
  | { kind: "stash"; refs: string[] | "clear" };

export interface ParsedGit {
  /** `-C <dir>` global options, in order. */
  dirs: string[];
  sub: string;
  rest: string[];
  /** Global options other than `-C` (e.g. `-c key=value`): never intercepted, never allowed. */
  otherGlobals: boolean;
}

/** `git [-C dir]… <sub> <rest…>` from the words after `git`. */
export function parseGit(words: string[]): ParsedGit | null {
  const dirs: string[] = [];
  let otherGlobals = false;
  let i = 0;
  for (; i < words.length && words[i].startsWith("-"); i++) {
    if (words[i] === "-C" && i + 1 < words.length) dirs.push(words[++i]);
    else {
      otherGlobals = true;
      if (/^(?:-c|--git-dir|--work-tree|--namespace|--exec-path|--config-env)$/.test(words[i])) i++;
    }
  }
  if (i >= words.length) return null;
  return { dirs, sub: words[i], rest: words.slice(i + 1), otherGlobals };
}

const shortHas = (rest: string[], ch: string, long?: string): boolean =>
  rest.some((a) => (long !== undefined && a === long) || (/^-[a-zA-Z]+$/.test(a) && a.includes(ch)));

/** The act this invocation is, when it is one the shim makes reversible. */
export function gitAct(p: ParsedGit): GitAct | null {
  const { sub, rest } = p;
  const operands = (from: string[]) => from.filter((a) => !a.startsWith("-"));
  if (sub === "clean") {
    const force = shortHas(rest, "f", "--force");
    const dry = shortHas(rest, "n", "--dry-run");
    const interactive = shortHas(rest, "i", "--interactive");
    return force && !dry && !interactive ? { kind: "clean" } : null;
  }
  if (sub === "reset" && rest.includes("--hard")) return { kind: "snapshot", what: "reset --hard", paths: [] };
  if (sub === "checkout" && rest.includes("--")) {
    return { kind: "snapshot", what: "checkout --", paths: rest.slice(rest.indexOf("--") + 1) };
  }
  if (sub === "restore") {
    const dd = rest.indexOf("--");
    const paths = dd >= 0 ? rest.slice(dd + 1) : operands(rest.filter((a) => !a.startsWith("--source")));
    return { kind: "snapshot", what: "restore", paths };
  }
  if (sub === "branch") {
    const del = rest.includes("-D") || ((rest.includes("-d") || rest.includes("--delete")) && shortHas(rest, "f", "--force"));
    return del ? { kind: "branch", names: operands(rest) } : null;
  }
  if (sub === "stash" && rest[0] === "drop") {
    const refs = operands(rest.slice(1));
    return { kind: "stash", refs: refs.length > 0 ? refs : ["stash@{0}"] };
  }
  if (sub === "stash" && rest[0] === "clear") return { kind: "stash", refs: "clear" };
  return null;
}

/** The git after ours in PATH. */
export function realGit(env: NodeJS.ProcessEnv = process.env): string | null {
  let shims: string;
  try {
    shims = realpathSync(SHIM_DIR);
  } catch {
    shims = SHIM_DIR;
  }
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    try {
      if (realpathSync(dir) === shims) continue;
      const g = join(dir, "git");
      accessSync(g, constants.X_OK);
      return g;
    } catch {
      /* not here */
    }
  }
  return null;
}

const SAFE = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"];

/**
 * Would this repository run its own code during `act`? Repo-local config
 * only: a global `filter.lfs.*` is the user's own install, a local one is
 * whatever was written into .git/config.
 */
function runsRepoCode(git: (args: string[]) => string | null, act: GitAct, cwd: string): string | null {
  // `git clean -n` runs no hook and no filter; our own calls have fsmonitor off.
  if (act.kind === "clean") return null;
  const local = git(["config", "--local", "--get-regexp", "^(core\\.fsmonitor|core\\.hookspath|filter\\..*)$"]);
  if (local) return `repo-local config: ${local.split("\n")[0].split(" ")[0]}`;
  // Not `--git-path hooks`: our own calls point core.hooksPath at /dev/null.
  // A repo-local core.hooksPath was refused above.
  const common = git(["rev-parse", "--git-common-dir"]);
  if (!common) return null;
  const hooksDir = resolve(cwd, common, "hooks");
  const names = act.kind === "snapshot" && act.what === "checkout --" ? ["post-checkout", "reference-transaction"] : ["reference-transaction"];
  let present: string[] = [];
  try {
    present = readdirSync(hooksDir);
  } catch {
    return null;
  }
  for (const n of names) {
    if (!present.includes(n)) continue;
    try {
      accessSync(join(hooksDir, n), constants.X_OK);
      return `hook ${n}`;
    } catch {
      /* not executable: git does not run it */
    }
  }
  return null;
}

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** `git` with the system's behaviour, saving what the act would lose first. */
export function runGitShim(argv: string[], io: ShimIo = {}): number {
  const env = io.env ?? process.env;
  const cwd0 = io.cwd ?? process.cwd();
  const err = io.err ?? ((s: string) => process.stderr.write(s + "\n"));
  const out = io.out ?? ((s: string) => process.stdout.write(s + "\n"));
  const real = realGit(env);
  if (!real) {
    err("bastra: no git found in PATH after bastra's shim — nothing was run");
    return 127;
  }
  const passThrough = (): number => spawnSync(real, argv, { stdio: "inherit", cwd: cwd0, env }).status ?? 1;
  const p = parseGit(argv);
  const act = p && !p.otherGlobals ? gitAct(p) : null;
  if (!p || !act) return passThrough();

  const cwd = p.dirs.reduce((d, x) => resolve(d, x), cwd0);
  const gitEnv = { ...env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" };
  const git = (args: string[]): string | null => {
    try {
      return execFileSync(real, [...SAFE, ...args], { cwd, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }).trimEnd();
    } catch {
      return null;
    }
  };
  const top = git(["rev-parse", "--show-toplevel"]);
  if (top === null) return passThrough(); // not a repository: git says so itself
  const own = runsRepoCode(git, act, cwd);
  if (own) {
    err(
      `bastra: this repository runs its own code on \`git ${p.sub}\` (${own}) — not run under bastra's allow. ` +
        `Ask the user to run it, or BASTRA_GIT_SHIM=0 for the normal permission prompt.`,
    );
    return 1;
  }

  const archive = archiveRoot(env);
  const now = io.now ?? new Date();
  const ts = localIso(now);
  const call = env.BASTRA_RM_CALL ?? "";
  const stamp = `${ts.replace(/[-:]/g, "").replace("T", "-")}-${process.pid}`;
  const pin = (slug: string, sha: string, what: string, restoreArgs: string[]): boolean => {
    // A new ref every time (the empty old value: "must not exist yet") — two
    // stashes dropped by one `clear`, or two acts in one second, never share one.
    let ref = "";
    for (let n = 0; ; n++) {
      if (n > 50) return false;
      ref = `refs/bastra-archive/${slug}/${stamp}-${n}`;
      if (git(["update-ref", ref, sha, ""]) !== null) break;
    }
    const row = { ts, action: "pinned", orig: top, dest: ref, sha, act: what, restore: restoreArgs, kind: "user", cwd, argv, call };
    try {
      appendFileSync(join(archive, "manifest.jsonl"), JSON.stringify(row) + "\n");
    } catch {
      git(["update-ref", "-d", ref, sha]);
      return false;
    }
    return true;
  };
  const refuse = (why: string): number => {
    err(`bastra: ${why} — \`git ${p.sub}\` not run (nothing changed).`);
    return 1;
  };

  if (act.kind === "clean") {
    const quiet = shortHas(p.rest, "q", "--quiet");
    const dryArgs = p.rest.filter((a) => a !== "--quiet").map((a) => (/^-[a-zA-Z]+$/.test(a) ? a.replace(/q/g, "") : a)).filter((a) => a !== "-");
    const listed = git(["-c", "core.quotePath=false", "clean", "-n", ...dryArgs]);
    if (listed === null) return passThrough(); // git's own error, as it would print it
    const paths: string[] = [];
    for (const line of listed.split("\n").filter(Boolean)) {
      if (line.startsWith("Would skip repository ")) continue;
      const m = /^Would remove (.+)$/.exec(line);
      if (!m || m[1].startsWith('"')) return refuse(`cannot read what git clean would remove (${line.slice(0, 80)})`);
      paths.push(m[1]);
    }
    let rc = 0;
    for (const rel of paths) {
      const r = runRmShim(["-rf", "--", rel.replace(/\/$/, "")], { env: { ...env, BASTRA_RM_CALL: call }, cwd, now, err });
      if (r !== 0) rc = 1;
      else if (!quiet) out(`Removing ${rel}`);
    }
    return rc;
  }

  if (act.kind === "snapshot") {
    const sha = git(["stash", "create"]);
    if (sha === null) return refuse("could not save the uncommitted changes first");
    if (sha) {
      const back =
        act.what === "reset --hard" || act.paths.length === 0
          ? ["-C", top, "stash", "apply", "--index", sha]
          : ["-C", cwd, "restore", `--source=${sha}`, "--worktree", "--", ...act.paths];
      if (!pin(act.what === "reset --hard" ? "reset" : act.what === "restore" ? "restore" : "checkout", sha, `git ${act.what}`, back)) {
        return refuse("could not pin the uncommitted changes");
      }
    }
    return passThrough();
  }

  if (act.kind === "branch") {
    for (const name of act.names) {
      const sha = git(["rev-parse", "--verify", "-q", `refs/heads/${name}^{commit}`]);
      if (!sha) continue; // git reports the missing branch itself
      if (!pin(`branch/${name}`, sha, `git branch -D ${name}`, ["-C", top, "branch", name, sha])) return refuse(`could not pin ${name}`);
    }
    return passThrough();
  }

  // stash drop / clear
  const refs = act.refs === "clear" ? (git(["stash", "list", "--format=%gd"]) ?? "").split("\n").filter(Boolean) : act.refs;
  for (const r of refs) {
    const sha = git(["rev-parse", "--verify", "-q", `${r}^{commit}`]);
    if (!sha) continue;
    const msg = git(["log", "-1", "--format=%s", sha]) ?? "bastra-restored stash";
    if (!pin("stash", sha, `git stash ${act.refs === "clear" ? "clear" : "drop"} (${r})`, ["-C", top, "stash", "store", "-m", msg, sha])) {
      return refuse(`could not pin ${r}`);
    }
  }
  return passThrough();
}

/** The restore command of a pinned row, for the receipt (shell-quoted). */
export function restoreCommand(args: string[]): string {
  return `git ${args.map((a) => (/^[\w@%+=:,./{}^-]+$/.test(a) ? a : shq(a))).join(" ")}`;
}

/** Whether a pinned ref still exists (reconcile only lets live ones go). */
export function pinLive(repo: string, ref: string): boolean {
  if (!existsSync(repo)) return false;
  try {
    execFileSync("git", [...SAFE, "-C", repo, "rev-parse", "--verify", "-q", ref], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function unpin(repo: string, ref: string, sha: string): void {
  try {
    execFileSync("git", [...SAFE, "-C", repo, "update-ref", "-d", ref, sha], { stdio: "ignore" });
  } catch {
    /* already gone, or moved: leave it */
  }
}

/** `bastra archive restore <ref|sha>` for a pinned row: runs its restore command. */
export function restorePin(args: string[]): void {
  execFileSync("git", args, { stdio: "inherit" });
}
