/**
 * Find every running daemon process, not just the one answering /health.
 *
 * The port is the singleton: two daemons cannot both bind 6723, so the
 * production instance is safe by construction. What the port does NOT catch is
 * a daemon on a DIFFERENT port — a measurement harness, an experiment, a
 * second vault — and nothing ever mentioned those. One from a July 21st
 * falsification run sat there for six days on port 6799, holding a one-memory
 * vault and 20 MB, invisible to `status`, `doctor` and /health alike.
 *
 * These are not automatically stopped: a second daemon is sometimes exactly
 * what someone wants. They are only made visible.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface DaemonProcess {
  pid: number;
  /** Wall-clock age as `ps` reports it (dd-hh:mm:ss / hh:mm:ss / mm:ss). */
  elapsed: string;
  /** True for the process holding the configured port. */
  primary: boolean;
}

/**
 * True when the daemon entry point is what this command line EXECUTES (#527).
 *
 * A substring test on the whole line says yes to any process that merely
 * mentions the path — `node worker.js note:/some/daemon/dist/index.js` was
 * enough. So the token has to be the script itself: argv[0] (the daemon's own
 * bin shim) or the first non-option argument (the runtime's script argument).
 */
function runsDaemonEntryPoint(command: string): boolean {
  const tokens = command.trim().split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return false;
  const script = tokens.slice(1).find((t) => !t.startsWith("-"));
  return [tokens[0], script].some((t) => t !== undefined && /(^|\/)daemon\/dist\/index\.js$/.test(t));
}

/** `ps -eo pid,etime,command` output → the daemon processes in it. */
export function parseDaemonProcesses(psOutput: string, primaryPid: number | null): DaemonProcess[] {
  const out: DaemonProcess[] = [];
  for (const line of psOutput.split("\n")) {
    const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    // The daemon entry point, however it was launched (LaunchAgent, forwarder
    // auto-spawn, or by hand). `dist/index.js` is what all three exec.
    if (!runsDaemonEntryPoint(m[3])) continue;
    if (/\bgrep\b/.test(line)) continue;
    const pid = Number(m[1]);
    if (!Number.isFinite(pid)) continue;
    out.push({ pid, elapsed: m[2], primary: pid === primaryPid });
  }
  return out;
}

/** PID listening on `port`, or null. Best-effort: lsof is absent on some systems. */
async function listenerPid(port: number): Promise<number | null> {
  try {
    const { stdout } = await run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { timeout: 3000 });
    const pid = Number(stdout.trim().split("\n")[0]);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

/** The port this machine's daemon is configured to use (default 6723). */
export function daemonPort(): number {
  const raw = process.env.BASTRA_HTTP_PORT ?? process.env.NEXUS_HTTP_PORT;
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 6723;
}

export async function listDaemonProcesses(port: number = daemonPort()): Promise<DaemonProcess[]> {
  let psOutput: string;
  try {
    ({ stdout: psOutput } = await run("ps", ["-eo", "pid,etime,command"], { timeout: 5000 }));
  } catch {
    return [];
  }
  return parseDaemonProcesses(psOutput, await listenerPid(port));
}

/**
 * One line for `status` / `doctor`. `null` when there is nothing worth saying —
 * exactly one daemon, or none (the daemon line already covers that case).
 */
export function formatExtraDaemons(procs: DaemonProcess[]): string | null {
  if (procs.length <= 1) return null;
  const others = procs.filter((p) => !p.primary);
  if (others.length === 0) return null;
  const list = others.map((p) => `pid ${p.pid} (${p.elapsed})`).join(", ");
  return (
    `${others.length} further daemon process(es) running on other ports: ${list}. ` +
    `Harmless for recall — the port keeps them apart — but they hold a vault index in memory. ` +
    `Stop with: kill ${others.map((p) => p.pid).join(" ")}`
  );
}
