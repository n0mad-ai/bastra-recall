/**
 * Virtual time for the deterministic P2 characterization mode (#1649).
 *
 * `install` replaces the process-wide clock and timer globals with a virtual clock:
 * `Date.now` returns virtual milliseconds and `setTimeout` callbacks fire in
 * (instant, creation order) order, but only once every microtask and `nextTick`
 * callback has run. `drive` advances that clock until a promise settles. As long as
 * every other input is in-process (the stand-in feature does no I/O except
 * synchronous files), a run is therefore a pure function of its inputs: no wall
 * clock, no scheduler races. Outbound sockets and `Math.random` throw while
 * installed, so an accidental network call or unseeded draw fails loudly.
 * Only for a dedicated child process; never install it in a test runner process.
 */
import { Socket } from "node:net";

interface Timer {
  id: number;
  at: number;
  run: () => void;
}
interface Handle {
  id: number;
  ref(): Handle;
  unref(): Handle;
  hasRef(): boolean;
  [Symbol.toPrimitive](): number;
}

const realSetImmediate = setImmediate;
let now = 0;
let nextId = 0;
const timers = new Map<number, Timer>();

function handle(id: number): Handle {
  const h: Handle = {
    id,
    ref: () => h,
    unref: () => h,
    hasRef: () => true,
    [Symbol.toPrimitive]: () => id,
  };
  return h;
}

function virtualSetTimeout(callback: (...args: unknown[]) => void, ms = 0, ...args: unknown[]) {
  const id = ++nextId;
  timers.set(id, { id, at: now + Math.max(0, Number(ms) || 0), run: () => callback(...args) });
  return handle(id);
}
function virtualClearTimeout(h: Handle | number | undefined) {
  if (h !== undefined) timers.delete(Number(h));
}

export function install(start: number) {
  now = start;
  globalThis.setTimeout = virtualSetTimeout as unknown as typeof setTimeout;
  globalThis.clearTimeout = virtualClearTimeout as unknown as typeof clearTimeout;
  Date.now = () => now;
  AbortSignal.timeout = () => new AbortController().signal;
  Math.random = () => {
    throw new Error("unseeded randomness in deterministic P2 mode");
  };
  Socket.prototype.connect = () => {
    throw new Error("network disabled in deterministic P2 mode");
  };
}

/** Start a fresh virtual timeline; timers left by a previous row are dropped. */
export function reset(start: number) {
  timers.clear();
  now = start;
}

function nextTimer() {
  let next: Timer | undefined;
  for (const t of timers.values()) if (!next || t.at < next.at || (t.at === next.at && t.id < next.id)) next = t;
  return next;
}

/** Run virtual time until `work` settles; a run with nothing left to wake is a deadlock. */
export async function drive<T>(work: Promise<T>): Promise<T> {
  let settled = false;
  const watched = work.finally(() => {
    settled = true;
  });
  watched.catch(() => {});
  for (;;) {
    await new Promise((ok) => realSetImmediate(ok));
    if (settled) return watched;
    const timer = nextTimer();
    if (!timer) throw new Error("deterministic P2 run is waiting with no virtual timer left");
    timers.delete(timer.id);
    now = timer.at;
    timer.run();
  }
}
