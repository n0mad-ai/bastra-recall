/**
 * A vault path that names nothing.
 *
 * Measured on a Windows stand: `bastra install claude-code --vault <new dir> --yes`
 * registered the path without creating it, and the daemon then answered
 * `/health` with `ok: true, vault_size: 0` and every `recall` with
 * `{ "hits": [] }` — no error, no warning. A typo, or a vault on a drive that is
 * not mounted (at boot or since), reads exactly like "memory has nothing on
 * this"; the same shape once kept a LUKS-mounted vault's daemon green at
 * `vault_size 0` for hours.
 *
 * It is NOT a boot failure: the Desktop extension defaults to a folder that is
 * "created on first save", and a daemon that refused to start could never make
 * that save. So the absence is carried on the answers instead — `/health` and
 * every `recall` — and checked live, so a vault unmounted under a running daemon
 * is named the same way.
 *
 * #892: a path that held a vault before (core's vault-root-guard.ts keeps that
 * outside the vault, so it survives a restart) is named as what it is, a vault
 * that is not mounted — and no writer recreates it, so the signal stays. A root
 * found present here is recorded, which covers a drive mounted after the start.
 */
import { statSync } from "node:fs";
import { noteVaultRootPresent, vaultRootFirstSeen } from "@bastra-recall/core";

export function missingVaultReason(vaultPath: string | undefined | null): string | null {
  if (!vaultPath) return null;
  try {
    if (!statSync(vaultPath).isDirectory()) return `the vault path ${vaultPath} is not a directory`;
    noteVaultRootPresent(vaultPath);
    return null;
  } catch {
    const firstSeen = vaultRootFirstSeen(vaultPath);
    if (firstSeen) {
      return (
        `the vault path ${vaultPath} held a vault (first seen ${firstSeen}) and is missing now — ` +
        `the drive holding it is most likely not mounted. Nothing is written until it is back; ` +
        `if the vault was moved or deleted on purpose, create the folder again or point bastra at the new path`
      );
    }
    return (
      `the vault path ${vaultPath} does not exist — nothing has been saved there yet, ` +
      `or the path is wrong, or the drive holding it is not mounted`
    );
  }
}
