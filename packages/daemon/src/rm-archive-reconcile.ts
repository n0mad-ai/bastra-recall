/**
 * What the archive lets go of, and when (#650): the retention per class, the
 * reconcile plan and its application, the hourly stamp.
 *
 * Split out of `rm-archive.ts` (file-size convention, #680): the shim and the
 * manifest readers stay there, and `rm-archive.ts` re-exports everything here,
 * so every import path stays valid.
 */
import { closeSync, constants as fsConstants, existsSync, fstatSync, openSync, readSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pinLive, unpin } from "./git-archive.js";
import { archiveDir, archiveRoot, localIso, manifestFiles, manifestRows, parseManifest, under, type ManifestRow } from "./rm-archive.js";

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

/** #934: what the archive may hold in total when no cap is configured. */
export const DEFAULT_CAP_BYTES = 10 * 2 ** 30;

/** `5GB`, `500 MB`, `1.5g`, `4096B` → bytes (1 GB = 2^30); null when malformed or zero. */
export function parseSize(spec: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*(?:([kmgt])b?|b)$/i.exec(spec.trim());
  if (!m) return null;
  const bytes = Math.round(Number(m[1]) * 2 ** (10 * ("kmgt".indexOf((m[2] ?? " ").toLowerCase()) + 1)));
  return bytes > 0 ? bytes : null;
}

/** Bytes in the largest unit with a whole part: `10 GB`, `1.5 GB`, `512 MB`. */
export function formatSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  for (; n >= 1024 && i < units.length - 1; i++) n /= 1024;
  return `${Number(n.toFixed(1))} ${units[i]}`;
}

/** #934: the total cap — 10 GB, then `bastra config set archive.cap …`, then BASTRA_ARCHIVE_CAP (env wins). */
export function archiveCap(env: NodeJS.ProcessEnv = process.env, stored?: string): number {
  return (env.BASTRA_ARCHIVE_CAP ? parseSize(env.BASTRA_ARCHIVE_CAP) : null) ?? (stored ? parseSize(stored) : null) ?? DEFAULT_CAP_BYTES;
}

/**
 * #934: the per-target limit — none by default (null), then `bastra config set
 * archive.max-item …`, then BASTRA_ARCHIVE_MAX_ITEM (env wins; `off` there
 * lifts a stored limit).
 */
export function archiveMaxItem(env: NodeJS.ProcessEnv = process.env, stored?: string): number | null {
  const fromEnv = env.BASTRA_ARCHIVE_MAX_ITEM?.trim();
  if (fromEnv === "off") return null;
  return (fromEnv ? parseSize(fromEnv) : null) ?? (stored ? parseSize(stored) : null);
}

/** Compared a chunk at a time: this runs inside the daemon, and two equal-sized
 *  files of a few GB must not become their size in memory. */
export function sameFile(a: string, b: string, chunk = 1 << 20): boolean {
  let fa = -1;
  let fb = -1;
  try {
    // Open first, then ask the open file (CodeQL js/file-system-race): what
    // is compared is what was checked. O_NOFOLLOW keeps lstat's "a symlink
    // is not a file" — opening one throws ELOOP, which is `false` below.
    fa = openSync(a, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    fb = openSync(b, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const sa = fstatSync(fa);
    const sb = fstatSync(fb);
    if (!sa.isFile() || !sb.isFile() || sa.size !== sb.size) return false;
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
  /** A git snapshot: let go of the ref (only while it still names this sha). */
  sha?: string;
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
  // Git snapshots hold uncommitted work: the user retention, and never the cap.
  for (const r of manifestRows(env)) {
    if (r.action !== "pinned" || !r.sha || !r.dest) continue;
    const age = (now.getTime() - new Date(r.ts).getTime()) / 86_400_000;
    // pinLive: a ref under refs/bastra-archive/ that is still there — nothing else.
    if (age > retain.user && pinLive(r.orig, r.dest)) {
      drop.push({ orig: r.orig, dest: r.dest, kind: "user", bytes: 0, why: `git snapshot older than ${retain.user} days`, sha: r.sha });
    }
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
  for (const d of drop) {
    if (d.sha) unpin(d.orig, d.dest, d.sha);
    else rmSync(d.dest, { recursive: true, force: true });
  }
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
    // A pin that is still there (its repository was away at every look) keeps
    // its manifest: without the row nothing would ever let the ref go.
    const live = (r: ManifestRow): boolean =>
      !!r.dest && (r.action === "archived" ? existsSync(r.dest) : r.action === "pinned" && pinLive(r.orig, r.dest));
    if (old && !parseManifest(file).some(live)) unlinkSync(file);
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
  const root = archiveDir(env);
  try {
    return now - statSync(join(root, ".reconcile-stamp")).mtimeMs > RECONCILE_EVERY_MS;
  } catch {
    return existsSync(join(root, "manifest.jsonl"));
  }
}
