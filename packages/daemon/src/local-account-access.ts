/** macOS local account boundary. Only OS socket/process data is evidence; never HTTP fields. */
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import type { Socket } from "node:net";

export interface LocalAccountOptions {
  /** Internal dependency injection for fixtures; not an environment bypass. */
  platform?: NodeJS.Platform;
  lookup?: (socket: Socket) => Promise<number | undefined>;
  euid?: () => number | undefined;
}
const platformOf = (options: LocalAccountOptions) => options.platform ?? process.platform;
const uid = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
/** The running process must itself be the account that owns the vault directory. */
export async function vaultAccountUid(root: string, options: LocalAccountOptions = {}): Promise<number | undefined> {
  if (platformOf(options) !== "darwin") return undefined;
  try {
    const info = await stat(root),
      own = (options.euid ?? (() => process.geteuid?.()))();
    return info.isDirectory() && uid(info.uid) && uid(own) && own === info.uid ? info.uid : undefined;
  } catch {
    return undefined;
  }
}
export async function processOwnsVault(root: string, options: LocalAccountOptions = {}): Promise<boolean> {
  return platformOf(options) !== "darwin" || (await vaultAccountUid(root, options)) !== undefined;
}
function host(address: string | undefined): string | undefined {
  const value = address?.startsWith("::ffff:") ? address.slice(7) : address;
  return value === "127.0.0.1" ? value : value === "::1" ? "[::1]" : undefined;
}
function peerName(socket: Socket): string | undefined {
  const local = host(socket.localAddress),
    remote = host(socket.remoteAddress);
  if (socket.destroyed || !local || !remote || !socket.localPort || !socket.remotePort) return undefined;
  return `${remote}:${socket.remotePort}->${local}:${socket.localPort}`;
}
/** NUL field mode: p/u describe a process; f/n/T describe each file within it.
 * Only the client-side inverse tuple in ESTABLISHED state is evidence. The
 * accepted server-side socket belongs to us and cannot identify the client. */
export function parseLsofPeerUid(output: string, socket: Socket): number | undefined {
  const expected = peerName(socket);
  if (!expected) return undefined;
  let processUid: number | undefined,
    name: string | undefined,
    state: string | undefined,
    hasProcess = false;
  const found: Array<number | undefined> = [];
  const flush = () => {
    if (name === expected && state === "ESTABLISHED") found.push(processUid);
    name = state = undefined;
  };
  for (const raw of output.split("\0")) {
    const field = raw.replace(/^\n/, "");
    if (/^p\d+$/.test(field)) {
      flush();
      processUid = undefined;
      hasProcess = Number(field.slice(1)) > 0;
    } else if (/^u\d+$/.test(field)) {
      const parsed = Number(field.slice(1));
      processUid = hasProcess && uid(parsed) ? parsed : undefined;
    } else if (field.startsWith("f")) flush();
    else if (field.startsWith("n")) name = field.slice(1);
    else if (field.startsWith("TST=")) state = field.slice(4);
  }
  flush();
  return found.length && found.every((value) => uid(value) && value === found[0]) ? found[0] : undefined;
}
/** The gateway runs as a launchd Background job, so lsof inherits throttled
 * CPU/IO: one scan takes ~150 ms and parallel scans add up past tight limits. */
const LOCAL_ACCOUNT_LOOKUP_TIMEOUT_MS = 2000;
const LOOKUP_ATTEMPTS = 2;
export type PortScan = (port: number) => Promise<string>;
/** macOS ships lsof. Its Darwin backend reads pbi_uid and TCP endpoints through
 * libproc (PROC_PIDTASKALLINFO / PROC_PIDFDSOCKETINFO); no privilege escalation. */
const lsofScan: PortScan = (port) =>
  new Promise<string>((resolve, reject) =>
    execFile(
      "/usr/sbin/lsof",
      ["-nP", "-a", `-iTCP:${port}`, "-sTCP:ESTABLISHED", "-F0pufnT"],
      {
        timeout: LOCAL_ACCOUNT_LOOKUP_TIMEOUT_MS,
        maxBuffer: 128 * 1024,
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C" },
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout))
    )
  );
/** One scan lists every established connection on the port, so concurrent
 * sockets share the next scan that has not started yet. A socket never joins a
 * running scan: every answer comes from a scan that began after its accept.
 * At most one scan per port runs at a time. Each socket is still matched by its
 * own exact endpoint tuple. Only a definite UID ends early; a failure, timeout or
 * missing row is retried once and then stays closed. */
export function createPeerUidLookup(scan: PortScan) {
  const ports = new Map<number, { tail: Promise<void>; waiting?: Promise<string> }>();
  const nextScan = (port: number): Promise<string> => {
    let state = ports.get(port);
    if (!state) {
      state = { tail: Promise.resolve() };
      ports.set(port, state);
    }
    const current = state;
    if (current.waiting) return current.waiting;
    const waiting: Promise<string> = current.tail.then(() => {
      if (current.waiting === waiting) current.waiting = undefined;
      return scan(port);
    });
    const tail = waiting.then(
      () => {},
      () => {}
    );
    current.waiting = waiting;
    current.tail = tail;
    void tail.then(() => {
      if (current.tail === tail && ports.get(port) === current) ports.delete(port);
    });
    return waiting;
  };
  return async (socket: Socket): Promise<number | undefined> => {
    for (let attempt = 0; attempt < LOOKUP_ATTEMPTS && peerName(socket); attempt++) {
      try {
        const found = parseLsofPeerUid(await nextScan(socket.localPort!), socket);
        if (found !== undefined) return found;
      } catch {
        /* retried once, then closed */
      }
    }
    return undefined;
  };
}
export const macosPeerUid = createPeerUidLookup(lsofScan);
/** True only where the peer account check above really runs (this release: macOS). */
export function accountBindingEnforced(options: LocalAccountOptions = {}): boolean {
  return platformOf(options) === "darwin";
}
/** Default of `ui.enabled` (owner decision 2026-11-16, v1.2.0): the web UI is on
 * by default only where it is bound to the vault owner's account. A stored
 * `ui.enabled` always wins over this default. */
export function webUiOnByDefault(options: LocalAccountOptions = {}): boolean {
  return accountBindingEnforced(options);
}
export function localAccountPath(url: string): boolean {
  let path: string;
  try {
    path = new URL(url, "http://localhost").pathname;
  } catch {
    return true;
  }
  return (
    path === "/ui" || path.startsWith("/ui/") || path.startsWith("/api/v1/tasks") || path.startsWith("/api/v1/task_")
  );
}
/** Cache follows the actual live Socket, not a port/PID or a time-based tuple.
 * Check liveness again after inspection. A closed/reconnected object starts over. */
export function createLocalAccountGuard(ownerUid: number | undefined, options: LocalAccountOptions = {}) {
  const peers = new WeakMap<Socket, { tuple: string; value: Promise<number | undefined> }>();
  return async (socket: Socket): Promise<boolean> => {
    if (platformOf(options) !== "darwin") return true; // This release's account binding is macOS-specific.
    const tuple = peerName(socket);
    if (!uid(ownerUid) || !tuple) return false;
    let cached = peers.get(socket);
    if (!cached || cached.tuple !== tuple) {
      cached = { tuple, value: (options.lookup ?? macosPeerUid)(socket).catch(() => undefined) };
      peers.set(socket, cached);
      socket.once("close", () => peers.delete(socket));
    }
    return (await cached.value) === ownerUid && peerName(socket) === tuple;
  };
}
