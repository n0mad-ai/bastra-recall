import { closeSync, constants, fstatSync, openSync, readlinkSync } from "node:fs";
import { open, readlink, type FileHandle } from "node:fs/promises";

// Darwin's O_NOFOLLOW_ANY is not exposed by Node's fs.constants.
// https://github.com/apple/darwin-xnu/blob/main/bsd/sys/fcntl.h
// Darwin rejects combining O_NOFOLLOW_ANY and O_NOFOLLOW (EINVAL).
const noFollow = process.platform === "darwin" ? 0x20000000 : constants.O_NOFOLLOW;
const flags = constants.O_RDONLY | noFollow | (constants.O_NONBLOCK ?? 0);

/** Open a canonical path (checked source/target or own data), without reading
 * special files or following a swapped parent symlink on macOS/Linux. Other
 * platforms retain the final-component check without descriptor containment. */
export async function openTaskSourceFile(path: string): Promise<FileHandle> {
  const handle = await open(path, flags);
  try {
    if (!(await handle.stat()).isFile()) throw new Error("source is not a regular file");
    // Bind the actual opened inode, not a second lookup of the attacker-owned
    // path. A swap back after open cannot change /proc/self/fd's target.
    if (process.platform === "linux" && await readlink(`/proc/self/fd/${handle.fd}`) !== path)
      throw new Error("source descriptor escaped");
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** Synchronous twin for the final execute CAS, which must not await (#1213). */
export function openTaskSourceFileSync(path: string): number {
  const fd = openSync(path, flags);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("source is not a regular file");
    if (process.platform === "linux" && readlinkSync(`/proc/self/fd/${fd}`) !== path)
      throw new Error("source descriptor escaped");
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}
