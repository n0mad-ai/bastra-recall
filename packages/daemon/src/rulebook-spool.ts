/** Stdlib-only fail-open accounting, including when the daemon cannot answer.
 * One exclusive file per observation avoids cross-process append/drain races. */
import { mkdir, writeFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { defaultHookStateDir, privateDirState, readPrivateFile } from "./private-state-dir.js";
const base = () => process.env.BASTRA_HOOK_STATE_DIR || defaultHookStateDir();
const directory = () => join(base(), "rulebook-failures");
/** Linux shares tmpdir: a spool another account owns or may write is not used. */
const privateSpool = async (): Promise<boolean> =>
  (await privateDirState(base())) === "private" && (await privateDirState(directory())) === "private";
const key = (sid: string | null) =>
  createHash("sha256")
    .update(sid ?? "unattributed")
    .digest("hex")
    .slice(0, 24);
export async function spoolRulebookFailure(sid: string | null, count = 1): Promise<void> {
  try {
    const dir = directory();
    // Check the base before creating anything below it: a recursive mkdir
    // through a planted symlink would create the spool wherever it points.
    await mkdir(base(), { recursive: true, mode: 0o700 });
    if ((await privateDirState(base())) !== "private") return;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if (!(await privateSpool())) return;
    await writeFile(join(dir, `${key(sid)}-${randomUUID()}.json`), JSON.stringify({ count }), {
      mode: 0o600,
      flag: "wx",
    });
  } catch {
    /* observable only while local storage works */
  }
}
export async function drainRulebookFailures(sid: string): Promise<number> {
  let count = 0;
  try {
    const dir = directory();
    if (!(await privateSpool())) return 0;
    for (const name of await readdir(dir)) {
      if (!name.startsWith(key(sid) + "-") && !name.startsWith(key(null) + "-")) continue;
      if (!/^[a-f0-9]{24}-[a-f0-9-]{36}\.json$/.test(name)) continue;
      try {
        const path = join(dir, name),
          row = JSON.parse((await readPrivateFile(path, 4096)).bytes.toString("utf8"));
        await unlink(path);
        if (Number.isSafeInteger(row.count) && row.count > 0) count += row.count;
      } catch {
        /* another prompt drained it */
      }
    }
  } catch {
    /* no spool */
  }
  return count;
}
