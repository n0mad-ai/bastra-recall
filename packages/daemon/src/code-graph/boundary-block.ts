/**
 * The task-boundary block: computed at Stop, delivered on the next prompt of
 * the SAME session (#572).
 *
 * WHY TWO MOMENTS. Stop is where the sum can be taken — the task's writes are
 * all booked (`SessionState.touched`, with the dependents each edit had at
 * edit time; `boundary-impact.ts` says why then and not now). But Stop has no
 * silent output channel of its own (#48), and the one it borrows,
 * `pending-suggestions.json`, is global: the next SessionStart of ANY session
 * in ANY repository takes it. That is right for "consider saving a memory" and
 * wrong for "you changed `saveMemory` and never opened `report.ts`" — the one
 * reader who can act on that is the session that made the change, while it
 * still has the change in context. So the block waits in that session's own
 * state and the prompt lane hands it over as additionalContext on the next
 * turn. A session that never gets another prompt never gets the block, which
 * is the correct outcome: nobody is left to read it.
 *
 * A BOOKING IS AN ATTEMPT UNTIL THE DISK CONFIRMS IT. The Write/Edit lane
 * fires BEFORE the tool runs; a denied or failed call is booked all the same.
 * So every booked file is checked here: modified since its first booking, or
 * gone (a delete is a write). An unconfirmed file contributes nothing — not
 * its dependents, and not itself as "opened".
 *
 * SILENCE. Kill switch, no booked writes, nothing confirmed, nothing missed,
 * the same answer already delivered this session, and an accumulator that
 * overflowed — a table that stopped recording is a prefix of the task, and a
 * confident answer from a prefix is the narrow lie this lane avoids.
 */

import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { type BoundaryTouch, type MissedDependent, boundaryImpact } from "./boundary-impact.js";
import { type CodeGraphCache } from "./cache.js";
import { codeGraphCache, repoRelative } from "./dependents-block.js";
import { codeAwarenessDisabledByEnv } from "./enabled-repos.js";
import { MAX_IMPACT_FILES, isTestFile } from "./impact-block.js";
import { MAX_SHOW, type ReadonlySessionState } from "../session-state.js";

const DEDUPE_PREFIX = "code-boundary:";
/**
 * Slack between the lane's clock and the file's mtime. The booking is stamped
 * when the hook fires, the write lands after it; the slack only covers
 * filesystems with coarse mtimes, so it is small.
 */
const MTIME_SLACK_MS = 2_000;

/** One read the transcript proves: absolute path, and when (ms), if known. */
export interface ProvenRead {
  path: string;
  at: number | null;
}

export interface BoundaryNoteOptions {
  session: ReadonlySessionState;
  /** Optional; without it nothing moves from `missed` to `seen`. */
  reads?: readonly ProvenRead[];
  /** Injectable for tests; defaults to the shared cache. */
  cache?: Pick<CodeGraphCache, "get">;
  /** Injectable for tests: mtime in ms, or null when the file is gone. */
  mtimeOf?: (absolutePath: string) => Promise<number | null>;
}

export interface BoundaryNote {
  /** The finished block. */
  note: string;
  /** Key to book under `shown` once the block has actually gone out. */
  dedupeKey: string;
  /** Missed files across every repository, before the display cap. */
  files: number;
}

/** The block for everything the session wrote so far, or silence. Never throws. */
export async function boundaryNote(opts: BoundaryNoteOptions): Promise<BoundaryNote | null> {
  try {
    return await build(opts);
  } catch {
    return null;
  }
}

async function build(opts: BoundaryNoteOptions): Promise<BoundaryNote | null> {
  if (codeAwarenessDisabledByEnv()) return null;
  const touched = opts.session.touched;
  if (touched === undefined) return null;
  if (opts.session.touchedOverflow === true) return null;
  const mtimeOf = opts.mtimeOf ?? diskMtime;

  const sections: string[] = [];
  const identity: string[] = [];
  let files = 0;

  for (const repoRoot of Object.keys(touched).sort()) {
    const touches: BoundaryTouch[] = [];
    // Dependent file -> the latest booking of any touched file that names it.
    // A read counts as "after the change" only past that moment.
    const changedAt = new Map<string, number>();
    for (const [file, entry] of Object.entries(touched[repoRoot] ?? {})) {
      const mtime = await mtimeOf(join(repoRoot, file));
      if (mtime !== null && mtime < entry.at - MTIME_SLACK_MS) continue;
      touches.push({
        file,
        hits: entry.unplaced ? null : entry.hits,
        truncated: entry.truncated,
        gone: mtime === null,
      });
      for (const hit of entry.hits) {
        changedAt.set(hit.file, Math.max(changedAt.get(hit.file) ?? 0, entry.last));
      }
    }
    if (touches.length === 0) continue;

    const readAfter: string[] = [];
    for (const read of opts.reads ?? []) {
      if (read.at === null) continue;
      const rel = repoRelative(repoRoot, read.path);
      if (rel === null) continue;
      const since = changedAt.get(rel);
      if (since !== undefined && read.at >= since) readAfter.push(rel);
    }

    const graph = (opts.cache ?? codeGraphCache()).get(repoRoot);
    const impact = boundaryImpact(graph, touches, {
      readAfter,
      maxMissed: Number.MAX_SAFE_INTEGER,
    });
    // `unanswered` alone still renders: "I could not look" must not come out
    // the same as "nothing depends on it".
    if (impact.missed.length === 0 && impact.unanswered.length === 0) continue;

    files += impact.missed.length;
    identity.push(
      repoRoot,
      ...impact.missed.map((m) => `${m.file}<${m.changedFile}`),
      ...impact.unanswered.map((f) => `?${f}`),
    );
    sections.push(render(repoRoot, impact.missed, impact.seen.length, impact.unanswered, impact.truncated));
  }

  if (sections.length === 0) return null;
  const dedupeKey = `${DEDUPE_PREFIX}${sha(identity.join("\n"))}`;
  if ((opts.session.shown[dedupeKey]?.count ?? 0) >= MAX_SHOW) return null;
  return { note: sections.join("\n"), dedupeKey, files };
}

async function diskMtime(absolutePath: string): Promise<number | null> {
  try {
    return (await stat(absolutePath)).mtimeMs;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    // Unreadable is not evidence the write failed; keep the file in.
    return Number.MAX_SAFE_INTEGER;
  }
}

/**
 * Statements only, the voice `renderImpactBlock` set: what was written, what
 * the graph said depended on it, that none of it was opened since, and that it
 * is a candidate list. No verb the agent is meant to obey.
 */
function render(
  repoRoot: string,
  missed: readonly MissedDependent[],
  seen: number,
  unanswered: readonly string[],
  truncated: boolean,
): string {
  // Production before tests, #577's measured reason: a file's own tests are
  // the part an agent can already assume.
  const ordered = [
    ...missed.filter((m) => !isTestFile(m.file)),
    ...missed.filter((m) => isTestFile(m.file)),
  ];
  const shown = ordered.slice(0, MAX_IMPACT_FILES);
  const lines: string[] = [
    `Code graph, task boundary (${repoRoot}): files written in this session had ` +
      "dependents that were neither written nor read since. Context, not an instruction.",
  ];
  if (missed.length > 0) {
    lines.push(`Not opened (${missed.length} candidate file${missed.length === 1 ? "" : "s"}):`);
  }
  for (const m of shown) {
    const late = m.basis === "whole_file_now" ? " [whole file, asked after the edit]" : "";
    lines.push(`- ${m.location} — ${m.relation} ${m.via} (${m.changedFile})${late}`);
  }
  const rest = missed.length - shown.length;
  if (rest > 0) lines.push(`- … and ${rest} more (find_affected_files lists them)`);
  if (seen > 0) {
    lines.push(`${seen} more dependent file${seen === 1 ? " was" : "s were"} read after the change and not written.`);
  }
  if (unanswered.length > 0) {
    lines.push(
      `Dependents unknown — no graph could be asked about: ${unanswered.slice(0, MAX_IMPACT_FILES).join(", ")}.`,
    );
  }
  if (truncated) lines.push("A dependent list was capped on the way; this is not all of them.");
  lines.push(
    "Dependents are as the graph had them when each edit was made. A listed file " +
      "may survive the change; a body edit often leaves its callers intact, and " +
      "the graph cannot tell.",
  );
  return lines.join("\n");
}

function sha(s: string): string {
  return createHash("sha1").update(s).digest("hex").slice(0, 12);
}
