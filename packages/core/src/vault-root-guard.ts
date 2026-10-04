/**
 * #892: the one guard every writer under the vault root goes through before it
 * creates a directory there.
 *
 * `mkdir(dir, { recursive: true })` under a vault whose drive is not mounted
 * does not fail: it recreates the whole path, root included, on the parent
 * filesystem. From then on the vault "exists" again, empty, and `/health` and
 * recall stop reporting `vault_missing` — while every memory is on the drive
 * that is not there. The vault lives on a cloud mount (Google Drive) for real
 * users, and a daemon started at login can come up before that mount does.
 *
 * So the decisive question is "has this vault root ever been present?", and it
 * has to survive a restart. A marker inside the vault would vanish with the
 * mount, so the answer lives OUTSIDE it, in the daemon's own state:
 * `~/.bastra/vault-roots.json` maps each vault path to when it was first seen
 * present. A root that is missing now but listed there is a missing mount, and
 * nothing is created. A root never seen is a vault that does not exist yet:
 * only a writer that legitimately makes a vault (a save, `createVaultAt`)
 * passes `createRoot` and may create it; the side writers (locks, audit log,
 * usage sidecar, curator state, embeddings, journals, documents) never do.
 * Even then the root is made non-recursively, only under a parent that
 * exists: on a machine that never saw the path, a missing parent is the
 * likeliest sign of an unmounted drive, so the first save stops instead of
 * building the path on the boot disk. `createVaultAt` (install, wizard) makes
 * the parent chain itself first — the user named that path explicitly.
 *
 * Escape hatch for a vault deliberately moved or deleted: create the folder
 * again (by hand), or point bastra at the new path. A present root is all the
 * guard asks for; the old entry in the marker file is then simply true again.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export class VaultRootMissingError extends Error {
  readonly code = "VAULT_MISSING";
  constructor(readonly vaultRoot: string, readonly firstSeen: string | null, missingParent?: string) {
    super(
      missingParent
        ? `the vault at ${vaultRoot} cannot be created: its parent directory ${missingParent} does not exist ` +
            `(often a drive that is not mounted). Refusing to create the path; mount the drive or create the parent directory first.`
        : firstSeen
        ? `the vault at ${vaultRoot} is missing — it was present before (first seen ${firstSeen}) but is not now ` +
            `(unmounted drive, dropped network share). Refusing to recreate it; remount it and retry. ` +
            `If the vault was moved or deleted on purpose, create the folder again or point bastra at the new path.`
        : `the vault at ${vaultRoot} is missing — nothing has been saved there yet, or the drive holding it is not mounted. ` +
            `Refusing to create it from here; a save creates a new vault.`,
    );
    this.name = "VaultRootMissingError";
  }
}

export type VaultRootHistoryCause = "corrupt" | "unwritable" | "unknown";

/** Two sentences: the marker file, the cause (when known) and the repair. */
export class VaultRootHistoryError extends Error {
  readonly code = "VAULT_ROOT_HISTORY_UNAVAILABLE";
  constructor(readonly markerPath: string, readonly cause: VaultRootHistoryCause = "unknown") {
    const dir = dirname(markerPath);
    super(
      cause === "corrupt"
        ? `Bastra refuses every vault write: the vault-root history ${markerPath} is empty or corrupt. If the vault is mounted, delete that file; it is rewritten on the next save.`
        : cause === "unwritable"
        ? `Bastra refuses every vault write: the vault-root history ${markerPath} cannot be written. Fix the permissions of ${dir}; the file is rewritten on the next save.`
        : `Bastra refuses every vault write: the vault-root history ${markerPath} is empty or corrupt, or ${dir} is not writable. If the vault is mounted, delete that file (it is rewritten on the next save); otherwise fix the permissions of ${dir}.`,
    );
    this.name = "VaultRootHistoryError";
  }
}

type RootEntry = { first_seen: string };

/**
 * A test process that did not choose a marker file gets a throwaway one, so a
 * suite run never writes its temp vaults into the developer's `~/.bastra` —
 * the same `NODE_TEST_CONTEXT` default as the daemon's `testRunLogDir()`.
 */
let testRootsPath: string | undefined;
export function vaultRootsPath(): string {
  const chosen = process.env.BASTRA_VAULT_ROOTS_PATH;
  if (chosen) return chosen;
  if (process.env.NODE_TEST_CONTEXT) {
    testRootsPath ??= join(mkdtempSync(join(tmpdir(), "bastra-test-vault-roots-")), "vault-roots.json");
    return testRootsPath;
  }
  return join(homedir(), ".bastra", "vault-roots.json");
}

/** Null means unreadable or corrupt; only ENOENT means no history yet. */
function readRoots(): Map<string, RootEntry> | null {
  let raw: string;
  try {
    raw = readFileSync(vaultRootsPath(), "utf8");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? new Map() : null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const roots = new Map<string, RootEntry>();
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object" || typeof (value as RootEntry).first_seen !== "string") return null;
      roots.set(key, { first_seen: (value as RootEntry).first_seen });
    }
    return roots;
  } catch {
    return null;
  }
}

/** Why {@link readRoots} returned null: a file that reads fine but does not
 * parse is corrupt; a read that fails (not ENOENT) leaves the cause open. */
function historyReadError(): VaultRootHistoryError {
  let cause: VaultRootHistoryCause = "corrupt";
  try {
    readFileSync(vaultRootsPath(), "utf8");
  } catch {
    cause = "unknown";
  }
  return new VaultRootHistoryError(vaultRootsPath(), cause);
}

/** Throws the guard's {@link VaultRootHistoryError} when the root history is
 * unreadable or corrupt — for a caller that must stop before its own writes. */
export function assertVaultRootHistory(): void {
  if (!readRoots()) throw historyReadError();
}

/** Roots this process has seen present (and recorded, as far as it could). */
const seen = new Set<string>();
const persisted = new Set<string>();

/** A missing path may have been recorded with another spelling on a
 * case-insensitive macOS/Windows volume. False STOP on a case-sensitive volume
 * is safer than recreating a known vault on its unmounted parent filesystem. */
function sameRootKey(a: string, b: string): boolean {
  return a === b || ((process.platform === "darwin" || process.platform === "win32") && a.toLowerCase() === b.toLowerCase());
}

function firstSeenIn(roots: Map<string, RootEntry>, key: string): string | null {
  for (const [stored, entry] of roots) if (sameRootKey(stored, key)) return entry.first_seen;
  return null;
}

function seenThisRun(key: string): boolean {
  for (const stored of seen) if (sameRootKey(stored, key)) return true;
  return false;
}

/** Temporary library/benchmark vaults have process-local history, never an
 * implicit write to the user's home. An explicit marker keeps durable history
 * even there (as does the isolated test runner). Compare physical paths so a
 * symlink under /tmp onto a persistent vault still gets recorded. */
function persistsRoot(root: string): boolean {
  if (process.env.BASTRA_VAULT_ROOTS_PATH || process.env.NODE_TEST_CONTEXT) return true;
  const physical = (path: string): string => {
    try { return realpathSync(path); } catch { return resolve(path); }
  };
  const key = physical(root);
  const tempRoots = [tmpdir(), ...(process.platform === "win32" ? [] : ["/tmp"])];
  return !tempRoots.some((dir) => {
    const temp = physical(dir);
    if (dirname(temp) === temp) return false; // TMPDIR=/ must not disable all history
    const child = relative(temp, key);
    return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
  });
}

/**
 * When this vault root was first seen present, from this process or the
 * marker file; null for a root never seen. A path, not an id: the question is
 * whether THIS path ever held a vault.
 */
export function vaultRootFirstSeen(vaultRoot: string): string | null {
  const key = resolve(vaultRoot);
  const roots = readRoots();
  return (roots && firstSeenIn(roots, key)) || (seenThisRun(key) ? "earlier in this run" : null);
}

/**
 * Record that this vault root is present. Once per root and process; the file
 * is written only when the root is not listed yet. Best-effort: a state dir
 * that cannot be written leaves the in-process knowledge, which is what the
 * guard had before the marker existed.
 */
export function noteVaultRootPresent(vaultRoot: string): void {
  const key = resolve(vaultRoot);
  seen.add(key);
  if (persisted.has(key)) return;
  if (!persistsRoot(key)) return;
  try {
    const roots = readRoots();
    if (!roots) return; // never overwrite a corrupt history with one entry
    if (roots.has(key)) { persisted.add(key); return; }
    roots.set(key, { first_seen: new Date().toISOString() });
    const path = vaultRootsPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(roots), null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, path);
    persisted.add(key);
  } catch {
    /* best-effort, see above */
  }
}

/** True when the root is a directory right now; records it when it is. */
export function vaultRootPresent(vaultRoot: string): boolean {
  try {
    if (!statSync(vaultRoot).isDirectory()) return false;
  } catch {
    return false;
  }
  noteVaultRootPresent(vaultRoot);
  return true;
}

/**
 * Create `dir` (recursively) under `vaultRoot` — the replacement for every
 * `mkdir(dir, { recursive: true })` under the vault. `dir` may be the root
 * itself. A missing root is created only with `createRoot`, only when it was
 * never seen present, and only when its parent directory exists; otherwise
 * this throws a {@link VaultRootMissingError} and creates nothing.
 */
export async function ensureVaultDir(vaultRoot: string, dir: string, opts: { createRoot?: boolean } = {}): Promise<void> {
  const root = resolve(vaultRoot);
  const target = resolve(dir);
  const child = relative(root, target);
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error(`directory ${dir} is outside vault root ${vaultRoot}`);
  }
  const roots = readRoots();
  if (!roots) throw historyReadError();
  if (!roots.has(root)) persisted.delete(root); // marker removed since this process last wrote it
  const present = await stat(root).then(
    (st) => {
      if (!st.isDirectory()) throw new Error(`the vault path ${vaultRoot} is not a directory`);
      return true;
    },
    (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT" || err.code === "ENOTDIR") return false;
      throw err;
    },
  );
  if (!present) {
    const firstSeen = firstSeenIn(roots, root) ?? (seenThisRun(root) ? "earlier in this run" : null);
    if (firstSeen || !opts.createRoot) throw new VaultRootMissingError(vaultRoot, firstSeen);
    // Only this explicit first-create path may make the root, and only one
    // level: a missing parent is an unmounted drive until proven otherwise.
    try {
      await mkdir(root);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new VaultRootMissingError(vaultRoot, null, dirname(root));
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  // Non-recursive children cannot recreate the root if its mount vanishes
  // between the stat above and a later mkdir.
  let current = root;
  for (const part of child ? child.split(sep) : []) {
    current = join(current, part);
    try {
      await mkdir(current);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new VaultRootMissingError(vaultRoot, vaultRootFirstSeen(vaultRoot));
      if ((err as NodeJS.ErrnoException).code !== "EEXIST" || !(await stat(current)).isDirectory()) throw err;
    }
  }
  if (!(await stat(root).catch(() => null))?.isDirectory()) {
    throw new VaultRootMissingError(vaultRoot, vaultRootFirstSeen(vaultRoot));
  }
  noteVaultRootPresent(root);
  if (persistsRoot(root) && !readRoots()?.has(root)) throw new VaultRootHistoryError(vaultRootsPath(), "unwritable");
}
