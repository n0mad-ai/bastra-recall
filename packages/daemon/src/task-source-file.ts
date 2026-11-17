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
    if (process.platform === "linux" && (await readlink(`/proc/self/fd/${handle.fd}`)) !== path)
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

/** Read a whole source within a byte budget (#1515 B6: below task freshness and local state). */
export async function boundedTaskRead(
  path: string,
  max: number,
  strictUtf8 = false,
  singleLink = false
): Promise<string> {
  const handle = await openTaskSourceFile(path);
  try {
    const info = await handle.stat(); // openTaskSourceFile already requires a regular file
    if (singleLink && info.nlink !== 1) throw new Error("source has multiple hard links");
    if (info.size > max) throw Object.assign(new Error("source byte budget"), { code: "source_budget" });
    const bytes = Buffer.alloc(max + 1);
    const result = await handle.read(bytes, 0, bytes.length, 0);
    if (result.bytesRead > max) throw Object.assign(new Error("source byte budget"), { code: "source_budget" });
    return strictUtf8
      ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, result.bytesRead))
      : bytes.subarray(0, result.bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}
