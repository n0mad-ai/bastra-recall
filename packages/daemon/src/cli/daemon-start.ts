/**
 * Bring the daemon up from the CLI (#322).
 *
 * `bastra map` is the one command meant to work BEFORE the user has an AI
 * session — it is how someone looks at their vault without one. But the daemon
 * only ever came up through a LaunchAgent (no install path registers one) or
 * the forwarder's auto-spawn on the first MCP call. So the command written for
 * people who have no AI session was the command that needed one: the guided
 * setup printed the map URL, `doctor` reported ECONNREFUSED, and the browser
 * showed "cannot connect to the server".
 *
 * Same bootstrap as the forwarder (see mcp-forwarder.ts): probe /health,
 * otherwise spawn a detached `node dist/index.js` and poll until it answers.
 * Deliberately not a second mechanism — a daemon started here is the very
 * process the forwarder would have started, so the port stays the singleton it
 * is and `listDaemonProcesses` recognises it.
 */
import { spawn } from "node:child_process";
import { probeDaemon, resolveVault } from "./helpers.js";
import { DAEMON_SCRIPT_PATH } from "./paths.js";
import { resolveDaemonEndpoint } from "../daemon-endpoint.js";

/**
 * A cold start is a vault load plus an index build; the forwarder allows 60 s
 * for the same wait. Half that here, because this one blocks a terminal the
 * user is watching — and a wait that ends in a clear "did not come up" beats
 * one that ends in a dead browser tab.
 */
export const DAEMON_START_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;

export type DaemonStartOutcome =
  | { ok: true; state: "already-running" | "started"; detail: string }
  | { ok: false; state: "no-vault" | "timeout"; detail: string };

/** Injectable for tests only — the real ones spawn a process and hit the port. */
export interface DaemonStartIO {
  probe(): Promise<boolean>;
  resolveVaultPath(): Promise<{ path: string } | { error: string }>;
  spawnDaemon(vaultPath: string): void;
  sleep(ms: number): Promise<void>;
  now(): number;
}

function spawnDetached(vaultPath: string): void {
  // detached + unref: the daemon has to outlive the CLI process that started
  // it, and must not hold the terminal open once `bastra map` returns.
  // #531: the daemon binds BASTRA_HTTP_PORT, the CLI probes THE endpoint. If
  // the endpoint was configured through BASTRA_DAEMON_URL alone, a spawn
  // without this line would bind the default port and then never be found by
  // the very probe that is waiting for it.
  const endpoint = resolveDaemonEndpoint();
  const child = spawn(process.execPath, [DAEMON_SCRIPT_PATH], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, BASTRA_VAULT_PATH: vaultPath, BASTRA_HTTP_PORT: String(endpoint.port) },
  });
  child.unref();
}

const realIO: DaemonStartIO = {
  probe: async () => (await probeDaemon()).ok,
  resolveVaultPath: () => resolveVault({ dryRun: false, vaultPath: null }),
  spawnDaemon: spawnDetached,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};

/**
 * Ensure a daemon is answering /health, starting one if needed. Never prompts,
 * so it is safe on the non-interactive path; `onStarting` fires only when a
 * process was actually spawned, so a caller can explain the wait without
 * announcing one that never happens.
 */
export async function ensureDaemonRunning(
  opts: {
    onStarting?: () => void;
    timeoutMs?: number;
    io?: DaemonStartIO;
    /** Skips detection when the caller already knows the vault — the wizard
     *  holds the path the user just picked, which no config file may name yet. */
    vaultPath?: string;
  } = {},
): Promise<DaemonStartOutcome> {
  const io = opts.io ?? realIO;
  const timeoutMs = opts.timeoutMs ?? DAEMON_START_TIMEOUT_MS;

  // A daemon from the LaunchAgent, a forwarder auto-spawn or a parallel CLI is
  // already the one instance there can be — the endpoint's port is the
  // singleton, and a second
  // start would only lose the EADDRINUSE race.
  if (await io.probe()) return { ok: true, state: "already-running", detail: "daemon already running" };

  // The daemon refuses to boot without a vault, so a start that cannot name one
  // is a failure now rather than a timeout in 30 s.
  const vault = opts.vaultPath ? { path: opts.vaultPath } : await io.resolveVaultPath();
  if ("error" in vault) return { ok: false, state: "no-vault", detail: vault.error };

  opts.onStarting?.();
  io.spawnDaemon(vault.path);

  const deadline = io.now() + timeoutMs;
  while (io.now() < deadline) {
    await io.sleep(POLL_INTERVAL_MS);
    if (await io.probe()) return { ok: true, state: "started", detail: "daemon started" };
  }
  return {
    ok: false,
    state: "timeout",
    detail: `daemon did not answer /health within ${Math.round(timeoutMs / 1000)}s`,
  };
}
