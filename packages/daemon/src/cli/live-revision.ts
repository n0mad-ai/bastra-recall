/**
 * #528 — which revision is ACTUALLY live once `bastra update` is done?
 *
 * The closing line used to name HEAD as live because the local build had been
 * checked. That is a claim about a directory, not about the process that serves
 * MCP calls — and in the branch without a LaunchAgent the command said in one
 * breath that a running daemon still held the old code and that the verified
 * HEAD was live. Two answers to one question, in the same output.
 *
 * Since a build now stamps itself with its revision (build-stamp.ts) and the
 * daemon reports that stamp on /health as `build_revision`, the question does
 * not have to be inferred any more: ask the daemon. What comes back decides
 * both the restart report and the closing line, so they always tell the same
 * story — including "I cannot prove it", which is a valid answer and not a
 * reason to print success.
 *
 * Separate module rather than more of update.ts: that file is at the size
 * where a small change means reading a large file (file-size convention).
 */
import { probeDaemon, type DaemonProbe } from "./helpers.js";
import { shortRevision, type SourceBuildState } from "./source-build.js";
import { resolveDaemonEndpoint } from "../daemon-endpoint.js";
import { sourceBuildWordsIn } from "./source-build-words.js";

export type LiveRevision = "live" | "other-build" | "unknown-build" | "no-daemon" | "unprovable";

/** Pure, so every branch is testable without a daemon. */
export function decideLiveRevision(i: {
  /** Full sha the checkout PROVED it is built from; null when nothing was proved. */
  provenHead: string | null;
  daemonReachable: boolean;
  /** Full sha from /health, null when the daemon does not report one. */
  daemonRevision: string | null;
}): LiveRevision {
  if (i.provenHead === null) return "unprovable";
  if (!i.daemonReachable) return "no-daemon";
  if (i.daemonRevision === null) return "unknown-build";
  return i.daemonRevision === i.provenHead ? "live" : "other-build";
}

/** The restart-step report and the closing line, as ONE story, in `language`
 *  (language.primary; English when not given, #1602). */
export function describeLiveRevision(
  v: LiveRevision,
  i: { state: SourceBuildState; daemonRevision: string | null },
  language = "en"
): { report: string; closing: string } {
  const w = sourceBuildWordsIn(language);
  const head = `${i.state.revision}`;
  const running = shortRevision(i.daemonRevision) ?? w.unknownBuild;
  switch (v) {
    case "live":
      return { report: w.liveReport(head), closing: w.liveClosing(head) + w.restartClients };
    case "no-daemon":
      return { report: w.noDaemonReport, closing: w.noDaemonClosing(head) + w.restartClients };
    case "other-build":
      return {
        report: w.otherReport(running, head),
        closing: w.otherClosing(running, head, `${resolveDaemonEndpoint().port}`),
      };
    case "unknown-build":
      return { report: w.unknownBuildReport, closing: w.unknownBuildClosing(head) };
    case "unprovable":
      // The local build was accepted but not tied to a commit (a dirty tree, or
      // a tree with no workspace sources). Naming a revision here would be the
      // exact overstatement this module exists to remove.
      return { report: "", closing: w.unprovableClosing + w.restartClients };
  }
}

/**
 * Asks the running daemon, giving a just-kickstarted one a moment to come up.
 * `attempts`/`sleep` are injectable so the retry can be tested instantly.
 */
export async function liveRevisionOfDaemon(
  provenHead: string | null,
  io: {
    probe?: () => Promise<DaemonProbe>;
    attempts?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {}
): Promise<{ verdict: LiveRevision; daemonRevision: string | null }> {
  const probe = io.probe ?? probeDaemon;
  const attempts = io.attempts ?? 5;
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last: DaemonProbe = { ok: false, detail: "not probed" };
  for (let i = 0; i < attempts; i++) {
    last = await probe();
    // A kickstarted daemon needs a moment to bind; a matching revision ends it.
    if (last.ok && last.buildRevision === provenHead) break;
    if (i < attempts - 1) await sleep(400);
  }
  const daemonRevision = last.buildRevision ?? null;
  return {
    verdict: decideLiveRevision({ provenHead, daemonReachable: last.ok, daemonRevision }),
    daemonRevision,
  };
}
