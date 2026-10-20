/**
 * The Bash lane's half of the coverage map (#629): a test command becomes the
 * same command with `NODE_V8_COVERAGE` set, and nothing else changes.
 *
 * Three gates, all of them required: the command is one of the recognised
 * test runners, the working directory lies in a repository code awareness is
 * on for, and `coverageMap.enabled` is set. The switch is the owner's
 * condition for rewriting someone else's command at all; the repository gate
 * keeps a map from being collected where no graph will ever read it.
 *
 * A fourth gate is about disk, not consent: raw output nobody folded — a
 * daemon that was down for the fold — stops the collection at MAX_RAW_BYTES
 * instead of growing without bound.
 *
 * Kept out of bash-pre-lane.ts, which is past the size ceiling.
 */

import { isRepoEnabledSync } from "./code-graph/enabled-repos.js";
import { getCoverageMapEnabled } from "./code-graph/coverage-map-settings.js";
import {
  MAX_RAW_BYTES,
  coverageRawDirOf,
  ensureCoverageDir,
  isTestCommand,
  rawBytesOf,
  withCoverageEnv,
} from "./code-graph/coverage-map.js";
import { repoRootSync } from "./code-graph/git-paths.js";

/** The rewritten command, or null when the command is to run as written. Never throws. */
export async function coverageRewrite(command: string, cwd: string | undefined): Promise<string | null> {
  try {
    if (!cwd || !isTestCommand(command)) return null;
    const repo = repoRootSync(cwd);
    if (repo === null || !isRepoEnabledSync(repo)) return null;
    if (!(await getCoverageMapEnabled())) return null;
    if ((await rawBytesOf(repo)) >= MAX_RAW_BYTES) return null;
    await ensureCoverageDir(repo);
    return withCoverageEnv(command, coverageRawDirOf(repo));
  } catch {
    return null;
  }
}
