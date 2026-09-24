import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { safeParse, KNOWN_ADAPTERS } from "./adapters.js";

/**
 * #530 follow-up (owner decision, 2026-09-21): when a re-import's source
 * folder has LOST a file whose memory is still in the vault, the import must
 * never remove, move or trash that memory — a vanished source file can be a
 * stuck cloud sync, not a real deletion, and the memory may since have been
 * edited or referenced by the user. It is only ever REPORTED, so a human
 * decides. `findOrphanedMemories` is the read-only detection for that report.
 */
export interface ImportVaultOrphan {
  /** The memory's id — also its filename under `folder` (`<id>.md`). */
  id: string;
  /** Absolute path of the memory file, still in place, untouched. */
  path: string;
  /** The relative source path (from `sourceDir`) that no longer exists. */
  sourcePath: string;
}

/**
 * Every memory under `<vaultRoot>/<folder>` that is a prior node of THIS
 * importer (adapter + label match its `source` stamp, #240) whose `relKey`
 * is no longer among `currentRelKeys` — i.e. the source file it came from is
 * gone from this run's scan of `sourceDir`.
 *
 * No new persistent format: the `source: "<adapter>:<label>:<relKey>"` stamp
 * every imported memory already carries (written by `buildInput` in
 * adapters.ts, read back by the importer's own ownership check) is reused
 * as-is. A stamp without a relKey (pre-provenance legacy node, #245 P1) is
 * left alone here too — its source path is unknowable, so it is neither
 * "current" nor "orphaned", just unclassifiable, same as the ownership check
 * already treats it.
 */
export async function findOrphanedMemories(
  vaultRoot: string,
  folder: string,
  label: string,
  currentRelKeys: ReadonlySet<string>,
): Promise<ImportVaultOrphan[]> {
  const orphaned: ImportVaultOrphan[] = [];
  const dir = join(vaultRoot, folder);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return orphaned; // no import folder yet (or unreadable) — nothing to report
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isFile() || extname(e.name).toLowerCase() !== ".md") continue;
    const filePath = join(dir, e.name);
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch {
      continue; // unreadable — this pass can't say anything about it
    }
    const src = safeParse(raw).data.source;
    const parts = typeof src === "string" ? src.split(":") : [];
    if (parts.length < 3 || parts[1] !== label || !KNOWN_ADAPTERS.has(parts[0])) continue;
    const sourcePath = parts.slice(2).join(":");
    if (currentRelKeys.has(sourcePath)) continue;
    orphaned.push({ id: basename(e.name, ".md"), path: filePath, sourcePath });
  }
  return orphaned;
}
