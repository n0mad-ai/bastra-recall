/**
 * Forwarder ↔ daemon transport & lifecycle — split out of mcp-forwarder.ts
 * (file-size convention). Owns the boot state (#78 hold-the-call): the
 * `daemonReady` promise lives HERE, primed once by main() and re-primed by
 * holdForDaemon() after an unreachable error.
 */
import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const DAEMON_URL = (process.env.BASTRA_DAEMON_URL ?? "http://127.0.0.1:6723").replace(/\/+$/, "");
export const API_TOKEN = process.env.BASTRA_API_TOKEN ?? "";
export const SPAWN_ENABLED = (process.env.BASTRA_FORWARDER_SPAWN ?? "1") !== "0";

/** Cold Ollama load can take a while on first boot — generous on purpose. */
const HEALTH_TIMEOUT_MS = 60_000;
const HEALTH_POLL_INTERVAL_MS = 200;
export const REQUEST_TIMEOUT_MS = 30_000;

/**
 * #493: Die Wanduhr, die der Forwarder mit jedem Recall MITSCHICKT
 * (`hook_budget_ms`).
 *
 * Er schickte bisher keine, also fiel `/hook/recall` auf `BASTRA_HOOK_BUDGET_MS`
 * zurück — die 200 ms der Prompt-Lane. Die Schattenzeilen der MCP-Lane lasen
 * live `deadline_ms 1500, lane_budget_ms 200, cap_reason floor`: ein gesunder
 * 400-ms-Arm, gemessen an einer Grenze, die für ihn nie galt.
 *
 * Die echte Wanduhr dieses Aufrufs ist {@link REQUEST_TIMEOUT_MS}; der Endpunkt
 * nimmt höchstens 10 s an. Also die kleinere von beiden — sie ist damit
 * ohnehin nie bindend, und genau das ist die Aussage: Hier wartet ein Modell
 * auf eine Antwort, keine Hook-Frist.
 *
 * Steht hier und nicht in `mcp-forwarder.ts`, weil sie aus dem Timeout darüber
 * abgeleitet ist — und weil diese Datei importierbar ist, der Einstiegspunkt
 * daneben aber beim Import seinen Server startet.
 */
export const FORWARDER_HOOK_BUDGET_MS = Math.min(REQUEST_TIMEOUT_MS, 10_000);

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(tid);
  }
}

export async function probeHealth(): Promise<boolean> {
  try {
    const resp = await fetchWithTimeout(`${DAEMON_URL}/health`, {}, 1500);
    if (!resp.ok) return false;
    const body = (await resp.json()) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  }
}

function spawnDaemon(): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const daemonScript = path.join(here, "index.js");
  const child = spawn(process.execPath, [daemonScript], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
}

async function waitForHealth(): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < HEALTH_TIMEOUT_MS) {
    if (await probeHealth()) return true;
    await sleep(HEALTH_POLL_INTERVAL_MS);
  }
  return false;
}

export async function ensureDaemonRunning(): Promise<boolean> {
  if (await probeHealth()) return true;
  if (!SPAWN_ENABLED) {
    console.error(
      "[bastra-recall-mcp] daemon not running and auto-spawn disabled (BASTRA_FORWARDER_SPAWN=0). Returning errors for tool calls until daemon is up.",
    );
    return false;
  }
  console.error("[bastra-recall-mcp] daemon not running, spawning…");
  spawnDaemon();
  const ready = await waitForHealth();
  if (!ready) {
    console.error(
      `[bastra-recall-mcp] daemon did not become healthy within ${HEALTH_TIMEOUT_MS}ms. Tool calls will error.`,
    );
  }
  return ready;
}

/** Boot-Promise des Daemons — Tool-Calls warten darauf statt zu erroren (#78). */
let daemonReady: Promise<boolean> = Promise.resolve(false);

/** Kick off (or retry) the boot; main() calls this once at startup. */
export function primeDaemon(): Promise<boolean> {
  daemonReady = ensureDaemonRunning();
  return daemonReady;
}

/** Await the current boot promise without ever rejecting. */
export function awaitDaemonReady(): Promise<boolean> {
  return daemonReady.catch(() => false);
}

/**
 * Hold-the-call (#78): erst den laufenden Boot abwarten, dann den Call
 * ausführen. Scheitert er mit "daemon unreachable" (Idle-Self-Terminate oder
 * Crash NACH dem ersten Boot), wird der Daemon einmal respawnt und der Call
 * wiederholt — statt dem Client "no access to the MCP server" zu zeigen.
 */
export async function holdForDaemon<T>(fn: () => Promise<T>): Promise<T> {
  await daemonReady.catch(() => false);
  try {
    return await fn();
  } catch (err) {
    if (!String((err as Error).message).includes("unreachable")) throw err;
    daemonReady = ensureDaemonRunning();
    const ok = await daemonReady;
    if (!ok) throw err;
    return await fn();
  }
}
