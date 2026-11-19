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
 *   `refs/bastra-archive/` pins it, then the act runs unchanged. An untracked
 *   file the act would overwrite (the target tracks that path) is in no
 *   stash: it goes through the archiving `rm` first.
 * - `git branch -D`, `git stash drop|clear` → the commit(s) about to lose
 *   their last name are pinned the same way, then the act runs unchanged.
 *
 * Each act is read with its own short list of flags. A form outside it
 * (`-p`, `--merge`, `--recurse-submodules`, `--pathspec-from-file`, a branch
 * switch written with `--`) is not an act here: the lane keeps its STOP and
 * the shim hands it to the real git untouched.
 *
 * Every pin is a manifest line tagged with the tool call; the PostToolUse
 * receipt names the ref and the command that puts it back, and the archive
 * lets the ref go after the user retention. Nothing else is intercepted: any
 * other git invocation runs the real git with the same argv.
 *
 * The act runs under the hook's allow, so the shim refuses — before acting —
 * in a repository that would run its own code on it: `core.fsmonitor`,
 * `core.hooksPath` or a `filter.*` driver set by the repository (its config,
 * a file that config includes, `config.worktree`) or by the environment; a
 * partial clone (a missing object is fetched through the repository's own
 * remote settings); an executable `post-checkout`, `post-index-change` or
 * `reference-transaction` hook. Its own plumbing runs with fsmonitor off and
 * hooks pointed at /dev/null. It also refuses where the snapshot would not
 * hold what the act discards: submodules with `submodule.recurse` on.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { SHIM_DIR, appendManifest, archiveRoot, localIso, runRmShim, type ShimIo } from "./rm-archive.js";
import { isOffValue } from "./env.js";
import { SAFE } from "./git-archive-pins.js";
import { withoutShims } from "./shim-path.js";

// The pinned refs live in git-archive-pins.ts; re-exported for importers of this module.
export { unpin } from "./git-archive-pins.js";

export type GitAct =
  | { kind: "clean"; /** The same arguments without `-q`, for the dry run. */ dry: string[]; quiet: boolean }
  | {
      kind: "snapshot";
      what: "reset --hard" | "checkout --" | "restore";
      paths: string[];
      /** The tree the act takes its content from; undefined: the index. */
      source?: string;
      /** The act overwrites the index / the worktree in those paths. */
      staged: boolean;
      worktree: boolean;
    }
  | { kind: "branch"; names: string[]; /** `-r`: remote-tracking branches. */ remote: boolean }
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

/** The flags one act may carry. Anything else makes the form unknown. */
interface Grammar {
  /** Short flags without a value; they may be written as one cluster (`-fdx`). */
  shorts: string;
  longs: string[];
  /** Flags with a value: `-e <v>`, `--exclude <v>`, `--exclude=<v>`. */
  valued?: string[];
}

interface Args {
  flags: Set<string>;
  values: Record<string, string>;
  /** Words before `--` that are not flags. */
  operands: string[];
  /** Words after `--`; null without one. */
  after: string[] | null;
  /** Where in the input a flag's value stands, and where `--` does (-1: nowhere). */
  valueAt: Set<number>;
  dashdash: number;
}

function readArgs(rest: string[], g: Grammar): Args | null {
  const r: Args = { flags: new Set(), values: {}, operands: [], after: null, valueAt: new Set(), dashdash: -1 };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--") {
      r.after = rest.slice(i + 1);
      r.dashdash = i;
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq > 0 ? a.slice(0, eq) : a;
      if (g.valued?.includes(name)) {
        if (eq > 0) r.values[name] = a.slice(eq + 1);
        else if (i + 1 < rest.length) (r.valueAt.add(i + 1), (r.values[name] = rest[++i]));
        else return null;
      } else if (eq < 0 && g.longs.includes(a)) r.flags.add(a);
      else return null;
    } else if (a.startsWith("-") && a.length > 1) {
      for (let k = 1; k < a.length; k++) {
        const f = `-${a[k]}`;
        if (g.shorts.includes(a[k])) r.flags.add(f);
        else if (g.valued?.includes(f) && k === a.length - 1 && i + 1 < rest.length)
          (r.valueAt.add(i + 1), (r.values[f] = rest[++i]));
        else return null;
      }
    } else r.operands.push(a);
  }
  return r;
}

const has = (r: Args, ...names: string[]): boolean => names.some((n) => r.flags.has(n));
/** Flags of `checkout <paths>` and `restore` that change neither what runs nor what is lost. */
const PATH_FLAGS = [
  "--quiet",
  "--ours",
  "--theirs",
  "--no-recurse-submodules",
  "--overlay",
  "--no-overlay",
  "--ignore-skip-worktree-bits",
  "--progress",
  "--no-progress",
];

/** The act this invocation is, when it is one the shim makes reversible. */
export function gitAct(p: ParsedGit): GitAct | null {
  const { sub, rest } = p;
  if (sub === "clean") {
    // Not -n (a dry run is no act), not -i (asks on a terminal).
    const r = readArgs(rest, { shorts: "fdxXq", longs: ["--force", "--quiet"], valued: ["-e", "--exclude"] });
    if (!r || !has(r, "-f", "--force")) return null;
    const dry = rest.flatMap((a, i) => {
      if (r.valueAt.has(i) || (r.dashdash >= 0 && i >= r.dashdash) || !a.startsWith("-")) return [a];
      if (a === "--quiet") return [];
      const short = a.startsWith("--") ? a : a.replace(/q/g, "");
      return short === "-" ? [] : [short];
    });
    return { kind: "clean", dry, quiet: has(r, "-q", "--quiet") };
  }
  if (sub === "reset") {
    const r = readArgs(rest, { shorts: "q", longs: ["--hard", "--quiet", "--no-quiet", "--no-recurse-submodules"] });
    if (!r || !has(r, "--hard") || r.operands.length > 1 || (r.after?.length ?? 0) > 0) return null;
    return {
      kind: "snapshot",
      what: "reset --hard",
      paths: [],
      source: r.operands[0] ?? "HEAD",
      staged: true,
      worktree: true,
    };
  }
  if (sub === "checkout") {
    // With `--` and paths after it. `git checkout <branch> --` is a switch.
    const r = readArgs(rest, { shorts: "qf", longs: [...PATH_FLAGS, "--force"] });
    if (!r || !r.after || r.after.length === 0 || r.operands.length > 1) return null;
    const source = r.operands[0];
    return {
      kind: "snapshot",
      what: "checkout --",
      paths: r.after,
      source,
      staged: source !== undefined,
      worktree: true,
    };
  }
  if (sub === "restore") {
    const r = readArgs(rest, {
      shorts: "SWq",
      longs: [...PATH_FLAGS, "--staged", "--worktree", "--ignore-unmerged"],
      valued: ["-s", "--source"],
    });
    if (!r) return null;
    const paths = [...r.operands, ...(r.after ?? [])];
    if (paths.length === 0) return null;
    const staged = has(r, "-S", "--staged");
    const worktree = has(r, "-W", "--worktree") || !staged;
    const source = r.values["-s"] ?? r.values["--source"] ?? (staged ? "HEAD" : undefined);
    // The tree goes into the shim's own `git diff`: never a word git reads as an option.
    if (source?.startsWith("-")) return null;
    return { kind: "snapshot", what: "restore", paths, source, staged, worktree };
  }
  if (sub === "branch") {
    const r = readArgs(rest, { shorts: "dDfqr", longs: ["--delete", "--force", "--quiet", "--remotes"] });
    if (!r) return null;
    const names = [...r.operands, ...(r.after ?? [])];
    const del = has(r, "-D") || (has(r, "-d", "--delete") && has(r, "-f", "--force"));
    return del && names.length > 0 ? { kind: "branch", names, remote: has(r, "-r", "--remotes") } : null;
  }
  if (sub === "stash" && rest[0] === "clear") return rest.length === 1 ? { kind: "stash", refs: "clear" } : null;
  if (sub === "stash" && rest[0] === "drop") {
    const r = readArgs(rest.slice(1), { shorts: "q", longs: ["--quiet"] });
    if (!r || r.after !== null || r.operands.length > 1) return null;
    // `git stash drop 1` is stash@{1}: git reads a bare number that way.
    const ref = r.operands[0] ?? "stash@{0}";
    return { kind: "stash", refs: [/^\d+$/.test(ref) ? `stash@{${ref}}` : ref] };
  }
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

/** Set by the repository or the environment, not by the user's own files. */
const REPO_SCOPES = new Set(["local", "worktree", "command"]);
const FALSE = /^(?:false|no|off|0|)$/i;
const TRUE = /^(?:true|yes|on|1)$/i;

interface Conf {
  scope: string;
  key: string;
  value: string;
}

/** `git config --show-scope -z --list`: `<scope>\0<key>\n<value>\0`, includes followed. */
function parseConfig(listed: string): Conf[] {
  const parts = listed.split("\0");
  const out: Conf[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const nl = parts[i + 1].indexOf("\n");
    out.push({
      scope: parts[i],
      key: (nl < 0 ? parts[i + 1] : parts[i + 1].slice(0, nl)).toLowerCase(),
      value: nl < 0 ? "true" : parts[i + 1].slice(nl + 1),
    });
  }
  return out;
}

interface Plumbing {
  /** Our own call: fsmonitor off, no hooks. null: git failed. */
  git: (args: string[]) => string | null;
  /** The same without trimming, for `-z` output. */
  raw: (args: string[]) => string | null;
  /** Without our `-c`: what the act itself would read. */
  plain: (args: string[]) => string | null;
  /** The blob each file would be stored as (`hash-object`), in order. */
  hash: (files: string[]) => string[] | null;
}

/**
 * Why this act must not run under the allow here, or null. Two reasons: the
 * repository would run its own code on it, or the snapshot would not hold
 * what the act discards.
 *
 * The config is read as the act will read it — every file, includes followed
 * — and each value comes with its scope: `global` and `system` are the user's
 * own install (a global `filter.lfs.*`), `local`, `worktree` and `command`
 * are whatever was written into the repository or the environment.
 */
function refusal(g: Plumbing, act: GitAct, cwd: string, top: string | null): string | null {
  // `git clean -n` runs no hook and no filter; our own calls have fsmonitor off.
  if (act.kind === "clean") return null;
  const listed = g.plain(["config", "--show-scope", "-z", "--list"]);
  if (listed === null) return "its config cannot be read with scopes (git 2.26 or newer)";
  const conf = parseConfig(listed);
  for (const c of conf) {
    if (!REPO_SCOPES.has(c.scope)) continue;
    const runs =
      (c.key === "core.fsmonitor" && !FALSE.test(c.value)) ||
      c.key === "core.hookspath" ||
      c.key.startsWith("filter.") ||
      // A missing object is fetched on checkout, through the remote this config names.
      ((c.key === "extensions.partialclone" || /^remote\..+\.promisor$/.test(c.key)) && !FALSE.test(c.value));
    if (runs) return `runs its own code on the act (repo-local config: ${c.key})`;
  }
  // Not `--git-path hooks`: our own calls point core.hooksPath at /dev/null.
  // A repo-local core.hooksPath was refused above.
  const common = g.git(["rev-parse", "--git-common-dir"]);
  if (common) {
    const hooksDir = resolve(cwd, common, "hooks");
    // What git runs on each: `checkout <paths>` and `restore` end in
    // post-checkout, every write of the index in post-index-change, every
    // ref update in reference-transaction.
    const names =
      act.kind === "snapshot"
        ? ["post-index-change", "reference-transaction", ...(act.what === "reset --hard" ? [] : ["post-checkout"])]
        : ["reference-transaction"];
    let present: string[] = [];
    try {
      present = readdirSync(hooksDir);
    } catch {
      /* no hooks directory */
    }
    for (const n of names) {
      if (!present.includes(n)) continue;
      try {
        accessSync(join(hooksDir, n), constants.X_OK);
        return `runs its own code on the act (hook ${n})`;
      } catch {
        /* not executable: git does not run it */
      }
    }
  }
  // With submodule.recurse the act also discards what is uncommitted inside
  // each submodule, under that submodule's own config. The snapshot holds the
  // superproject only.
  if (act.kind === "snapshot" && act.worktree) {
    const recurse = conf.filter((c) => c.key === "submodule.recurse").pop();
    if (recurse && TRUE.test(recurse.value) && conf.some((c) => /^submodule\..+\.url$/.test(c.key))) {
      return "has submodules and submodule.recurse is on: the act would also discard changes inside them, which the snapshot does not hold";
    }
  }
  // An entry marked assume-unchanged or skip-worktree: git stash does not
  // look at the file, and the act may overwrite it (reset and checkout do
  // for the first, a checkout from a tree for both). A sparse checkout marks
  // what is not on disk the same way; only a file that is there counts.
  if (act.kind === "snapshot" && top !== null) {
    const listed = g.raw([
      "ls-files",
      "-v",
      "-s",
      "-z",
      "--full-name",
      "--",
      ...(act.paths.length > 0 ? act.paths : [":/"]),
    ]);
    if (listed === null) return null; // a pathspec git cannot read: the act fails on it the same way
    const marked = listed
      .split("\0")
      .map((l) => /^([a-zS]) \d+ ([0-9a-f]+) \d\t(.*)$/s.exec(l))
      .filter((m): m is RegExpExecArray => m !== null && existsSync(join(top, m[3])));
    if (marked.length > 0) {
      const now = g.hash(marked.map((m) => join(top, m[3])));
      const edited = marked.find((m, i) => now === null || now[i] !== m[2]);
      if (edited) {
        return `has edits git stash does not see (${edited[3]} is marked ${edited[1] === "S" ? "skip-worktree" : "assume-unchanged"}), which the act may overwrite and no snapshot holds`;
      }
    }
  }
  return null;
}

/** A path as `git clean -n` prints it: C-quoted when it holds a control
 *  character, a quote or a backslash (core.quotePath=false keeps the rest). */
export function cUnquote(s: string): string | null {
  if (!s.startsWith('"')) return s;
  if (s.length < 2 || !s.endsWith('"')) return null;
  const ESC: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '"': 34, "\\": 92 };
  const body = Buffer.from(s.slice(1, -1), "utf8");
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== 0x5c) {
      bytes.push(body[i]);
      continue;
    }
    const c = String.fromCharCode(body[++i] ?? 0);
    const octal = /^[0-3][0-7]{2}$/.exec(body.subarray(i, i + 3).toString("latin1"));
    if (c in ESC) bytes.push(ESC[c]);
    else if (octal) {
      bytes.push(parseInt(octal[0], 8));
      i += 2;
    } else return null;
  }
  return Buffer.from(bytes).toString("utf8");
}

/** What stands at `rel` (or at a parent of it that is not a directory), if anything. */
function inTheWay(top: string, rel: string): string | null {
  const parts = rel.split("/");
  let cur = top;
  for (let i = 0; i < parts.length; i++) {
    cur = join(cur, parts[i]);
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      return null;
    }
    if (i === parts.length - 1 || !st.isDirectory()) return cur;
  }
  return null;
}

/** Why the act cannot run under the allow — the repository would run its own
 *  code, or there is no archive of this user's to record the pin in — or the archive. */
function readyToAct(no: string | null, sub: string, env: NodeJS.ProcessEnv): { refused: string } | { archive: string } {
  if (no) return { refused: `this repository ${no} — \`git ${sub}\` not run under bastra's allow (nothing changed)` };
  try {
    return { archive: archiveRoot(env) };
  } catch (e) {
    return { refused: `${(e as Error).message} — \`git ${sub}\` not run (nothing changed)` };
  }
}

/** The shim's own git calls in `cwd`: the real git, output read, stderr dropped. */
function plumbing(real: string, cwd: string, gitEnv: NodeJS.ProcessEnv): Plumbing {
  const run = (args: string[], input?: string): string | null => {
    try {
      return execFileSync(real, args, {
        cwd,
        env: gitEnv,
        encoding: "utf8",
        input,
        stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
        timeout: 10_000,
        maxBuffer: 64 << 20,
      });
    } catch {
      return null;
    }
  };
  const raw = (args: string[]): string | null => run([...SAFE, ...args]);
  const git = (args: string[]): string | null => raw(args)?.trimEnd() ?? null;
  const plain = (args: string[]): string | null => run(args);
  const hash = (files: string[]): string[] | null =>
    run([...SAFE, "hash-object", "--stdin-paths"], files.join("\n") + "\n")
      ?.trimEnd()
      .split("\n") ?? null;
  return { git, raw, plain, hash };
}

const ASK_USER = "Ask the user to run it, or BASTRA_GIT_SHIM=0 for the normal permission prompt.";

/** What an act's saving steps need: where the act runs, the archive, the caller's call. */
interface Shim {
  argv: string[];
  sub: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** The worktree's top; null in a bare repository. */
  top: string | null;
  /** Where the way back runs: the top, or a bare repository's git directory. */
  home: string;
  archive: string;
  now: Date;
  ts: string;
  call: string;
  /** Part of every ref this run pins. */
  stamp: string;
  git: Plumbing["git"];
  raw: Plumbing["raw"];
  out: (s: string) => void;
  err: (s: string) => void;
  /** The act itself: the real git with the caller's argv, its exit code. */
  passThrough: () => number;
}

/** Pin `sha` under a new ref and record it with its way back; false: neither stays. */
function pin(s: Shim, slug: string, sha: string, what: string, restore: string[][]): boolean {
  // A new ref every time (the empty old value: "must not exist yet") — two
  // stashes dropped by one `clear`, or two acts in one second, never share one.
  let ref = "";
  for (let n = 0; ; n++) {
    if (n > 50) return false;
    ref = `refs/bastra-archive/${slug}/${s.stamp}-${n}`;
    if (s.git(["update-ref", ref, sha, ""]) !== null) break;
  }
  const [first, ...then] = restore;
  const row = {
    ts: s.ts,
    action: "pinned",
    orig: s.home,
    dest: ref,
    sha,
    act: what,
    restore: first,
    ...(then.length > 0 ? { then } : {}),
    kind: "user",
    cwd: s.cwd,
    argv: s.argv,
    call: s.call,
  };
  try {
    appendManifest(s.archive, JSON.stringify(row) + "\n");
  } catch {
    s.git(["update-ref", "-d", ref, sha]);
    return false;
  }
  return true;
}

function refuse(s: Shim, why: string, changed = "nothing changed"): number {
  s.err(`bastra: ${why} — \`git ${s.sub}\` not run (${changed}). ${ASK_USER}`);
  return 1;
}

/** `path` through the archiving rm, its receipt naming the git act; true when archived. */
function archived(s: Shim, path: string, via: string): boolean {
  return (
    runRmShim(["-rf", "--", path], {
      env: { ...s.env, BASTRA_RM_CALL: s.call },
      cwd: s.cwd,
      now: s.now,
      err: s.err,
      via,
    }) === 0
  );
}

/** `git clean -f…`: what its dry run names goes through the archiving rm; the real git does not run. */
function cleanAct(s: Shim, act: Extract<GitAct, { kind: "clean" }>): number {
  const listed = s.git(["-c", "core.quotePath=false", "clean", "-n", ...act.dry]);
  if (listed === null) return s.passThrough(); // git's own error, as it would print it
  const paths: Array<[shown: string, path: string]> = [];
  for (const line of listed.split("\n").filter(Boolean)) {
    if (line.startsWith("Would skip repository ")) continue;
    const m = /^Would remove (.+)$/.exec(line);
    const path = m && cUnquote(m[1]);
    if (!m || !path) return refuse(s, `cannot read what git clean would remove (${line.slice(0, 80)})`);
    paths.push([m[1], path]);
  }
  let rc = 0;
  for (const [shown, rel] of paths) {
    if (!archived(s, rel.replace(/\/$/, ""), "git clean")) rc = 1;
    else if (!act.quiet) s.out(`Removing ${shown}`);
  }
  return rc;
}

/** `git branch -D`: each branch that is there is pinned, then the act runs. */
function branchAct(s: Shim, act: Extract<GitAct, { kind: "branch" }>): number {
  for (const name of act.names) {
    const ref = act.remote ? `refs/remotes/${name}` : `refs/heads/${name}`;
    const sha = s.git(["rev-parse", "--verify", "-q", `${ref}^{commit}`]);
    if (!sha) continue; // git reports the missing branch itself
    const back = act.remote ? ["-C", s.home, "update-ref", ref, sha] : ["-C", s.home, "branch", name, sha];
    if (
      !pin(
        s,
        `${act.remote ? "remote-branch" : "branch"}/${name}`,
        sha,
        `git branch -D ${act.remote ? "-r " : ""}${name}`,
        [back]
      )
    )
      return refuse(s, `could not pin ${name}`);
  }
  return s.passThrough();
}

/** `git stash drop|clear`: each stash that is there is pinned, then the act runs. */
function stashAct(s: Shim, act: Extract<GitAct, { kind: "stash" }>): number {
  const refs =
    act.refs === "clear" ? (s.git(["stash", "list", "--format=%gd"]) ?? "").split("\n").filter(Boolean) : act.refs;
  for (const r of refs) {
    const sha = s.git(["rev-parse", "--verify", "-q", `${r}^{commit}`]);
    if (!sha) continue; // git reports the missing stash itself
    const msg = s.git(["log", "-1", "--format=%s", sha]) ?? "bastra-restored stash";
    if (
      !pin(s, "stash", sha, `git stash ${act.refs === "clear" ? "clear" : "drop"} (${r})`, [
        ["-C", s.home, "stash", "store", "-m", msg, sha],
      ])
    ) {
      return refuse(s, `could not pin ${r}`);
    }
  }
  return s.passThrough();
}

type SnapshotAct = Extract<GitAct, { kind: "snapshot" }>;

/** Paths (from the top) that differ between two trees, inside the act's paths. */
function differ(s: Shim, paths: string[], from: string, to: string, filter: string, cached = false): string[] | null {
  const listed = s.raw([
    "diff",
    ...(cached ? ["--cached"] : []),
    "--name-only",
    "-z",
    "--no-renames",
    "--no-ext-diff",
    `--diff-filter=${filter}`,
    from,
    ...(cached ? [] : [to]),
    "--",
    ...paths,
  ]);
  return listed === null ? null : listed.split("\0").filter(Boolean);
}

/** What stands untracked where the act writes a tracked file; null: git could not list it. */
function overwritten(s: Shim, act: SnapshotAct): string[] | null {
  // Untracked, and the act writes a tracked file there: in the tree it takes
  // its content from, not in the index, present on disk.
  const over: string[] = [];
  if (act.worktree && act.source !== undefined) {
    const added = differ(s, act.paths, act.source, "", "D", true);
    if (added === null) return null;
    for (const rel of added) {
      const at = inTheWay(s.top as string, rel);
      if (at && !over.includes(at) && s.git(["ls-files", "-z", "--", at]) === "") over.push(at);
    }
  }
  return over;
}

/** Pin the uncommitted work `sha` holds with its way back; why that failed, or null. */
function pinSnapshot(s: Shim, act: SnapshotAct, sha: string): string | null {
  const what = `git ${act.what}`;
  if (act.what === "reset --hard") {
    if (!pin(s, "reset", sha, what, [["-C", s.top as string, "stash", "apply", "--index", sha]]))
      return "could not pin the uncommitted changes";
  } else {
    // What the act discards in its paths: where the snapshot differs from
    // the tree the act writes. Named file by file, so the way back is
    // exact whatever the pathspec was, and a path that loses nothing is
    // not in it.
    const from = act.source ?? `${sha}^2`;
    const index = act.staged ? differ(s, act.paths, from, `${sha}^2`, "AMT") : [];
    const files = act.worktree ? differ(s, act.paths, from, sha, "AMT") : [];
    if (index === null || files === null) return "could not list what the act would discard";
    const back = (src: string, where: string, names: string[]): string[] => [
      "-C",
      s.top as string,
      "--literal-pathspecs",
      "restore",
      `--source=${src}`,
      where,
      "--",
      ...names,
    ];
    const restore = [
      ...(index.length > 0 ? [back(`${sha}^2`, "--staged", index)] : []),
      ...(files.length > 0 ? [back(sha, "--worktree", files)] : []),
    ];
    if (restore.length > 0 && !pin(s, act.what === "restore" ? "restore" : "checkout", sha, what, restore))
      return "could not pin the uncommitted changes";
  }
  return null;
}

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
  // Whatever runs next sees a PATH without us: another git shim further down
  // PATH (one that signs commits, say) looks for "the next git" the same way,
  // and with us still in PATH the two would hand the call back and forth.
  const childEnv = { ...env, PATH: withoutShims(env.PATH) };
  const passThrough = (): number => spawnSync(real, argv, { stdio: "inherit", cwd: cwd0, env: childEnv }).status ?? 1;
  // Switched off in the command's own environment: the real git, whatever
  // put this directory in PATH.
  if (isOffValue(env.BASTRA_GIT_SHIM)) return passThrough();
  const p = parseGit(argv);
  const act = p && !p.otherGlobals ? gitAct(p) : null;
  if (!p || !act) {
    // The lane allowed the command as written; this is what the shell made of
    // it. `git restore {-p,a}`, or `git restore *` next to a file named `-p`,
    // reads as an act there and arrives here as another form. Inside an
    // allowed command (the rewrite sets BASTRA_RM_CALL) nothing but an act runs.
    if (!env.BASTRA_RM_CALL) return passThrough();
    err(
      `bastra: \`git ${argv.join(" ").slice(0, 120)}\` is not an act bastra's allow covers (as the shell expanded it) — not run (nothing changed). ` +
        `Ask the user to run it, or BASTRA_GIT_SHIM=0 for the normal permission prompt.`
    );
    return 1;
  }

  const cwd = p.dirs.reduce((d, x) => resolve(d, x), cwd0);
  const plumb = plumbing(real, cwd, { ...childEnv, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" });
  const { git, raw } = plumb;
  const top = git(["rev-parse", "--show-toplevel"]);
  // A bare repository has branches and no worktree: `-C <its directory>` restores there.
  const home = top ?? (act.kind === "branch" ? git(["rev-parse", "--absolute-git-dir"]) : null);
  if (home === null) return passThrough(); // not a repository, or no worktree: git says so itself
  const ready = readyToAct(refusal(plumb, act, cwd, top), p.sub, env);
  if ("refused" in ready) {
    err(`bastra: ${ready.refused}. ${ASK_USER}`);
    return 1;
  }
  const now = io.now ?? new Date();
  const ts = localIso(now);
  const s: Shim = {
    argv,
    sub: p.sub,
    env,
    cwd,
    top,
    home,
    archive: ready.archive,
    now,
    ts,
    call: env.BASTRA_RM_CALL ?? "",
    stamp: `${ts.replace(/[-:]/g, "").replace("T", "-")}-${process.pid}`,
    git,
    raw,
    out,
    err,
    passThrough,
  };

  if (act.kind === "clean") return cleanAct(s, act);

  if (act.kind === "snapshot") {
    const sha = git(["stash", "create"]);
    if (sha === null) {
      if (git(["rev-parse", "--verify", "-q", "HEAD^{commit}"]) === null)
        return refuse(s, "there is no commit yet, so nothing can hold a snapshot of the staged files");
      if (git(["ls-files", "-u"]))
        return refuse(
          s,
          "the index has unmerged paths (a merge, rebase or cherry-pick in progress), which a snapshot cannot hold"
        );
      const ita = raw(["diff-files", "--name-only", "-z", "--diff-filter=A"])?.split("\0").filter(Boolean) ?? [];
      if (ita.length > 0)
        return refuse(s, `${ita[0]} was added with \`git add -N\` (intent to add), which git stash cannot save`);
      return refuse(s, "could not save the uncommitted changes first");
    }
    // A tree the act names and git cannot find: git says so itself, and changes nothing.
    if (act.source !== undefined && git(["rev-parse", "--verify", "-q", `${act.source}^{tree}`]) === null)
      return passThrough();
    const over = overwritten(s, act);
    if (over === null) return refuse(s, "could not list what the act would overwrite");
    if (sha) {
      const why = pinSnapshot(s, act, sha);
      if (why) return refuse(s, why);
    }
    for (const [i, at] of over.entries()) {
      if (!archived(s, at, `git ${act.what}`)) {
        return refuse(
          s,
          `could not move ${at} to the archive (git would overwrite it)`,
          i === 0 ? "nothing changed" : `${i} untracked file(s) already moved to the archive — see the receipt`
        );
      }
    }
    return passThrough();
  }

  if (act.kind === "branch") return branchAct(s, act);

  return stashAct(s, act);
}

/**
 * Is this one of the commands the shim records as a way back, for this row's
 * commit? `bastra archive restore` runs what the manifest says, so it runs
 * nothing else: no `-c`, no alias, no other subcommand.
 */
export function restoreShape(sha: string | undefined, cmd: string[]): boolean {
  if (!sha || !/^[0-9a-f]{40,64}$/.test(sha) || cmd[0] !== "-C" || typeof cmd[1] !== "string") return false;
  const rest = cmd.slice(2);
  const is = (...words: Array<string | RegExp>): boolean =>
    rest.length >= words.length && words.every((w, i) => (typeof w === "string" ? rest[i] === w : w.test(rest[i])));
  const name = /^[^-]/;
  if (rest.length === 4 && is("stash", "apply", "--index", sha)) return true;
  if (rest.length === 3 && is("branch", name, sha)) return true;
  if (rest.length === 3 && is("update-ref", /^refs\/remotes\/[^-]/, sha)) return true;
  if (rest.length === 5 && is("stash", "store", "-m", /^/, sha)) return true;
  const paths = (from: number): boolean => rest[from] === "--" && rest.length > from + 1;
  if (
    is("--literal-pathspecs", "restore") &&
    (rest[2] === `--source=${sha}` || rest[2] === `--source=${sha}^2`) &&
    /^--(?:staged|worktree)$/.test(rest[3] ?? "")
  )
    return paths(4);
  // As 631e5af recorded a path act.
  if (is("restore", `--source=${sha}`, "--worktree")) return paths(3);
  return false;
}
