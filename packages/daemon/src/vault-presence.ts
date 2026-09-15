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
 */
import { statSync } from "node:fs";

export function missingVaultReason(vaultPath: string | undefined | null): string | null {
  if (!vaultPath) return null;
  try {
    if (statSync(vaultPath).isDirectory()) return null;
    return `the vault path ${vaultPath} is not a directory`;
  } catch {
    return (
      `the vault path ${vaultPath} does not exist — nothing has been saved there yet, ` +
      `or the path is wrong, or the drive holding it is not mounted`
    );
  }
}
