/**
 * #1485 — identify sync conflict copies by filename once the vault has found
 * two files carrying the same memory ID.
 */
import { basename, dirname, extname } from "node:path";

// Syncthing's conflict suffix: https://docs.syncthing.net/users/syncing.html#conflicting-changes
const SYNCTHING_SUFFIX = /^\.sync-conflict-\d{8}-\d{6}-[A-Z0-9]+$/;

// Dropbox desktop adds the editor and save date: https://help.dropbox.com/organize/conflicted-copy
// Dropbox API WriteMode.update also documents undated suffixes with and without the editor:
// https://github.com/dropbox/dropbox-api-spec/blob/main/files.stone
const DROPBOX_SUFFIX = /^ \((?:.+'s conflicted copy(?: \d{4}-\d{2}-\d{2})?|conflicted copy)\)$/;

// Nextcloud desktop allows an optional username before the timestamp:
// https://docs.nextcloud.com/server/latest/user_manual/en/desktop/conflicts.html
// https://github.com/nextcloud/desktop/blob/master/src/common/utility.cpp#L478-L496
const NEXTCLOUD_SUFFIX = /^ \(conflicted copy (?:[^()\r\n]+ )?\d{4}-\d{2}-\d{2} \d{6}\)$/;

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

/** True when `copyPath` matches a supported conflict filename for `originalPath`. */
export function isConflictCopyName(copyPath: string, originalPath: string): boolean {
  if (!extendsName(copyPath, originalPath)) return false;
  const ext = extname(originalPath);
  const suffix = basename(copyPath, ext).slice(basename(originalPath, ext).length);
  return SYNCTHING_SUFFIX.test(suffix) || DROPBOX_SUFFIX.test(suffix) || NEXTCLOUD_SUFFIX.test(suffix);
}

/** One conflict copy: the file that holds the id twice, and the original it copies. */
export interface ConflictCopy {
  id: string;
  copy: string;
  original: string;
}
