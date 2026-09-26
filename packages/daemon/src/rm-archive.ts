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
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SHIM_DIR = fileURLToPath(new URL("../shims", import.meta.url));

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The command as it runs when bastra's archiving `rm` carries the receipt:
 * `shims/` first in PATH, the tool call id for the manifest, and node for the
 * shim. A missing shim (a daemon on another host) fails the command before it
 * runs — never a real `rm` behind an archive receipt.
 */
export function shimRewrite(command: string, call: string): string {
  return (
    `[ -x ${shq(SHIM_DIR + "/rm")} ] || { echo "bastra: archiving rm missing at ${SHIM_DIR} — command not run" >&2; exit 97; }\n` +
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
      : ["/tmp", "/var/tmp", "/dev/shm", `/run/user/${uid}`, "/private/tmp", "/private/var/folders", ...(env.TMPDIR ? [env.TMPDIR] : [])];
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

export function parseRmArgs(argv: string[]): Parsed {
  const flags = new Set<string>();
  const targets: string[] = [];
  let done = false;
  for (const a of argv) {
    if (done || a === "-" || !a.startsWith("-")) targets.push(a);
    else if (a === "--") done = true;
    else if (a.startsWith("--")) {
      if (!(a in LONG)) return { flags, targets, error: `rm: unrecognized option '${a}' (bastra archiving rm)` };
      if (LONG[a]) flags.add(LONG[a]);
    } else {
      for (const ch of a.slice(1)) {
        if (!"rRfdviI".includes(ch)) return { flags, targets, error: `rm: invalid option -- '${ch}' (bastra archiving rm)` };
        flags.add(ch === "R" ? "r" : ch);
      }
    }
  }
  return { flags, targets };
}

const JUNK_PARTS = new Set([
  "node_modules", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".cache", "dist", "build",
  "target", ".next", ".turbo", ".venv", "venv", "coverage", ".tox", ".gradle", "out",
]);
const JUNK_SUFFIX = [".pyc", ".o", ".obj", ".class", ".log", ".tmp"];

/** The class decides how long the archive keeps a target (see `reconcile`). */
function classify(real: string, isDir: boolean): "junk" | "in-git" | "user" {
  if (real.split("/").some((p) => JUNK_PARTS.has(p)) || (!isDir && JUNK_SUFFIX.some((s) => real.endsWith(s)))) {
    return "junk";
  }
  const cwd = isDir ? real : dirname(real);
  const git = (args: string[]): string => {
    try {
      return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return "";
    }
  };
  const top = git(["rev-parse", "--show-toplevel"]);
  if (top) {
    const rel = relative(top, real) || ".";
    if (git(["ls-files", "--", rel]) && !git(["status", "--porcelain", "--", rel])) return "in-git";
  }
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
    appendFileSync(join(archive, "manifest.jsonl"), JSON.stringify({ ts, ...row, cwd, argv, call }) + "\n");
  };
  let rc = 0;
  for (const t of targets) {
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
    if (isDir && !flags.has("r") && !(flags.has("d") && readdirSync(real).length === 0)) {
      err(`rm: cannot remove '${t}': Is a directory`);
      rc = 1;
      continue;
    }
    if (SYSTEM.has(real) || real === realpathSync(homedir()) || under(archive, real)) {
      err(`rm: refusing '${t}': root, home, a system directory or an ancestor of the archive`);
      log({ action: "refused", orig: real, reason: "root, home, system directory or archive ancestor" });
      rc = 1;
      continue;
    }
    if (under(real, archive)) {
      err(`rm: '${t}' is already in the archive — prune it with: bastra archive prune`);
      log({ action: "refused", orig: real, reason: "already in the archive" });
      rc = 1;
      continue;
    }
    if (eph.some((r) => under(real, r))) {
      rmSync(real, { recursive: true, force: true });
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
    const dest = join(root, ts.slice(0, 10), `${ts.slice(11).replace(/:/g, "")}-${process.pid}`, real.replace(/^\/+/, ""));
    mkdirSync(dirname(dest), { recursive: true });
    const kind = classify(real, isDir);
    const bytes = sizeOf(real);
    try {
      renameSync(real, dest);
    } catch (e) {
      err(`rm: '${t}' not moved to the archive: ${(e as Error).message}`);
      log({ action: "refused", orig: real, reason: (e as Error).message });
      rc = 1;
      continue;
    }
    log({ action: "archived", orig: real, dest, kind, bytes });
    if (flags.has("v")) out(`archived '${t}' → ${dest}`);
  }
  return rc;
}

// ─── Reading the archive ─────────────────────────────────────────────

export function manifestRows(env: NodeJS.ProcessEnv = process.env): ManifestRow[] {
  let text: string;
  try {
    text = readFileSync(join(archiveRoot(env), "manifest.jsonl"), "utf8");
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

/** What `rm` did in one tool call — the PostToolUse receipt (null: nothing recorded). */
export function callReport(call: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!call) return null;
  const rows = manifestRows(env).filter((r) => r.call === call);
  if (rows.length === 0) return null;
  const lines = rows.map((r) =>
    r.action === "archived"
      ? `- archived ${r.orig} → ${r.dest} (restore: \`bastra archive restore ${r.orig}\`)`
      : r.action === "deleted"
        ? `- deleted for real (temp): ${r.orig}`
        : `- refused, left in place: ${r.orig} (${r.reason})`,
  );
  return `What \`rm\` did in this command (bastra archiving rm):\n${lines.join("\n")}`;
}

export function restore(target: string, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  const want = resolve(cwd, target);
  const hit = [...manifestRows(env)]
    .reverse()
    .find((r) => r.action === "archived" && r.dest && (r.orig === want || r.dest === want) && existsSync(r.dest));
  if (!hit || !hit.dest) throw new Error(`nothing live in the archive for ${want}`);
  if (existsSync(hit.orig)) throw new Error(`${hit.orig} exists — not overwriting; move it away and retry`);
  mkdirSync(dirname(hit.orig), { recursive: true });
  renameSync(hit.dest, hit.orig);
  return hit.orig;
}

const RETAIN_DAYS = { junk: 1, "in-git": 7, user: 30 } as const;
/** The size cap never drops a user target younger than this. */
const USER_FLOOR_DAYS = 7;

function sameFile(a: string, b: string): boolean {
  try {
    const sa = lstatSync(a);
    const sb = lstatSync(b);
    if (!sa.isFile() || !sb.isFile() || sa.size !== sb.size) return false;
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
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
 * the same content; a target older than its class keeps (junk 1 day, in-git 7,
 * user 30); then, over the size cap, junk before in-git — never a user target
 * younger than 7 days.
 */
export function reconcilePlan(now: Date, capBytes: number, env: NodeJS.ProcessEnv = process.env): Drop[] {
  const live = manifestRows(env).filter((r) => r.action === "archived" && r.dest && existsSync(r.dest));
  const drop: Drop[] = [];
  const keep: Array<ManifestRow & { age: number }> = [];
  for (const r of live) {
    const age = (now.getTime() - new Date(r.ts).getTime()) / 86_400_000;
    const kind = r.kind ?? "user";
    const base = { orig: r.orig, dest: r.dest as string, kind, bytes: r.bytes ?? 0 };
    if (sameFile(r.orig, r.dest as string)) drop.push({ ...base, why: "came back with the same content" });
    else if (age > RETAIN_DAYS[kind]) drop.push({ ...base, why: `${kind} older than ${RETAIN_DAYS[kind]} days` });
    else keep.push({ ...r, age });
  }
  let total = keep.reduce((s, r) => s + (r.bytes ?? 0), 0);
  const rank = { junk: 0, "in-git": 1, user: 2 };
  for (const r of keep.sort((a, b) => rank[a.kind ?? "user"] - rank[b.kind ?? "user"] || b.age - a.age)) {
    if (total <= capBytes) break;
    if ((r.kind ?? "user") === "user" && r.age < USER_FLOOR_DAYS) continue;
    drop.push({ orig: r.orig, dest: r.dest as string, kind: r.kind ?? "user", bytes: r.bytes ?? 0, why: "archive size cap" });
    total -= r.bytes ?? 0;
  }
  return drop;
}

export function applyReconcile(drop: Drop[], env: NodeJS.ProcessEnv = process.env): void {
  writeFileSync(join(archiveRoot(env), ".reconcile-stamp"), new Date().toISOString() + "\n");
  for (const d of drop) rmSync(d.dest, { recursive: true, force: true });
}

/** True when the last reconcile ran more than a day ago (or never). */
export function reconcileDue(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return Date.now() - statSync(join(archiveRoot(env), ".reconcile-stamp")).mtimeMs > 86_400_000;
  } catch {
    return manifestRows(env).length > 0;
  }
}
