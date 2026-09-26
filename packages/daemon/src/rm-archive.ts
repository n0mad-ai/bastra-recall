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
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
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
export function shimRewrite(command: string, call: string): string {
  return (
    `[ -x ${shq(SHIM_DIR + "/rm")} ] || exit 97; unset -f rm 2>/dev/null; ` +
    `export PATH=${shq(SHIM_DIR)}:"$PATH" BASTRA_RM_CALL=${shq(call)} BASTRA_NODE=${shq(process.execPath)}\n` +
    command
  );
}

export function archiveRoot(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.BASTRA_ARCHIVE_DIR || join(homedir(), ".bastra", "archive");
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

const under = (path: string, root: string): boolean => path === root || path.startsWith(root.replace(/\/$/, "") + "/");

export interface ManifestRow {
  ts: string;
  action: "archived" | "deleted" | "refused";
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
  const git = (cwd: string, args: string[]): string | null => {
    try {
      return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return null;
    }
  };
  const top = git(isDir ? real : dirname(real), ["rev-parse", "--show-toplevel"]);
  if (!top) return "user";
  const rel = relative(realpathSync(top), real);
  // "Get it back with checkout" holds only for tracked, unchanged files: not
  // for the repository itself (unpushed commits, stashes live in .git), not
  // for a directory that also holds untracked or ignored files (.env).
  if (!rel || rel.startsWith("..")) return "user";
  if (git(top, ["ls-files", "--", rel]) && git(top, ["status", "--porcelain", "--ignored", "--", rel]) === "") return "in-git";
  return "user";
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
  } catch {
    return null;
  }
}

const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
const localIso = (d: Date): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

export interface ShimIo {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  now?: Date;
  /** Temp roots — injectable so a test can archive inside os.tmpdir(). */
  ephemeral?: string[];
  out?: (s: string) => void;
  err?: (s: string) => void;
}

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
    const write = (): void => appendFileSync(join(archive, "manifest.jsonl"), JSON.stringify({ ts, ...row, cwd, argv, call }) + "\n");
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
    const root = archiveRootFor(parent, archive);
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
    try {
      mkdirSync(dirname(dest), { recursive: true });
      renameSync(real, dest);
    } catch (e) {
      err(`rm: '${t}' not moved to the archive: ${(e as Error).message}`);
      log({ action: "refused", orig: real, reason: (e as Error).message });
      rc = 1;
      continue;
    }
    try {
      log({ action: "archived", orig: real, dest, kind, bytes });
    } catch (e) {
      // A move nobody can find is a loss: without its manifest line, put it back.
      renameSync(dest, real);
      err(`rm: '${t}' not removed — the archive manifest cannot be written: ${(e as Error).message}`);
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

function parseManifest(file: string): ManifestRow[] {
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

/** What `rm` did in one tool call — the PostToolUse receipt (null: nothing recorded). */
export function callReport(call: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!call) return null;
  const rows = manifestRows(env, true).filter((r) => r.call === call);
  if (rows.length === 0) return null;
  const shown = rows.slice(0, RECEIPT_MAX_LINES);
  const lines = shown.map((r) =>
    r.action === "archived"
      ? `- archived ${r.orig} → ${r.dest} (restore: \`bastra archive restore ${shq(r.orig)}\`)`
      : r.action === "deleted"
        ? `- deleted for real (temp): ${r.orig}`
        : `- refused, left in place: ${r.orig} (${r.reason})`,
  );
  if (rows.length > shown.length) {
    const rest = rows.slice(shown.length);
    const n = (a: ManifestRow["action"]) => rest.filter((r) => r.action === a).length;
    lines.push(`- … and ${rest.length} more (${n("archived")} archived, ${n("deleted")} deleted, ${n("refused")} refused): \`bastra archive list\``);
  }
  return `What \`rm\` did in this command (bastra archiving rm):\n${lines.join("\n")}`;
}

export function restore(target: string, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
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

export type Kind = "junk" | "in-git" | "user";
export type Retain = Record<Kind, number>;
/**
 * Days the archive keeps a target, per class. Nothing longer than two days by
 * default: most of what an agent deletes is its own scratch (the harvest in
 * #650: 81% temp, build or its own probes), and the archive is a safety net
 * for the next step, not a backup. A maintainer's call — the knob is below.
 */
export const DEFAULT_RETAIN: Retain = { junk: 1, "in-git": 2, user: 2 };

/** `junk=1,in-git=2,user=0.5` → the classes it names; null when malformed. */
export function parseRetain(spec: string): Partial<Retain> | null {
  const out: Partial<Retain> = {};
  for (const part of spec.split(",").map((p) => p.trim()).filter(Boolean)) {
    const m = /^(junk|in-git|user)=(\d+(?:\.\d+)?)$/.exec(part);
    if (!m) return null;
    out[m[1] as Kind] = Number(m[2]);
  }
  return out;
}

/** Defaults, then `bastra config set archive.retain …`, then BASTRA_ARCHIVE_RETAIN (env wins, as for every key). */
export function retainDays(env: NodeJS.ProcessEnv = process.env, stored?: string): Retain {
  return {
    ...DEFAULT_RETAIN,
    ...(stored ? parseRetain(stored) ?? {} : {}),
    ...(env.BASTRA_ARCHIVE_RETAIN ? parseRetain(env.BASTRA_ARCHIVE_RETAIN) ?? {} : {}),
  };
}

/** Compared a chunk at a time: this runs inside the daemon, and two equal-sized
 *  files of a few GB must not become their size in memory. */
export function sameFile(a: string, b: string, chunk = 1 << 20): boolean {
  let fa = -1;
  let fb = -1;
  try {
    const sa = lstatSync(a);
    const sb = lstatSync(b);
    if (!sa.isFile() || !sb.isFile() || sa.size !== sb.size) return false;
    fa = openSync(a, "r");
    fb = openSync(b, "r");
    const ba = Buffer.alloc(chunk);
    const bb = Buffer.alloc(chunk);
    for (let pos = 0; pos < sa.size; pos += chunk) {
      const na = readSync(fa, ba, 0, chunk, pos);
      const nb = readSync(fb, bb, 0, chunk, pos);
      if (na !== nb || !ba.subarray(0, na).equals(bb.subarray(0, nb))) return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    if (fa >= 0) closeSync(fa);
    if (fb >= 0) closeSync(fb);
  }
}

/** Only what the shim put into an archive is the archive's to remove: the
 *  manifest is a plain file, and a torn or foreign line must not aim rmSync
 *  anywhere else. */
function inArchive(dest: string, archive: string): boolean {
  return under(dest, archive) || dest.includes("/.bastra-archive/");
}

export interface Drop {
  orig: string;
  dest: string;
  kind: string;
  bytes: number;
  why: string;
}

/**
 * What the archive can let go of, in this order: a target that came back with
 * the same content; a target older than its class keeps (`retain`, default
 * junk 1 day, in-git 2, user 2); then, over the size cap, junk before in-git —
 * never a user target younger than the user retention.
 */
export function reconcilePlan(
  now: Date,
  capBytes: number,
  env: NodeJS.ProcessEnv = process.env,
  retain: Retain = retainDays(env),
): Drop[] {
  const archive = archiveRoot(env);
  const live = manifestRows(env).filter((r) => r.action === "archived" && r.dest && inArchive(r.dest, archive) && existsSync(r.dest));
  const drop: Drop[] = [];
  const keep: Array<ManifestRow & { age: number }> = [];
  for (const r of live) {
    const age = (now.getTime() - new Date(r.ts).getTime()) / 86_400_000;
    const kind = r.kind ?? "user";
    const base = { orig: r.orig, dest: r.dest as string, kind, bytes: r.bytes ?? 0 };
    if (sameFile(r.orig, r.dest as string)) drop.push({ ...base, why: "came back with the same content" });
    else if (age > retain[kind]) drop.push({ ...base, why: `${kind} older than ${retain[kind]} days` });
    else keep.push({ ...r, age });
  }
  let total = keep.reduce((s, r) => s + (r.bytes ?? 0), 0);
  const rank = { junk: 0, "in-git": 1, user: 2 };
  for (const r of keep.sort((a, b) => rank[a.kind ?? "user"] - rank[b.kind ?? "user"] || b.age - a.age)) {
    if (total <= capBytes) break;
    if ((r.kind ?? "user") === "user" && r.age < retain.user) continue;
    drop.push({ orig: r.orig, dest: r.dest as string, kind: r.kind ?? "user", bytes: r.bytes ?? 0, why: "archive size cap" });
    total -= r.bytes ?? 0;
  }
  return drop;
}

/** The manifest the shim appends to is rotated once it holds this much. */
const ROTATE_BYTES = 1 << 20;
/** A rotated manifest goes once it is this old and none of its rows is live. */
const MANIFEST_DAYS = 30;

export function applyReconcile(drop: Drop[], env: NodeJS.ProcessEnv = process.env, now = new Date()): void {
  const root = archiveRoot(env);
  stampReconcile(env, now);
  for (const d of drop) rmSync(d.dest, { recursive: true, force: true });
  // The manifest is read whole by every receipt and by restore; without this
  // it only grows (one line per target, for good). Rotation is a rename — a
  // shim appending at that moment writes into one of the two files.
  const current = join(root, "manifest.jsonl");
  try {
    if (statSync(current).size >= ROTATE_BYTES) {
      const stamp = localIso(now).replace(/[-:]/g, "").replace("T", "-");
      renameSync(current, join(root, `manifest.${stamp}-${process.pid}.jsonl`));
    }
  } catch {
    /* no manifest yet */
  }
  for (const file of manifestFiles(env)) {
    if (file === current) continue;
    let old: boolean;
    try {
      old = now.getTime() - statSync(file).mtimeMs > MANIFEST_DAYS * 86_400_000;
    } catch {
      continue;
    }
    if (old && !parseManifest(file).some((r) => r.action === "archived" && r.dest && existsSync(r.dest))) unlinkSync(file);
  }
}

export function stampReconcile(env: NodeJS.ProcessEnv = process.env, now = new Date()): void {
  writeFileSync(join(archiveRoot(env), ".reconcile-stamp"), now.toISOString() + "\n");
}

/** True when the last reconcile ran more than a day ago (or never, and there is something to reconcile). */
/** How often the archive is looked at: hourly, so a 2-day (or shorter)
 *  retention is kept to within an hour, not a day. */
export const RECONCILE_EVERY_MS = 3_600_000;

/** True when the archive exists and was last reconciled over an hour ago
 *  (or never). Creates nothing: this runs after every Bash call. */
export function reconcileDue(env: NodeJS.ProcessEnv = process.env, now = Date.now()): boolean {
  const root = env.BASTRA_ARCHIVE_DIR || join(homedir(), ".bastra", "archive");
  try {
    return now - statSync(join(root, ".reconcile-stamp")).mtimeMs > RECONCILE_EVERY_MS;
  } catch {
    return existsSync(join(root, "manifest.jsonl"));
  }
}
