/**
 * The archive on disk behind bastra's archiving `rm` (#650): where it lives,
 * that it is this user's own before anything moves in, and the manifest every
 * act is recorded in and read back from. No shell, no git: the shim, the
 * receipts and reconcile build on this module.
 */
import {
  appendFileSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { dirname, join } from "node:path";
import { bastraDataDir } from "./platform-paths.js";

/** Where the archive lives — creates nothing (the post lane asks after every Bash call). */
export function archiveDir(env: NodeJS.ProcessEnv): string {
  return env.BASTRA_ARCHIVE_DIR || join(bastraDataDir(), "archive");
}

/**
 * The archive directory, made 0700 if it is new. Throws, before anything is
 * moved, when it is not a directory of this user: another account's (say
 * BASTRA_ARCHIVE_DIR=/var/tmp) or a link another account made. There, others
 * could read the manifest or put their own files where the archive writes.
 */
export function archiveRoot(env: NodeJS.ProcessEnv = process.env, uid = myUid()): string {
  const raw = archiveDir(env);
  // Only the user reads the archive: what moves in keeps its own mode, the
  // directories around it are new and must not open it to others.
  mkdirSync(raw, { recursive: true, mode: 0o700 });
  const root = realpathSync(raw);
  const problem = rootProblem(raw, root, env, uid);
  if (problem) throw new Error(problem);
  // An archive made before 0700 stays open to others: close it once, with the
  // dated directories and manifests in it. The configured path may be a
  // symlink the user set on purpose; what is checked is where it leads.
  const wasOpen = archiveDirState(root, uid) === "open";
  if (wasOpen) chmodSync(root, 0o700);
  // Check even after an earlier refusal closed the root: chmod is not proof
  // that entries planted while it was open have been removed.
  for (const name of readdirSync(root)) {
    const p = join(root, name);
    const st = lstatSync(p);
    if (foreignEntry(st, uid)) throw new Error(foreignEntryProblem(raw, name));
    if (wasOpen && st.isDirectory()) chmodSync(p, 0o700);
    else if (wasOpen && st.isFile() && name.startsWith("manifest")) chmodSync(p, 0o600);
  }
  return root;
}

/** An entry directly in the archive that is a link or another account's. */
function foreignEntry(st: Stats, uid: number): boolean {
  return st.isSymbolicLink() || (uid >= 0 && st.uid !== uid);
}

function foreignEntryProblem(raw: string, name: string): string {
  return (
    `the archive directory '${raw}' holds '${name}', which is not yours or is a link — ` +
    "Recall does not use it. Move that entry away, or choose another directory of your own"
  );
}

/** Why the archive directory is not this user's, or null. A symlink the user
 *  made is fine (checked is where it leads); one another account made is not. */
function rootProblem(raw: string, root: string, env: NodeJS.ProcessEnv, uid: number): string | null {
  const link = lstatSync(raw);
  const foreignLink = link.isSymbolicLink() && uid >= 0 && link.uid !== uid;
  if (!foreignLink && archiveDirState(root, uid) !== "foreign") return null;
  return (
    `the archive directory '${raw}' does not belong to you (another account's directory, not a directory, ` +
    "or a link another account made), so Recall does not use it. " +
    (env.BASTRA_ARCHIVE_DIR
      ? "Set BASTRA_ARCHIVE_DIR to a directory of your own, or remove BASTRA_ARCHIVE_DIR to use the default"
      : "Make it a directory of your own (chmod 700), or set BASTRA_ARCHIVE_DIR to one")
  );
}

/** For doctor: why the archive directory would be refused, or null — the
 *  directory itself or (#1606) a link or foreign entry directly inside it, the
 *  same entries archiveRoot stops at. Creates and changes nothing; a directory
 *  that is not there yet is made 0700 on first use. */
export function archiveRootProblem(env: NodeJS.ProcessEnv = process.env, uid = myUid()): string | null {
  const raw = archiveDir(env);
  try {
    const root = realpathSync(raw);
    const problem = rootProblem(raw, root, env, uid);
    if (problem) return problem;
    for (const name of readdirSync(root)) {
      const st = lstatSync(join(root, name), { throwIfNoEntry: false });
      if (st && foreignEntry(st, uid)) return foreignEntryProblem(raw, name);
    }
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return `cannot inspect the archive directory '${raw}': ${(error as Error).message}`;
  }
}

/** The manifest is created 0600: it names every archived path. */
export function appendManifest(archive: string, line: string): void {
  appendFileSync(join(archive, "manifest.jsonl"), line, { mode: 0o600 });
}

export const under = (path: string, root: string): boolean =>
  path === root || path.startsWith(root.replace(/\/$/, "") + "/");

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

const myUid = (): number => (typeof process.getuid === "function" ? process.getuid() : -1);

/** lstat, so a symlink is "foreign": not a directory of this user. */
function archiveDirState(dir: string, uid = myUid()): "own" | "open" | "foreign" {
  const st = lstatSync(dir);
  if (!st.isDirectory() || (uid >= 0 && st.uid !== uid)) return "foreign";
  return (st.mode & 0o077) !== 0 ? "open" : "own";
}

/**
 * A volume's own `.bastra-archive` is used only if it is a real directory of
 * this user, closed to others. Its mount root can be writable by everyone
 * (Linux's tmpfs `/tmp`, `/dev/shm`): another user could have made the name
 * first, or swap an open one between a check and a chmod — so an open one is
 * refused, not taken over.
 */
export function ownArchiveDir(dir: string, uid = myUid()): boolean {
  return archiveDirState(dir, uid) === "own";
}

/** Every directory from the archive root down to `dir` is a real one of this user. */
export function ownArchivePath(root: string, dir: string, uid = myUid()): boolean {
  for (let d = dir; under(d, root) && d !== root; d = dirname(d)) {
    if (archiveDirState(d, uid) === "foreign") return false;
  }
  return true;
}

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
