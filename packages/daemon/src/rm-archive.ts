/**
 * The archiving `rm` for the agent shell (#650): `rm` that moves its targets
 * into an archive instead of unlinking them, so "rm -rf" in the model's shell
 * is a move with an address, not a loss.
 *
 * - temp ground (/tmp, /var/tmp, /dev/shm, /run/user/<uid>, $TMPDIR, macOS
 *   /private/tmp and /private/var/folders) is really removed — nothing there
 *   is worth an archive;
 * - /, ~, system directories and any ancestor of the archive are refused —
 *   moving /etc breaks a system as surely as deleting it;
 * - everything else moves to <archive>/<date>/<HHMMSS>-<pid>/<absolute path>
 *   on the same filesystem (a rename: atomic, free), or to
 *   <mount>/.bastra-archive when the target lives on another one.
 *
 * Every act — archived, deleted (temp) or refused — is one line in
 * <archive>/manifest.jsonl, tagged with the tool call that ran it
 * (BASTRA_RM_CALL). The PostToolUse lane reads those lines back, so the model
 * learns what happened, not what the pre-hook predicted.
 *
 * Only the agent shell sees this `rm`: the bash-pre lane puts `shims/` first
 * in PATH of that one command. The user's shell, build scripts and makepkg
 * keep the system `rm`.
 */
import { isPin, pinLive, restoreCommand, restorePin, restoreShape, withoutShims } from "./git-archive.js";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SHIM_DIR = fileURLToPath(new URL("../shims", import.meta.url));

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The command as it runs when bastra's archiving `rm` carries the receipt:
 * one line — the shim must be on this disk (a daemon on another host: exit 97,
 * nothing runs, never a real `rm` behind an archive receipt); an rm()
 * function the shell brought along is dropped (Claude Code's snapshot clears
 * aliases, not functions); then `shims/` first in PATH, the tool call id for
 * the manifest and node for the shim — and the command as written. No `.`,
 * no `$(…)`: under a deny or `ask` rule Claude Code shows this line to the
 * model and the user, and flags either as "evaluates shell code".
 */
export function shimRewrite(command: string, call: string, git = false): string {
  // A command with a git act needs shims/git too: without it the next `git`
  // in PATH is the real one, and the act would run unpinned under the allow.
  const here = `[ -x ${shq(SHIM_DIR + "/rm")} ]` + (git ? ` && [ -x ${shq(SHIM_DIR + "/git")} ]` : "");
  return (
    `${here} || exit 97; unset -f rm git 2>/dev/null; ` +
    `export PATH=${shq(SHIM_DIR)}:"$PATH" BASTRA_RM_CALL=${shq(call)} BASTRA_NODE=${shq(stableNode(process.execPath))}\n` +
    command
  );
}

/**
 * The node the shim runs on, spelled so an upgrade does not take it away:
 * Homebrew's `<prefix>/Cellar/<formula>/<version>/bin/node` is gone after
 * `brew upgrade` + cleanup, while `<prefix>/opt/<formula>/bin/node` follows
 * the upgrade. Used only when it resolves to this very node; anything else
 * passes through (and the shim falls back to `node` on PATH if it vanishes).
 */
export function stableNode(execPath: string, realpath: (p: string) => string = realpathSync): string {
  const m = /^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/.exec(execPath);
  if (!m) return execPath;
  const opt = `${m[1]}/opt/${m[2]}/bin/node`;
  try {
    return realpath(opt) === realpath(execPath) ? opt : execPath;
  } catch {
    return execPath;
  }
}

/** Where the archive lives — creates nothing (the post lane asks after every Bash call). */
export function archiveDir(env: NodeJS.ProcessEnv): string {
  return env.BASTRA_ARCHIVE_DIR || join(homedir(), ".bastra", "archive");
}

export function archiveRoot(env: NodeJS.ProcessEnv = process.env): string {
  const raw = archiveDir(env);
  mkdirSync(raw, { recursive: true });
  return realpathSync(raw);
}

export function ephemeralRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  // BASTRA_RM_TEMP_ROOTS replaces the list (colon-separated; empty = none).
  const roots =
    env.BASTRA_RM_TEMP_ROOTS !== undefined
      ? env.BASTRA_RM_TEMP_ROOTS.split(":").filter(Boolean)
      : [
          "/tmp", "/var/tmp", "/dev/shm", `/run/user/${uid}`, "/private/tmp", "/private/var/folders",
          ...(env.TMPDIR ? [env.TMPDIR] : []),
          // Claude Code's per-uid temp dir (scratchpads live under it) is
          // /tmp/claude-<uid> on Linux and macOS, unless moved with this.
          ...(env.CLAUDE_CODE_TMPDIR ? [env.CLAUDE_CODE_TMPDIR] : []),
        ];
  return roots.flatMap((r) => {
    try {
      return [realpathSync(r)];
    } catch {
      return [];
    }
  });
}

const SYSTEM = new Set([
  "/", "/etc", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/boot", "/var", "/opt", "/root", "/home",
  "/dev", "/proc", "/sys", "/run", "/mnt", "/srv", "/tmp",
  "/System", "/Users", "/Library", "/Applications", "/private",
]);

export const under = (path: string, root: string): boolean => path === root || path.startsWith(root.replace(/\/$/, "") + "/");

export interface ManifestRow {
  ts: string;
  /** `pinned`: a git snapshot (git-archive.ts) — orig is the repository,
   *  dest the ref under refs/bastra-archive/, restore the git argv. */
  action: "archived" | "deleted" | "refused" | "pinned";
  sha?: string;
  act?: string;
  restore?: string[];
  /** More restore commands, run after `restore` (index, then worktree). */
  then?: string[][];
  /** The git act that sent this path through the archiving rm (`git clean`). */
  via?: string;
  orig: string;
  dest?: string;
  kind?: "junk" | "in-git" | "user";
  bytes?: number;
  reason?: string;
  cwd: string;
  argv: string[];
  call: string;
}

// ─── The shim ────────────────────────────────────────────────────────

interface Parsed {
  flags: Set<string>;
  targets: string[];
  error?: string;
}

const LONG: Record<string, string> = {
  "--recursive": "r", "--force": "f", "--dir": "d", "--verbose": "v", "--interactive": "i",
  "--preserve-root": "", "--no-preserve-root": "", "--one-file-system": "",
};
/** Short flags: GNU's, plus BSD's -x (one file system; a rename never crosses
 *  one) and -P (overwrite before unlink; a no-op on macOS since 13). -W
 *  (undelete a whiteout) stays unknown. */
const SHORT = "rRfdviIxP";

export function parseRmArgs(argv: string[]): Parsed {
  const flags = new Set<string>();
  const targets: string[] = [];
  let done = false;
  for (const a of argv) {
    if (done || a === "-" || !a.startsWith("-")) targets.push(a);
    else if (a === "--") done = true;
    else if (a.startsWith("--")) {
      const name = /^--(?:interactive|preserve-root)=/.test(a) ? a.slice(0, a.indexOf("=")) : a;
      if (!(name in LONG)) return { flags, targets, error: `rm: unrecognized option '${a}' (bastra archiving rm)` };
      if (LONG[name] && name === a) flags.add(LONG[name]);
    } else {
      for (const ch of a.slice(1)) {
        if (!SHORT.includes(ch)) return { flags, targets, error: `rm: invalid option -- '${ch}' (bastra archiving rm)` };
        flags.add(ch === "R" ? "r" : ch);
      }
    }
  }
  return { flags, targets };
}

/** A target with one of these names is junk. */
const JUNK_PARTS = new Set([
  "node_modules", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".cache", "dist", "build",
  "target", ".next", ".turbo", ".venv", "venv", "coverage", ".tox", ".gradle", "out",
]);
/** So is anything inside one of these, whatever its own name. Not `build`,
 *  `out`, `target`, `dist`: people keep their own files under such names. */
const JUNK_DIRS = new Set(["node_modules", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", ".venv", ".gradle", ".next", ".turbo"]);
const JUNK_SUFFIX = [".pyc", ".o", ".obj", ".class", ".log", ".tmp"];

/** The class decides how long the archive keeps a target (see `reconcile`). */
function classify(real: string, isDir: boolean): "junk" | "in-git" | "user" {
  const parts = real.split("/");
  if (
    JUNK_PARTS.has(basename(real)) ||
    parts.slice(0, -1).some((p) => JUNK_DIRS.has(p)) ||
    (!isDir && JUNK_SUFFIX.some((s) => real.endsWith(s)))
  ) {
    return "junk";
  }
  // null: git failed or ran out of time (3 s; an index.lock, a cold monorepo).
  // A failure is not "clean" — an empty status has to be git's own answer.
  //
  // Only plumbing that runs nothing from the repository: this is under the
  // hook's allow, and the repo's own config could otherwise execute a command
  // (`core.fsmonitor` on `git status`, a clean filter while status refreshes
  // the index). No `status`; fsmonitor off; content hashed with --no-filters.
  const git = (cwd: string, args: string[], input?: string): string | null => {
    try {
      return execFileSync("git", ["-c", "core.fsmonitor=false", "-C", cwd, ...args], {
        encoding: "utf8",
        timeout: 3000,
        // The real git: shims/ is first in this process's PATH, and bastra's
        // git there runs nothing but an act inside an allowed command.
        env: { ...process.env, PATH: withoutShims(process.env.PATH) },
        input,
        stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
      }).trim();
    } catch {
      return null;
    }
  };
  const top = git(isDir ? real : dirname(real), ["rev-parse", "--show-toplevel"]);
  if (!top) return "user";
  const topReal = realpathSync(top);
  const rel = relative(topReal, real);
  // "Get it back with checkout" holds only for tracked, unchanged files: not
  // for the repository itself (unpushed commits, stashes live in .git), not
  // for a directory that also holds untracked or ignored files (.env).
  if (!rel || rel.startsWith("..")) return "user";
  const staged = git(topReal, ["ls-files", "-s", "--", rel]);
  if (!staged) return "user";
  const entries = staged.split("\n").map((l) => /^\d+ ([0-9a-f]+) \d\t(.*)$/.exec(l));
  if (entries.some((m) => !m) || entries.length > 500) return "user";
  // Worktree = index (hashed as stored, no filters), index = HEAD, nothing
  // untracked or ignored beside it.
  const hashes = git(topReal, ["hash-object", "--no-filters", "--stdin-paths"], entries.map((m) => (m as RegExpExecArray)[2]).join("\n") + "\n");
  if (hashes === null || hashes !== entries.map((m) => (m as RegExpExecArray)[1]).join("\n")) return "user";
  if (git(topReal, ["diff-index", "--cached", "--quiet", "HEAD", "--", rel]) === null) return "user";
  if (git(topReal, ["ls-files", "--others", "--", rel]) !== "") return "user";
  return "in-git";
}

/** Bytes of a target; a directory walk stops after `cap` entries. */
function sizeOf(real: string, cap = 50_000): number {
  let total = 0;
  let seen = 0;
  const walk = (p: string): void => {
    let st;
    try {
      st = lstatSync(p);
    } catch {
      return;
    }
    if (!st.isDirectory()) {
      total += st.size;
      seen++;
      return;
    }
    let names: string[];
    try {
      names = readdirSync(p);
    } catch {
      return;
    }
    for (const n of names) {
      if (seen > cap) return;
      walk(join(p, n));
    }
  };
  walk(real);
  return total;
}

function mountpointOf(path: string): string {
  const dev = statSync(path).dev;
  let cur = path;
  while (cur !== "/" && statSync(dirname(cur)).dev === dev) cur = dirname(cur);
  return cur;
}

/** An archive on the target's filesystem: a rename, never a copy. */
function archiveRootFor(parent: string, archive: string): string | null {
  const dev = statSync(parent).dev;
  if (statSync(archive).dev === dev) return archive;
  const alt = join(mountpointOf(parent), ".bastra-archive");
  try {
    mkdirSync(alt, { recursive: true });
    return statSync(alt).dev === dev ? alt : null;
  } catch (e) {
    // #695: a full volume is said as that, not as "no writable archive".
    if (isDiskFull(e)) throw e;
    return null;
  }
}

const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
export const localIso = (d: Date): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

export interface ShimIo {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  now?: Date;
  /** Temp roots — injectable so a test can archive inside os.tmpdir(). */
  ephemeral?: string[];
  /** The git act this rm stands in for (git-archive.ts); the receipt names it. */
  via?: string;
  out?: (s: string) => void;
  err?: (s: string) => void;
}

const isDiskFull = (e: unknown): boolean => ["ENOSPC", "EDQUOT"].includes((e as NodeJS.ErrnoException).code ?? "");

/** #695: archiving is a move — on a full disk it cannot free space. Say so and
 *  name the ways out; the target stays where it was, nothing is deleted. */
const diskFull = (t: string): string =>
  `rm: '${t}' not removed — the disk is full (ENOSPC) and archiving is a move, it frees no space. ` +
  "Free space with `bastra archive reconcile --yes`, delete for real with `/bin/rm`, " +
  "or turn the archive off: `bastra config set archive.enabled off`";

/** `rm` with the system's exit codes and messages, archiving instead of unlinking. */
export function runRmShim(argv: string[], io: ShimIo = {}): number {
  const env = io.env ?? process.env;
  const cwd = io.cwd ?? process.cwd();
  const now = io.now ?? new Date();
  const out = io.out ?? ((s: string) => process.stdout.write(s + "\n"));
  const err = io.err ?? ((s: string) => process.stderr.write(s + "\n"));
  const { flags, targets, error } = parseRmArgs(argv);
  if (error) {
    err(error);
    return 1;
  }
  if (targets.length === 0) {
    if (flags.has("f")) return 0;
    err("rm: missing operand");
    return 1;
  }
  const archive = archiveRoot(env);
  const eph = io.ephemeral ?? ephemeralRoots(env);
  const call = env.BASTRA_RM_CALL ?? "";
  const ts = localIso(now);
  const log = (row: Omit<ManifestRow, "ts" | "cwd" | "argv" | "call">): void => {
    const write = (): void =>
      appendFileSync(join(archive, "manifest.jsonl"), JSON.stringify({ ts, ...row, ...(io.via ? { via: io.via } : {}), cwd, argv, call }) + "\n");
    if (row.action === "archived") return write();
    try {
      write();
    } catch {
      /* the act itself is said on stderr */
    }
  };
  let rc = 0;
  const home = realpathSync(homedir());
  for (const t of targets) {
    // rm refuses these itself: removing the directory you stand in.
    if (/(?:^|\/)\.\.?\/*$/.test(t)) {
      err(`rm: refusing to remove '.' or '..' directory: skipping '${t}'`);
      rc = 1;
      continue;
    }
    const ab = resolve(cwd, t);
    let parent: string;
    try {
      parent = realpathSync(dirname(ab));
    } catch {
      parent = dirname(ab);
    }
    // The link itself is the target, not what it points to.
    const real = join(parent, basename(ab));
    let st;
    try {
      st = lstatSync(real);
    } catch {
      if (!flags.has("f")) {
        err(`rm: cannot remove '${t}': No such file or directory`);
        rc = 1;
      }
      continue;
    }
    const isDir = st.isDirectory();
    if (isDir && !flags.has("r")) {
      let empty = false;
      if (flags.has("d")) {
        try {
          empty = readdirSync(real).length === 0;
        } catch (e) {
          err(`rm: cannot remove '${t}': ${(e as NodeJS.ErrnoException).code === "EACCES" ? "Permission denied" : (e as Error).message}`);
          rc = 1;
          continue;
        }
      }
      if (!empty) {
        err(`rm: cannot remove '${t}': Is a directory`);
        rc = 1;
        continue;
      }
    }
    if (SYSTEM.has(real) || real === home || under(archive, real) || eph.includes(real)) {
      err(`rm: refusing '${t}': root, home, a system or temp root, or an ancestor of the archive`);
      log({ action: "refused", orig: real, reason: "root, home, system or temp root, or archive ancestor" });
      rc = 1;
      continue;
    }
    if (under(real, archive)) {
      err(`rm: '${t}' is already in the archive — the archive lets it go by itself (bastra archive reconcile)`);
      log({ action: "refused", orig: real, reason: "already in the archive" });
      rc = 1;
      continue;
    }
    if (eph.some((r) => under(real, r))) {
      try {
        rmSync(real, { recursive: true, force: true });
      } catch (e) {
        err(`rm: cannot remove '${t}': ${(e as Error).message}`);
        log({ action: "refused", orig: real, reason: (e as Error).message });
        rc = 1;
        continue;
      }
      log({ action: "deleted", orig: real, reason: "temp" });
      if (flags.has("v")) out(`removed (temp) '${t}'`);
      continue;
    }
    let root: string | null;
    try {
      root = archiveRootFor(parent, archive);
    } catch (e) {
      // #695: the volume's own archive cannot be made on a full disk.
      if (!isDiskFull(e)) throw e;
      err(diskFull(t));
      log({ action: "refused", orig: real, reason: (e as Error).message });
      rc = 1;
      continue;
    }
    if (!root) {
      err(`rm: '${t}' is on another filesystem without a writable .bastra-archive — not archived, not removed`);
      log({ action: "refused", orig: real, reason: "no archive on this filesystem" });
      rc = 1;
      continue;
    }
    const base = join(root, ts.slice(0, 10), `${ts.slice(11).replace(/:/g, "")}-${process.pid}`, real.replace(/^\/+/, ""));
    // `rm -r a/b a` in one call: a/b's move made a directory where a goes.
    let dest = base;
    for (let n = 2; existsSync(dest); n++) dest = `${base}~${n}`;
    const kind = classify(real, isDir);
    const bytes = sizeOf(real);
    // The topmost directory the mkdir has to make: it can fail halfway (ENOSPC).
    let top = dirname(dest);
    while (!existsSync(dirname(top))) top = dirname(top);
    const fresh = !existsSync(top);
    try {
      mkdirSync(dirname(dest), { recursive: true });
      renameSync(real, dest);
    } catch (e) {
      // Only the empty directories this mkdir made; rmdir refuses anything else.
      for (let d = dirname(dest); fresh && d.length >= top.length; d = dirname(d)) {
        try {
          rmdirSync(d);
        } catch (gone) {
          if ((gone as NodeJS.ErrnoException).code !== "ENOENT") break;
        }
      }
      err(isDiskFull(e) ? diskFull(t) : `rm: '${t}' not moved to the archive: ${(e as Error).message}`);
      log({ action: "refused", orig: real, reason: (e as Error).message });
      rc = 1;
      continue;
    }
    try {
      log({ action: "archived", orig: real, dest, kind, bytes });
    } catch (e) {
      // A move nobody can find is a loss: without its manifest line, put it back.
      renameSync(dest, real);
      err(isDiskFull(e) ? diskFull(t) : `rm: '${t}' not removed — the archive manifest cannot be written: ${(e as Error).message}`);
      rc = 1;
      continue;
    }
    if (flags.has("v")) out(`archived '${t}' → ${dest}`);
  }
  return rc;
}

// ─── Reading the archive ─────────────────────────────────────────────

/** The manifest the shim appends to, and the ones reconcile rotated it into
 *  (`manifest.<stamp>.jsonl`, oldest first). Rotation is a rename, so a line
 *  the shim writes during it lands in one of the two, never nowhere. */
export function manifestFiles(env: NodeJS.ProcessEnv = process.env, current = false): string[] {
  const root = archiveRoot(env);
  if (current) return [join(root, "manifest.jsonl")];
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const rotated = names.filter((n) => /^manifest\..+\.jsonl$/.test(n)).sort();
  return [...rotated, "manifest.jsonl"].map((n) => join(root, n));
}

export function parseManifest(file: string): ManifestRow[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const rows: ManifestRow[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as ManifestRow;
      if (r && typeof r.orig === "string") rows.push({ ...r, action: r.action ?? "archived" });
    } catch {
      /* a torn line is skipped, not fatal */
    }
  }
  return rows;
}

/** Every row, oldest first. `current`: only the file the shim appends to now —
 *  what this call did is there, and reading it costs a day of rm, not a month. */
export function manifestRows(env: NodeJS.ProcessEnv = process.env, current = false): ManifestRow[] {
  return manifestFiles(env, current).flatMap(parseManifest);
}

/** Lines a receipt shows before it says "and N more": a `find … -exec rm` over a
 *  tree produced 600 lines in one call (47 KB of context) before this cap. */
export const RECEIPT_MAX_LINES = 25;
/** A restore command longer than this is not quoted in the receipt. */
const RECEIPT_MAX_COMMAND = 600;

/** The restore commands of a pinned row, in the order they run (shell-quoted). */
export function restoreCommands(r: ManifestRow): string[] {
  return [r.restore ?? [], ...(r.then ?? [])].filter((c) => c.length > 0).map(restoreCommand);
}

/** What `rm` did in one tool call — the PostToolUse receipt (null: nothing recorded). */
export function callReport(call: string, env: NodeJS.ProcessEnv = process.env): string | null {
  // No manifest, nothing to report — and no ~/.bastra/archive made for a user who never opted in.
  if (!call || !existsSync(join(archiveDir(env), "manifest.jsonl"))) return null;
  const rows = manifestRows(env, true).filter((r) => r.call === call);
  if (rows.length === 0) return null;
  const shown = rows.slice(0, RECEIPT_MAX_LINES);
  const lines = shown.map((r) => {
    if (r.action === "pinned") {
      // A path act names every file it puts back: past a few, the short form only.
      const cmds = restoreCommands(r).map((c) => `\`${c}\``).join(" then ");
      const how = cmds.length > RECEIPT_MAX_COMMAND ? "" : `${cmds}, or `;
      return `- before \`${r.act}\` in ${r.orig}: saved ${(r.sha ?? "").slice(0, 10)} as ${r.dest} (restore: ${how}\`bastra archive restore ${r.dest}\`)`;
    }
    const via = r.via ? ` (before \`${r.via}\`)` : "";
    return r.action === "archived"
      ? `- archived${via} ${r.orig} → ${r.dest} (restore: \`bastra archive restore ${shq(r.orig)}\`)`
      : r.action === "deleted"
        ? `- deleted for real (temp)${via}: ${r.orig}`
        : `- refused, left in place${via}: ${r.orig} (${r.reason})`;
  });
  if (rows.length > shown.length) {
    const rest = rows.slice(shown.length);
    const n = (a: ManifestRow["action"]) => rest.filter((r) => r.action === a).length;
    lines.push(`- … and ${rest.length} more (${n("archived")} archived, ${n("deleted")} deleted, ${n("refused")} refused): \`bastra archive list\``);
  }
  const head = rows.some((r) => r.action === "pinned" || r.via)
    ? "What bastra's archive kept from this command (git snapshots, archiving rm):"
    : "What `rm` did in this command (bastra archiving rm):";
  return `${head}\n${lines.join("\n")}`;
}

export function restore(target: string, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  // A git snapshot, by its ref or sha: run the command the receipt named.
  const pinned = [...manifestRows(env)]
    .reverse()
    .find((r) => r.action === "pinned" && r.restore && (r.dest === target || (target.length >= 7 && (r.sha ?? "").startsWith(target))));
  if (pinned?.restore) {
    const cmds = [pinned.restore, ...(pinned.then ?? [])];
    // Only what the shim records: the manifest is a plain file, and this runs it.
    if (!isPin(pinned.dest) || !cmds.every((c) => Array.isArray(c) && restoreShape(pinned.sha, c))) {
      throw new Error(`the manifest row of ${target} is not one bastra's git snapshots wrote — not run`);
    }
    if (!pinLive(pinned.orig, pinned.dest)) throw new Error(`${pinned.dest} is gone from ${pinned.orig}`);
    for (const cmd of cmds) restorePin(cmd);
    return `what \`${pinned.act}\` discarded in ${pinned.orig} (${restoreCommands(pinned).join(" && ")})`;
  }
  // The manifest keeps the path with its parent resolved (/var → /private/var
  // on macOS); a path as the user typed it is resolved the same way.
  const typed = resolve(cwd, target);
  let want = typed;
  try {
    want = join(realpathSync(dirname(typed)), basename(typed));
  } catch {
    /* the parent went with it: match as typed */
  }
  const hit = [...manifestRows(env)]
    .reverse()
    .find((r) => r.action === "archived" && r.dest && (r.orig === want || r.orig === typed || r.dest === want || r.dest === typed) && existsSync(r.dest));
  if (!hit || !hit.dest) throw new Error(`nothing live in the archive for ${want}`);
  if (existsSync(hit.orig)) throw new Error(`${hit.orig} exists — not overwriting; move it away and retry`);
  mkdirSync(dirname(hit.orig), { recursive: true });
  renameSync(hit.dest, hit.orig);
  return hit.orig;
}

// Retention and reconcile live in rm-archive-reconcile.ts (file-size
// convention); re-exported so every importer keeps `from "./rm-archive.js"`.
export * from "./rm-archive-reconcile.js";
