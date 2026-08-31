#!/usr/bin/env node
/**
 * bastra-recall stop-hook — THIN CLIENT (#369, the #343 pattern).
 *
 * The save-evaluation this file used to run (transcript load, three
 * heuristics, drift fetch, pending-suggestion write, telemetry — #35/#48/#67)
 * lives daemon-side in `stop-lane.ts` now, behind POST /hook/stop. What
 * remains is the part that must run in the hook process because it IS the
 * hook process: stdin -> POST -> stdout verbatim.
 *
 * Why this lane above all: Stop fires at the end of EVERY answer (94-108x/day
 * on the reference host), and node's interpreter start alone measured ~75ms of
 * that. The compiled stub (#344/#350) starts in ~25ms — and this is the one
 * moment the user is waiting for nothing but the turn to be over.
 *
 * The budget stays this lane's own 1000ms (BASTRA_STOP_HOOK_TIMEOUT_MS), not
 * the 600ms the recall lanes use: scanning a long transcript legitimately
 * takes longer than a recall, and the answer is `{}` either way — the client
 * timing out early would only orphan work the daemon then finishes anyway.
 *
 * Discipline: fail open to `{}` on every path, exit 0, stdlib only. Every
 * import here is process-start cost at every turn end (#305).
 */
import { envInt } from "./env.js";
import { readStdin, daemonBaseUrl, postLane, classifyTransportError } from "./thin-client.js";

const HOOK_TIMEOUT_MS = envInt("BASTRA_STOP_HOOK_TIMEOUT_MS", 1000);

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
    emitOnce(await postLane(daemonBaseUrl(), "/hook/stop", { payload }, remainingMs));
  } catch (err) {
    // No client-side telemetry: this lane's event (`save_eval_call`) describes
    // an evaluation that did not happen when the daemon is unreachable, and a
    // down daemon already shows up in the prompt/write lanes' client events.
    void classifyTransportError(err as NodeJS.ErrnoException);
    emitOnce("{}");
  }
}

const isMain = (() => {
  const argv1 = process.argv[1];
  if (typeof argv1 !== "string") return false;
  return (
    argv1.endsWith("stop-hook.js") ||
    argv1.endsWith("stop-hook.ts") ||
    argv1.endsWith("bastra-recall-stop-hook")
  );
})();

if (isMain) {
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
