/**
 * Why code awareness is not answering — truthfully (#582).
 *
 * The note used to say "the graph is loading in the background" for every
 * empty case. For a repository nobody ever enabled, and for one that has no
 * graph on disk, that is simply false: nothing is loading, and nothing will
 * be. An agent reads "loading" as "ask again later", so the tool spent the
 * user's next turn on a promise it could not keep.
 *
 * Four states, four answers, and every one of them ends with the same thing:
 * use Grep for this turn. The tool never implies that an empty answer says
 * anything about whether the symbol exists.
 */

import { existsSync } from "node:fs";
import type { CodeGraphCache } from "./cache.js";
import { graphFileOf } from "./reader.js";

/** The last two path segments: enough to recognise the repo, short in context. */
export function shortRepo(repo: string): string {
  const parts = repo.split("/").filter((p) => p.length > 0);
  return parts.slice(-2).join("/") || repo;
}

/**
 * The note for a repository code awareness will not serve: switched off by the
 * kill switch, or simply never enabled. Names the command that changes it —
 * `bastra code enable`, the one the CLI itself prints.
 */
export function offNote(repo: string, disabledByEnv: boolean): string {
  const why = disabledByEnv
    ? `Code awareness is switched off for this session.`
    : `Code awareness is not enabled for ${shortRepo(repo)}.`;
  return (
    `${why} Nothing is indexing and nothing will arrive later. ` +
    `To switch it on: run \`bastra code enable\` inside the repository, then ` +
    `\`bastra code index\`. For this turn use Grep — this says nothing about ` +
    `whether the symbol exists.`
  );
}

/**
 * The note for an enabled repository whose graph is not in memory. Three
 * different situations, and the difference is what the caller should do next.
 */
export function notReadyNote(cache: CodeGraphCache, repo: string): string {
  const degraded = cache.stats().degraded.find((d) => d.repoRoot === repo);
  if (degraded !== undefined) {
    return (
      `The code graph for ${shortRepo(repo)} was refused (${degraded.reason}). ` +
      `Run \`bastra doctor\` for the detail and \`bastra code index\` to rebuild it. ` +
      `Use Grep for now.`
    );
  }
  // The file check comes BEFORE the loading check on purpose: asking for a
  // repository with no graph starts a read that is about to fail, so a caller
  // that trusted `isLoading` would be told to come back for something that is
  // never going to arrive.
  if (!existsSync(graphFileOf(repo))) {
    return (
      `${shortRepo(repo)} has no code graph yet — run \`bastra code index\` in it. ` +
      `Nothing usable is loading, so a later call will not have it either. Use Grep.`
    );
  }
  if (cache.isLoading(repo)) {
    return (
      `The code graph for ${shortRepo(repo)} is being read right now and this call ` +
      `did not wait for it. Use Grep for this turn; a later call will have it.`
    );
  }
  return (
    `The code graph for ${shortRepo(repo)} is on disk but not in memory yet; the ` +
    `read starts in the background and this call did not wait for it. Use Grep ` +
    `for this turn.`
  );
}
