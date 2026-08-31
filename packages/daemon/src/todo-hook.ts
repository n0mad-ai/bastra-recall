#!/usr/bin/env node
/**
 * bastra-recall todo hook — THIN CLIENT (#369, the #343 pattern).
 *
 * The TodoWrite pipeline this file used to run (topic extraction, the
 * confidence gate, recall, backoff, hint block, telemetry — #36) lives
 * daemon-side in `todo-lane.ts` now, behind POST /hook/todo. What remains is
 * the part that must run in the hook process because it IS the hook process:
 * stdin -> POST -> stdout verbatim.
 *
 * No client-side content gate: the extraction and its min-confidence
 * threshold are lane logic that must stay hot-swappable (#344 — a tuned
 * threshold must never require a stub rebuild), and the lane answers `{}` for
 * a thin payload in well under a millisecond of daemon work.
 *
 * Discipline: fail open to `{}` on every path, exit 0, stdlib only. Every
 * import here is process-start cost on every TodoWrite (#305).
 */
import { envInt } from "./env.js";
import { readStdin, daemonBaseUrl, postLane, classifyTransportError } from "./thin-client.js";

const HOOK_TIMEOUT_MS = envInt("BASTRA_HOOK_TIMEOUT_MS", 600, "NEXUS_HOOK_TIMEOUT_MS");

let stdoutEmitted = false;
function emitOnce(payload: string): void {
  if (stdoutEmitted) return;
  stdoutEmitted = true;
  process.stdout.write(payload);
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const raw = await readStdin();
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return emitOnce("{}");
  }
  const remainingMs = Math.max(50, HOOK_TIMEOUT_MS - (Date.now() - startedAt));
  try {
    emitOnce(await postLane(daemonBaseUrl(), "/hook/todo", { payload }, remainingMs));
  } catch (err) {
    // Not separately logged, like the bash lanes: this lane has no skip
    // telemetry to keep consistent, and a down daemon already shows up in the
    // prompt/write lanes' client events.
    void classifyTransportError(err as NodeJS.ErrnoException);
    emitOnce("{}");
  }
}

const argv1 = process.argv[1] ?? "";
const isCliEntry = argv1.endsWith("todo-hook.js") || argv1.endsWith("todo-hook.ts");

if (isCliEntry) {
  const killSwitch = setTimeout(() => {
    emitOnce("{}");
    process.exit(0);
  }, HOOK_TIMEOUT_MS + 50);
  killSwitch.unref();

  main()
    .then(() => process.exit(0))
    .catch(() => {
      emitOnce("{}");
      process.exit(0);
    });
}
