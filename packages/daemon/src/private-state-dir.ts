/** Hook state below `tmpdir()` is shared between accounts on Linux. It is only
 * read from a directory this account owns and nobody else may write, and only
 * through one descriptor that cannot follow a symlink or wait on a FIFO.
 * Stdlib-only: the hook stub loads modules that import this. Windows reports
 * no uid and no POSIX mode bits; there only the file type is checked. */
import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";

const ownUid = (): number | undefined => process.getuid?.();

function ownedBySelf(info: Stats): boolean {
  const uid = ownUid();
  return uid === undefined || info.uid === uid;
}

/** "absent" when the directory does not exist yet, "unsafe" for a symlink, a
 * non-directory, another owner or group/other write permission. */
export async function privateDirState(dir: string): Promise<"absent" | "private" | "unsafe"> {
  let info: Stats;
  try {
    info = await lstat(dir);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unsafe";
  }
  if (!info.isDirectory() || !ownedBySelf(info)) return "unsafe";
  return ownUid() === undefined || (info.mode & 0o022) === 0 ? "private" : "unsafe";
}

/** Reads a regular file of this account up to `maxBytes`. ENOENT and ELOOP
 * (a symlink) surface with their codes; any other unsafe file throws EUNSAFE. */
export async function readPrivateFile(path: string, maxBytes: number): Promise<{ bytes: Buffer; mtimeMs: number }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || !ownedBySelf(info) || info.size > maxBytes)
      throw Object.assign(new Error(`unsafe state file: ${path}`), { code: "EUNSAFE" });
    // One spare byte proves the file did not grow past its checked size.
    const buffer = Buffer.alloc(info.size + 1);
    let length = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
      if (length > info.size) throw Object.assign(new Error(`state file grew: ${path}`), { code: "EUNSAFE" });
    }
    return { bytes: buffer.subarray(0, length), mtimeMs: info.mtimeMs };
  } finally {
    await handle.close();
  }
}
