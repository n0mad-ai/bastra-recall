/**
 * `--archive` for the eval runners (#503).
 *
 * A runner writes its artefact to `--out`, and `--out` is often a session
 * scratchpad that is gone a few hours later. On 2026-09-09 that cost the
 * evidence of a finished measurement: a report cited a file only its author
 * could still open. Archiving copies the artefact to a durable place outside
 * the session, records a sha256 per file and prints the path, so a report can
 * cite something that exists for a reviewer too.
 *
 * Layout: `~/.bastra/<harness>-runs/<YYYY-MM-DD>/`, the shape #500 and #501
 * filed by hand. Deliberately not `~/.bastra/eval-runs`, which holds the
 * registered gold-set baselines (#446). `BASTRA_EVAL_ARCHIVE_DIR` replaces
 * `~/.bastra` as the root.
 *
 * An archived file is never overwritten: a second artefact of the same name on
 * the same day gets a time prefix. `SHA256SUMS` in the day directory gains one
 * `<sha256>  <file>` line per archived file, the format `shasum -c` reads.
 */
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, constants, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const CHECKSUM_FILE = "SHA256SUMS";

export interface ArchivedFile {
  path: string;
  sha256: string;
}

export function archiveRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.BASTRA_EVAL_ARCHIVE_DIR || join(homedir(), ".bastra");
}

/**
 * Copy `files` into `<root>/<harness>-runs/<day>/` and record their hashes.
 * Returns where each file landed, with its sha256.
 */
export function archiveArtifacts(
  harness: string,
  files: readonly string[],
  opts: { root?: string; now?: Date } = {}
): { dir: string; files: ArchivedFile[] } {
  const now = opts.now ?? new Date();
  const dir = join(opts.root ?? archiveRoot(), `${harness}-runs`, now.toISOString().slice(0, 10));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = now.toISOString().slice(11, 19).replaceAll(":", "");
  const out: ArchivedFile[] = [];
  for (const src of files) {
    let name = basename(src);
    if (name.toUpperCase() === CHECKSUM_FILE || existsSync(join(dir, name))) name = `${stamp}-${name}`;
    const target = join(dir, name);
    // COPYFILE_EXCL: a name collision that survived the prefix fails loudly
    // instead of replacing filed evidence.
    copyFileSync(src, target, constants.COPYFILE_EXCL);
    out.push(...recordChecksums(dir, [name]));
  }
  return { dir, files: out };
}

/**
 * Append `<sha256>  <name>` for each named file in `dir` to `dir/SHA256SUMS`.
 * The gold-set runner uses it for the artefact directory it already writes.
 */
export function recordChecksums(dir: string, names: readonly string[]): ArchivedFile[] {
  return names.map((name) => {
    const path = join(dir, name);
    const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
    appendFileSync(join(dir, CHECKSUM_FILE), `${sha256}  ${name}\n`, { mode: 0o600 });
    return { path, sha256 };
  });
}

/**
 * Take `--archive` out of a runner's argv before its own flag loop, and refuse
 * it without `--out` (there is nothing to file). Kept here so each runner's
 * parser stays as it was.
 */
export function takeArchiveFlag(argv: readonly string[]): { archive: boolean; rest: string[] } {
  const rest = argv.filter((a) => a !== "--archive");
  const archive = rest.length !== argv.length;
  if (archive && !rest.includes("--out")) throw new Error("--archive files the --out artefact, so it needs --out");
  return { archive, rest };
}

/**
 * What a runner calls after writing `--out`: archive when `--archive` was
 * given, and print each archived path with its hash so it lands in the log.
 */
export function archiveIfRequested(requested: boolean, harness: string, files: readonly string[]): void {
  if (!requested) return;
  for (const f of archiveArtifacts(harness, files).files)
    console.error(`[${harness}] archived ${f.path} sha256 ${f.sha256}`);
}
