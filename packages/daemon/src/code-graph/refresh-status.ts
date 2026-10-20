/**
 * The refresh coordinator's state as a user sees it (#1148).
 *
 * The daemon alone knows whether a repository's automatic refresh is paused
 * (lock contention, retried hourly) or stopped (three build failures, waits for
 * the user). Until this existed that state was an in-memory flag and nothing
 * printed it: `bastra code` and `bastra doctor` showed the manifest, which says
 * when the graph was built and not why it is no longer being rebuilt.
 *
 * One module for both sides of the loopback door `/code/refresh`: the daemon
 * serialises {@link RepoStatus} with it, the CLI parses the answer back and
 * turns it into lines. Keeping the wording in one place means doctor and
 * `bastra code` cannot drift apart on what "paused" means.
 */

import type { RefreshReason, RepoStatus } from "./refresh.js";

/** The wire shape of one repository on `GET /code/refresh`. */
export interface RefreshStatusRow {
  repo_root: string;
  state: RepoStatus["state"];
  pending: boolean;
  failures: number;
  last_error: string | null;
  given_up: boolean;
  last_reason: RefreshReason | null;
  builds: number;
  next_attempt_at: string | null;
}

export function toRefreshStatusRows(status: readonly RepoStatus[]): RefreshStatusRow[] {
  return status.map((s) => ({
    repo_root: s.repoRoot,
    state: s.state,
    pending: s.pending,
    failures: s.failures,
    last_error: s.lastError,
    given_up: s.givenUp,
    last_reason: s.lastReason,
    builds: s.builds,
    next_attempt_at: s.nextAttemptAt,
  }));
}

/**
 * Read the daemon's answer back. Validated field by field rather than cast: the
 * CLI may be newer or older than the daemon it asks, and a row it cannot read
 * is dropped instead of printed as nonsense.
 */
export function parseRefreshStatusRows(body: unknown): RepoStatus[] {
  const repos = (body as { repos?: unknown } | null)?.repos;
  if (!Array.isArray(repos)) return [];
  const out: RepoStatus[] = [];
  for (const raw of repos) {
    const r = raw as Partial<RefreshStatusRow> | null;
    if (r === null || typeof r !== "object" || typeof r.repo_root !== "string") continue;
    if (r.state !== "idle" && r.state !== "waiting" && r.state !== "running") continue;
    out.push({
      repoRoot: r.repo_root,
      state: r.state,
      pending: r.pending === true,
      failures: typeof r.failures === "number" ? r.failures : 0,
      lastError: typeof r.last_error === "string" ? r.last_error : null,
      givenUp: r.given_up === true,
      lastReason: typeof r.last_reason === "string" ? (r.last_reason as RefreshReason) : null,
      builds: typeof r.builds === "number" ? r.builds : 0,
      nextAttemptAt: typeof r.next_attempt_at === "string" ? r.next_attempt_at : null,
    });
  }
  return out;
}

/**
 * What to print under a repository, or nothing when the refresh is healthy.
 *
 * Two states are worth a line. A PAUSE (`givenUp` with a next attempt) is lock
 * contention: another process keeps building this repository, and the daemon
 * tries once an hour. A STOP (`givenUp` without a next attempt) is three failed
 * builds: nothing automatic will happen again until the user asks, so the line
 * names the command. Both say what the last attempt reported, so the user can
 * tell a stranded lock from a broken Graphify without opening the log.
 */
export function refreshStatusLines(s: RepoStatus, now: Date = new Date()): string[] {
  if (!s.givenUp) return [];
  const error = s.lastError === null ? "" : `: ${s.lastError}`;
  if (s.nextAttemptAt !== null) {
    return [
      `refresh paused${error}`,
      `next automatic attempt ${describeDue(s.nextAttemptAt, now)} — 'bastra code index' tries now`,
    ];
  }
  const failures = s.failures > 0 ? ` after ${s.failures} failed build${s.failures === 1 ? "" : "s"}` : "";
  return [
    `refresh stopped${failures}${error}`,
    "no automatic retry — run 'bastra code index' to retry",
  ];
}

function describeDue(iso: string, now: Date): string {
  const due = Date.parse(iso);
  if (!Number.isFinite(due)) return `at ${iso}`;
  const minutes = Math.round((due - now.getTime()) / 60_000);
  if (minutes <= 0) return "any moment now";
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `in ${hours} h` : `in ${hours} h ${rest} min`;
}
