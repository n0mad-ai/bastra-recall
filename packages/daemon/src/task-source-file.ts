import { constants } from "node:fs";
import { open, realpath, type FileHandle } from "node:fs/promises";

/** Open an already containment-checked canonical source path, without reading
 * special files or following a swapped parent symlink. Windows retains the
 * existing final-component check; it has no equivalent descriptor binding here. */
export async function openTaskSourceFile(path: string): Promise<FileHandle> {
  // Darwin's O_NOFOLLOW_ANY is not exposed by Node's fs.constants.
  // https://github.com/apple/darwin-xnu/blob/main/bsd/sys/fcntl.h
  // Darwin rejects combining O_NOFOLLOW_ANY and O_NOFOLLOW (EINVAL).
  const noFollow = process.platform === "darwin" ? 0x20000000 : constants.O_NOFOLLOW;
  const handle = await open(path, constants.O_RDONLY | noFollow | (constants.O_NONBLOCK ?? 0));
  try {
    if (!(await handle.stat()).isFile()) throw new Error("source is not a regular file");
    // Bind the actual opened inode, not a second lookup of the attacker-owned
    // path. A swap back after open cannot change /proc/self/fd's target.
    if (process.platform === "linux" && await realpath(`/proc/self/fd/${handle.fd}`) !== path)
      throw new Error("source descriptor escaped");
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}
