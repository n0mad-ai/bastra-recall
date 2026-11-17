/**
 * #1604: lock, marker and small state files are read through ONE
 * descriptor that cannot follow a symlink (O_NOFOLLOW) or wait on a FIFO
 * (O_NONBLOCK). Only a regular file is read, and at most `maxBytes` — a plain
 * readFile on a FIFO planted at a lock path would hang the writer forever.
 * Same pattern as the daemon's path-lock.ts and private-state-dir.ts, which
 * core cannot import.
 *
 * Errors: ENOENT and ELOOP (a symlink) keep their codes; a FIFO, device,
 * socket or oversized file throws with code EUNSAFE, a directory with EISDIR
 * (as a plain readFile would). Windows has
 * neither flag; there a symlink is followed and only the file type is checked.
 */
import { constants } from "node:fs";
import { open } from "node:fs/promises";

/** Claims, markers and caches are a few hundred bytes of JSON. */
export const SMALL_FILE_MAX_BYTES = 64 * 1024;

/** open() flags that neither follow a symlink nor wait on a FIFO. */
export const NO_WAIT_READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/** readFile options with the same flags, for a read by path whose callers
 *  already treat any error or unparsable text as "not ours": a FIFO there
 *  reads as empty (or EAGAIN) at once instead of blocking. */
export const NO_WAIT_TEXT = { encoding: "utf8", flag: NO_WAIT_READ_FLAGS } as const;

export async function readRegularFile(
  path: string,
  maxBytes = SMALL_FILE_MAX_BYTES
): Promise<{ raw: string; mtimeMs: number; mode: number }> {
  const handle = await open(path, NO_WAIT_READ_FLAGS);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes)
      throw Object.assign(
        new Error(`not a regular file${Number.isFinite(maxBytes) ? ` within ${maxBytes} bytes` : ""}: ${path}`),
        // #1620: a directory keeps the code a plain readFile gave it (EISDIR).
        { code: info.isDirectory() ? "EISDIR" : "EUNSAFE" }
      );
    // A regular file within the bound: read it from this same descriptor, and
    // refuse it if it grew past the bound meanwhile.
    const raw = await handle.readFile("utf8");
    if (Buffer.byteLength(raw) > maxBytes)
      throw Object.assign(new Error(`file grew while read: ${path}`), { code: "EUNSAFE" });
    return { raw, mtimeMs: info.mtimeMs, mode: info.mode & 0o777 };
  } finally {
    await handle.close();
  }
}
