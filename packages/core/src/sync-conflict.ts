/**
 * #1485 — conflict copies of a sync service, recognised by the documented
 * shape of the name, not by its words.
 *
 * Only Syncthing documents its pattern
 * (https://docs.syncthing.net/users/syncing.html, "Conflicting Changes"):
 * `<filename>.sync-conflict-<date>-<time>-<modifiedBy>.<ext>`, e.g.
 * `Alpha.sync-conflict-20261117-101500-ABCDEF1.md`. It holds no translated
 * words. Other services (Dropbox, Nextcloud, OneDrive, iCloud, Google Drive)
 * do not document a pattern in their primary docs, so they are deliberately
 * not guessed here.
 *
 * The name alone is not enough: it counts only together with the second fact
 * every conflict copy has — it carries the SAME memory id as the original,
 * because it is a copy of the same file. The vault already knows that pair
 * (two files, one id); this tells it which of the two is the copy.
 */
import { basename, dirname, extname } from "node:path";

/** What Syncthing appends to the name: `.sync-conflict-<YYYYMMDD>-<HHMMSS>-<device>`. */
const SYNCTHING_SUFFIX = /^\.sync-conflict-\d{8}-\d{6}-[A-Z0-9]+$/;

/**
 * True when `longerPath` sits next to `shorterPath` with the same extension
 * and its name (without extension) properly extends the other's —
 * `Alpha (1).md` next to `Alpha.md`. Purely structural, no words, no service
 * names. Used only to decide which of two files with ONE memory id keeps the
 * index entry: the shorter name, the original a copy was made from.
 */
export function extendsName(longerPath: string, shorterPath: string): boolean {
  if (dirname(longerPath) !== dirname(shorterPath)) return false;
  const ext = extname(shorterPath);
  if (extname(longerPath) !== ext) return false;
  const shorter = basename(shorterPath, ext);
  const longer = basename(longerPath, ext);
  return longer.length > shorter.length && longer.startsWith(shorter);
}

/** True when `copyPath` is a Syncthing conflict copy of `originalPath`. */
export function isConflictCopyName(copyPath: string, originalPath: string): boolean {
  if (dirname(copyPath) !== dirname(originalPath)) return false;
  const ext = extname(originalPath);
  if (extname(copyPath) !== ext) return false;
  const original = basename(originalPath, ext);
  const copy = basename(copyPath, ext);
  return copy.startsWith(original) && SYNCTHING_SUFFIX.test(copy.slice(original.length));
}

/** One conflict copy: the file that holds the id twice, and the original it copies. */
export interface ConflictCopy {
  id: string;
  copy: string;
  original: string;
}
