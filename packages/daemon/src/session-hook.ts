#!/usr/bin/env node
/**
 * bastra-recall session-start hook — THIN CLIENT (#369, the #343 pattern).
 *
 * The SessionStart pipeline this file used to run (three scope-filtered
 * recalls, floors, taxonomy, care/import/onboarding/update/patch/pending
 * blocks, formatting, telemetry) lives daemon-side in `session-lane.ts` now,
 * behind POST /hook/session. What remains is the part that must run in the
 * hook process because it IS the hook process: stdin -> POST -> stdout
 * verbatim.
 *
 * Two costs disappeared with the move: ~78ms of node interpreter start per
 * session (#305/#369 — the compiled stub starts in ~25ms), and the up-to-seven
 * sequential loopback round trips the lane makes, which now run inside the
 * server that answers them.
 *
 * Budget: BASTRA_HOOK_TIMEOUT_MS + 100ms, which is exactly the wall clock the
 * fat hook allowed itself (its kill switch fired at the same point). A session
 * start must not hang on a slow vault; the lane keeps its own per-call budgets.
 *
 * Discipline: fail open to `{}` on every path, exit 0, stdlib only.
 */
import { envInt } from "./env.js";
import { readStdin, daemonBaseUrl, postLane, classifyTransportError } from "./thin-client.js";

const LANE_BUDGET_MS = envInt("BASTRA_HOOK_TIMEOUT_MS", 500, "NEXUS_HOOK_TIMEOUT_MS");
const HOOK_TIMEOUT_MS = LANE_BUDGET_MS + 100;

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
  const remainingMs = Math.max(60, HOOK_TIMEOUT_MS - (Date.now() - startedAt));
  try {
    emitOnce(await postLane(daemonBaseUrl(), "/hook/session", { payload }, remainingMs));
  } catch (err) {
    // No client-side telemetry: `session_hook_call` describes a pipeline that
    // did not run when the daemon is unreachable, and a down daemon already
    // shows up in the prompt/write lanes' client events.
    void classifyTransportError(err as NodeJS.ErrnoException);
    emitOnce("{}");
  }
}

const argv1 = process.argv[1] ?? "";
const isCliEntry =
  argv1.endsWith("session-hook.js") ||
  argv1.endsWith("session-hook.ts") ||
  argv1.endsWith("bastra-recall-session-hook");

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
