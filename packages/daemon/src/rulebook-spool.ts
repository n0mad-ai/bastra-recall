/** Stdlib-only fail-open accounting, including when the daemon cannot answer.
 * One exclusive file per observation avoids cross-process append/drain races. */
import { mkdir, writeFile, readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
const directory = () => join(process.env.BASTRA_HOOK_STATE_DIR || join(tmpdir(), "bastra-hook"), "rulebook-failures");
const key = (sid: string | null) => createHash("sha256").update(sid ?? "unattributed").digest("hex").slice(0, 24);
export async function spoolRulebookFailure(sid: string | null, count = 1): Promise<void> {
  try { const dir = directory(); await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, `${key(sid)}-${randomUUID()}.json`), JSON.stringify({ count }), { mode: 0o600, flag: "wx" });
  } catch { /* observable only while local storage works */ }
}
export async function drainRulebookFailures(sid: string): Promise<number> {
  let count = 0;
  try { const dir = directory(); for (const name of await readdir(dir)) {
    if (!name.startsWith(key(sid) + "-") && !name.startsWith(key(null) + "-")) continue;
    if (!/^[a-f0-9]{24}-[a-f0-9-]{36}\.json$/.test(name)) continue;
    try { const path = join(dir, name), row = JSON.parse(await readFile(path, "utf8"));
      await unlink(path); if (Number.isSafeInteger(row.count) && row.count > 0) count += row.count;
    } catch { /* another prompt drained it */ }
  } } catch { /* no spool */ }
  return count;
}
