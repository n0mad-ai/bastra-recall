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
  const url = daemonBaseUrl();
  const remainingMs = Math.max(60, HOOK_TIMEOUT_MS - (Date.now() - startedAt));
  try {
    emitOnce(await postLane(url, "/hook/session", { payload }, remainingMs));
  } catch (err) {
    emitOnce("{}");
    // #543: the row this lane's gate needs. Until now a transport failure
    // here left NO row at all, so the lane's denominator shrank by exactly
    // the calls that were lost and its failure rate stayed 0% — a gate green
    // for lack of data. The row carries this lane's OWN event kind
    // (hook-client-telemetry.ts), so it folds into this lane's series and no
    // other. Imported lazily: it is only ever needed on a failure, and a
    // static import would be process-start cost on every call (#305).
    const status = classifyTransportError(err as NodeJS.ErrnoException);
    const { writeClientTelemetry, sessionIdOf, THIN_CLIENT_VERSION } = await import(
      "./hook-client-telemetry.js"
    );
    await writeClientTelemetry(
      "session",
      {
        daemon_url: url,
        status,
        error: status === "error" ? ((err as Error).message ?? String(err)) : null,
      },
      startedAt,
      sessionIdOf(payload),
      THIN_CLIENT_VERSION,
    );
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
