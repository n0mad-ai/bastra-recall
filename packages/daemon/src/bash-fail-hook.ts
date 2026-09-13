#!/usr/bin/env node
/**
 * bastra-recall bash-fail-hook — THIN CLIENT (#343 pattern).
 *
 * The post-Bash pipeline (act-signal #144, gates incl. invokesOwnBinary,
 * throttle, fail-recall, backoff) lives daemon-side in `bash-fail-lane.ts`
 * behind POST /hook/bash-fail. The gates moved WITH it: `invokesOwnBinary`
 * exists because an imprecise gate once swallowed ~75% of commands — gate
 * logic that can be wrong must stay hot-swappable, not baked into a
 * compiled stub (#344).
 *
 * Discipline: fail open to `{}` on every path, exit 0, stdlib only.
 */
import { envInt } from "./env.js";
import { readStdin, daemonBaseUrl, postLane, classifyTransportError } from "./thin-client.js";

const HOOK_TIMEOUT_MS = envInt("BASTRA_HOOK_TIMEOUT_MS", 500, "NEXUS_HOOK_TIMEOUT_MS");

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
  const remainingMs = Math.max(50, HOOK_TIMEOUT_MS - (Date.now() - startedAt));
  try {
    emitOnce(await postLane(url, "/hook/bash-fail", { payload }, remainingMs));
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
      "bash-fail",
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

const isCliEntry = (process.argv[1] ?? "").endsWith("bash-fail-hook.js") || (process.argv[1] ?? "").endsWith("bash-fail-hook.ts");

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
