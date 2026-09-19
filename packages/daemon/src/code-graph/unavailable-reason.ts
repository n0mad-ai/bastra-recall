/**
 * The machine-readable twin of `unavailable-note.ts` (#589).
 *
 * The note tells the AGENT what to do next, in a sentence. Telemetry needs the
 * same distinction as a token it can count: "unavailable" collapses four very
 * different worlds — the feature is off, the repository was never indexed, the
 * graph is still being read, the graph was refused — and a readout that cannot
 * tell them apart says nothing about whether anything is wrong. One of them is
 * a user decision, one is a missing setup step, one is a cold start that fixes
 * itself, and one is a defect.
 *
 * Deliberately NOT derived from the note text: parsing a sentence written for a
 * language model is a join that breaks the first time the wording improves.
 * Both read the same four states from the same sources, in the same order.
 */

import { existsSync } from "node:fs";
import type { CodeGraphCache } from "./cache.js";
import { graphFileOf } from "./reader.js";
import { codeAwarenessDisabledByEnv } from "./enabled-repos.js";

export type CodeUnavailableReason =
  /** The kill switch is set for this session. */
  | "off_env"
  /** Code awareness was never enabled for this repository. */
  | "not_enabled"
  /** The graph was read and refused — a defect, `bastra doctor` has the detail. */
  | "degraded"
  /** Enabled, but nothing was ever built here. */
  | "not_indexed"
  /** A read is in flight and this call did not wait for it. */
  | "loading"
  /** On disk, not in memory yet; the read starts in the background. */
  | "cold";

/**
 * Why this repository could not be served, in the order `find_code` and
 * `find_affected_files` decide it.
 *
 * Only called when a result already said `unavailable`, so it never needs a
 * "was available" answer.
 */
export function unavailableReason(cache: CodeGraphCache, repo: string): CodeUnavailableReason {
  if (codeAwarenessDisabledByEnv()) return "off_env";
  if (!cache.allows(repo)) return "not_enabled";
  if (cache.stats().degraded.some((d) => d.repoRoot === repo)) return "degraded";
  // Same order as the note: the file check comes before the loading check,
  // because a repository with no graph starts a read that is about to fail.
  if (!existsSync(graphFileOf(repo))) return "not_indexed";
  if (cache.isLoading(repo)) return "loading";
  return "cold";
}
