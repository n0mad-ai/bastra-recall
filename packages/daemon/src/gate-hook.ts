#!/usr/bin/env node
/**
 * bastra-recall gate-hook — THIN CLIENT (#343 pattern) for the catch-all
 * PreToolUse gate (#1303).
 *
 * The decision lives daemon-side in `gate-lane.ts` behind POST /hook/gate.
 * This client forwards every PreToolUse payload and writes the answer
 * verbatim. Fail-open on every path: a timeout, an unreachable daemon or the
 * kill switch answer `{}`, so the tool call runs, and leave a `gate_hook_call`
 * row carrying `non_conformance` — the gate did not get to decide.
 *
 * Discipline: exit 0, stdlib only.
 */
import { envInt } from "./env.js";
import { FAST_BUDGET_MS } from "./hook-budgets.js";
import { readStdin, daemonBaseUrl, postLane, classifyTransportError } from "./thin-client.js";

const HOOK_TIMEOUT_MS = envInt("BASTRA_HOOK_TIMEOUT_MS", FAST_BUDGET_MS, "NEXUS_HOOK_TIMEOUT_MS");

let stdoutEmitted = false;
function emitOnce(payload: string): void {
  if (stdoutEmitted) return;
  stdoutEmitted = true;
  process.stdout.write(payload);
}

const startedAt = Date.now();
let sessionId: string | null = null;
let failureWrite: Promise<void> | undefined;

/** The one client row per failed call; the kill switch and the catch share it. */
async function writeFailureRow(status: string, error: string | null, url: string): Promise<void> {
  const { spoolRulebookFailure } = await import("./rulebook-spool.js");
  await spoolRulebookFailure(sessionId);
  // Imported lazily: only a failure pays for it (#305).
  const { writeClientTelemetry, THIN_CLIENT_VERSION } = await import("./hook-client-telemetry.js");
  await writeClientTelemetry(
    "gate",
    { daemon_url: url, status, error, non_conformance: status === "timeout" ? "gate_timeout" : "gate_unavailable" },
    startedAt,
    sessionId,
    THIN_CLIENT_VERSION,
  );
}

async function main(): Promise<void> {
  const raw = await readStdin();
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return emitOnce("{}");
  }
  const { sessionIdOf } = await import("./hook-client-telemetry.js");
  sessionId = sessionIdOf(payload);
  const url = daemonBaseUrl();
  const remainingMs = Math.max(50, HOOK_TIMEOUT_MS - (Date.now() - startedAt));
  try {
    emitOnce(await postLane(url, "/hook/gate", { payload }, remainingMs));
  } catch (err) {
    emitOnce("{}");
    const status = classifyTransportError(err as NodeJS.ErrnoException);
    failureWrite ??= writeFailureRow(status, status === "error" ? ((err as Error).message ?? String(err)) : null, url);
  }
}

const argv1 = process.argv[1] ?? "";
const isCliEntry =
  argv1.endsWith("gate-hook.js") ||
  argv1.endsWith("gate-hook.ts") ||
  argv1.endsWith("bastra-recall-gate-hook");

if (isCliEntry) {
  const killSwitch = setTimeout(() => {
    emitOnce("{}");
    // The call passes either way; the row says the gate never decided.
    failureWrite ??= writeFailureRow("timeout", "kill-switch", daemonBaseUrl());
    void exitAfterFailureWrite();
  }, HOOK_TIMEOUT_MS + 50);
  killSwitch.unref();

  // Whichever path finishes first owns the row. Both exits wait for it.
  async function exitAfterFailureWrite(): Promise<never> {
    clearTimeout(killSwitch);
    try { await failureWrite; }
    finally { process.exit(0); }
  }

  void main().catch(() => emitOnce("{}")).then(exitAfterFailureWrite);
}
