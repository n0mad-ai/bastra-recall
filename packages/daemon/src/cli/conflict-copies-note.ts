/**
 * #1485 — `bastra doctor` names the sync-service conflict copies in the vault.
 * Read-only: the vault already keeps the copy out of the index and the
 * original in it (`Vault.conflictCopies`); which version is right only the
 * user can say, so nothing is merged or deleted here.
 */
import { relative } from "node:path";
import { Vault, type ConflictCopy } from "@bastra-recall/core";

/** At most this many pairs are listed; the count is always complete. */
const LISTED = 10;

export function conflictCopyLines(vaultPath: string, copies: readonly ConflictCopy[]): string[] {
  if (copies.length === 0) return [];
  const rel = (p: string) => relative(vaultPath, p);
  return [
    `${copies.length} sync conflict ${copies.length === 1 ? "copy" : "copies"} found — not indexed; the original is used. ` +
      `Compare each pair, keep what is right in the original, then remove the copy.`,
    ...copies.slice(0, LISTED).map((c) => `${rel(c.copy)}  (copy of ${rel(c.original)}, id '${c.id}')`),
    ...(copies.length > LISTED ? [`… and ${copies.length - LISTED} more`] : []),
  ];
}

export async function printConflictCopiesNote(vaultPath: string): Promise<void> {
  const vault = new Vault(vaultPath);
  try {
    await vault.init();
    const lines = conflictCopyLines(vaultPath, vault.conflictCopies());
    if (lines.length === 0) return;
    process.stdout.write("→ sync conflict copies\n");
    for (const line of lines) process.stdout.write(`  ${line}\n`);
  } catch {
    // A vault that cannot be read is reported by the vault checks above.
  } finally {
    await vault.stop();
  }
}
