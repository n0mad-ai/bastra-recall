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
 *
 * Escape hatch for a vault deliberately moved or deleted: create the folder
 * again (by hand), or point bastra at the new path. A present root is all the
 * guard asks for; the old entry in the marker file is then simply true again.
 */
import { mkdirSync, mkdtempSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export class VaultRootMissingError extends Error {
  readonly code = "VAULT_MISSING";
  constructor(readonly vaultRoot: string, readonly firstSeen: string | null) {
    super(
      firstSeen
        ? `the vault at ${vaultRoot} is missing — it was present before (first seen ${firstSeen}) but is not now ` +
            `(unmounted drive, dropped network share). Refusing to recreate it; remount it and retry. ` +
            `If the vault was moved or deleted on purpose, create the folder again or point bastra at the new path.`
        : `the vault at ${vaultRoot} is missing — nothing has been saved there yet, or the drive holding it is not mounted. ` +
            `Refusing to create it from here; a save creates a new vault.`,
    );
    this.name = "VaultRootMissingError";
  }
}

type RootsFile = Record<string, { first_seen: string }>;

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

function readRoots(): RootsFile {
  try {
    const parsed = JSON.parse(readFileSync(vaultRootsPath(), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as RootsFile) : {};
  } catch {
    return {};
  }
}

/** Roots this process has seen present (and recorded, as far as it could). */
const seen = new Set<string>();

/**
 * When this vault root was first seen present, from this process or the
 * marker file; null for a root never seen. A path, not an id: the question is
 * whether THIS path ever held a vault.
 */
export function vaultRootFirstSeen(vaultRoot: string): string | null {
  const key = resolve(vaultRoot);
  const entry = readRoots()[key];
  if (entry && typeof entry.first_seen === "string") return entry.first_seen;
  return seen.has(key) ? "earlier in this run" : null;
}

/**
 * Record that this vault root is present. Once per root and process; the file
 * is written only when the root is not listed yet. Best-effort: a state dir
 * that cannot be written leaves the in-process knowledge, which is what the
 * guard had before the marker existed.
 */
export function noteVaultRootPresent(vaultRoot: string): void {
  const key = resolve(vaultRoot);
  if (seen.has(key)) return;
  seen.add(key);
  try {
    const roots = readRoots();
    if (roots[key]) return;
    roots[key] = { first_seen: new Date().toISOString() };
    const path = vaultRootsPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(roots, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, path);
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
 * itself. A missing root is created only with `createRoot`, and only when it
 * was never seen present; otherwise this throws a {@link VaultRootMissingError}
 * and creates nothing.
 */
export async function ensureVaultDir(vaultRoot: string, dir: string, opts: { createRoot?: boolean } = {}): Promise<void> {
  const present = await stat(vaultRoot).then(
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
    const firstSeen = vaultRootFirstSeen(vaultRoot);
    if (firstSeen || !opts.createRoot) throw new VaultRootMissingError(vaultRoot, firstSeen);
  }
  await mkdir(dir, { recursive: true });
  noteVaultRootPresent(vaultRoot);
}
