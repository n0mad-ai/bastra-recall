/**
 * #1485 — `bastra doctor` names the sync-service conflict copies in the vault.
 * Read-only: the vault already keeps the copy out of the index and the
 * original in it (`Vault.conflictCopies`); which version is right only the
 * user can say, so nothing is merged or deleted here.
 */
import { relative } from "node:path";
import { Vault, type ConflictCopy } from "@bastra-recall/core";
import { doctorNotesWordsIn } from "./doctor-notes-words.js";

/** At most this many pairs are listed; the count is always complete. */
const LISTED = 10;

/** The note's lines in `language` (language.primary; English when not given, #1602). */
export function conflictCopyLines(vaultPath: string, copies: readonly ConflictCopy[], language = "en"): string[] {
  if (copies.length === 0) return [];
  const w = doctorNotesWordsIn(language);
  const rel = (p: string) => relative(vaultPath, p);
  return [
    w.conflictCount(copies.length),
    ...copies.slice(0, LISTED).map((c) => w.conflictPair(rel(c.copy), rel(c.original), c.id)),
    ...(copies.length > LISTED ? [w.andMore(copies.length - LISTED)] : []),
  ];
}

export async function printConflictCopiesNote(vaultPath: string, language = "en"): Promise<void> {
  const vault = new Vault(vaultPath);
  try {
    await vault.init();
    const lines = conflictCopyLines(vaultPath, vault.conflictCopies(), language);
    if (lines.length === 0) return;
    process.stdout.write(doctorNotesWordsIn(language).conflictHeader);
    for (const line of lines) process.stdout.write(`  ${line}\n`);
  } catch {
    // A vault that cannot be read is reported by the vault checks above.
  } finally {
    await vault.stop();
  }
}
