/**
 * #1650: the authoritative settings record, read off the event loop.
 *
 * `readRuntimeSettingsRecord` is synchronous (statSync, a synchronous SQLite
 * open and query). On a per-edit path that has a deadline, a stalled disk
 * under the data directory would stop the daemon's whole event loop there,
 * before any timer can fire. So the read runs in one long-lived worker
 * thread; the caller waits for it only until its deadline. A worker that
 * misses a deadline is told to stop — it may be stuck in the stalled read,
 * and a native read cannot be interrupted. Until it has really exited, no
 * further worker is started: requests with a deadline get no answer at once,
 * so a lasting stall costs one thread, not one per request.
 *
 * A worker that has not finished starting (thread, modules) is not stuck: it
 * has not begun any read. A deadline that passes before it reports ready
 * fails only that request; the worker stays. The daemon starts the worker at
 * boot ({@link warmSettingsReader}) so the first edit does not pay the
 * start-up inside its deadline.
 *
 * Same answer as the direct call: undefined = no record, null = record
 * deleted or database unavailable. The environment is shared with the worker
 * (SHARE_ENV), so BASTRA_DB_PATH changes reach it. A worker that cannot run
 * at all (it inherits the parent's flags, and a `node --input-type … -e`
 * parent refuses a file entry point) gives a deadline-bound caller no answer
 * either; only a caller without a deadline falls back to the direct read,
 * as it does while a stuck worker is still alive.
 *
 * This file is also the worker's entry point.
 */
import { SHARE_ENV, Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { readRuntimeSettingsRecord } from "./runtime-feature-settings.js";

const ROLE = "bastra-settings-record-reader";

type Request = { id: number; legacyPath: string };
type Reply = { id: number; text: string | null | undefined };
/** The worker's first message: loaded and listening, no read begun yet. */
const READY = "ready";

if (!isMainThread && workerData === ROLE) {
  parentPort?.on("message", ({ id, legacyPath }: Request) => {
    parentPort?.postMessage({ id, text: readRuntimeSettingsRecord(legacyPath) } satisfies Reply);
  });
  parentPort?.postMessage(READY);
}

/** Raised when the record has not arrived by the caller's deadline, or
 * cannot arrive in time because no reader can run. */
export class SettingsReadLate extends Error {}

type Reader = {
  worker: Worker;
  pending: Map<number, (reply: Reply | Error) => void>;
  /** Settles once the worker is ready or gone. */
  started: Promise<void>;
  ready: boolean;
};
let reader: Reader | undefined;
/** A reader that missed a deadline and has not exited yet. */
let stuck: Reader | undefined;
let nextId = 0;

function startReader(): Reader {
  const worker = new Worker(new URL(import.meta.url), { workerData: ROLE, env: SHARE_ENV });
  let markStarted = () => {};
  const started = new Promise<void>((resolve) => (markStarted = resolve));
  const current: Reader = { worker, pending: new Map(), started, ready: false };
  const fail = (why: string) => {
    if (reader === current) reader = undefined;
    for (const id of [...current.pending.keys()]) settle(current, id, new Error(why));
  };
  worker.on("exit", () => {
    if (stuck === current) stuck = undefined;
    markStarted();
  });
  worker.on("message", (reply: Reply | typeof READY) => {
    if (reply !== READY) return settle(current, reply.id, reply);
    current.ready = true;
    // From here an idle reader never keeps the process alive; see settle().
    if (current.pending.size === 0) worker.unref();
    markStarted();
  });
  worker.on("error", () => fail("settings reader failed"));
  worker.on("exit", () => fail("settings reader exited"));
  return current;
}

/** Answers one request; the worker holds the process open only while one is pending. */
function settle(current: Reader, id: number, reply: Reply | Error): void {
  const answer = current.pending.get(id);
  current.pending.delete(id);
  if (current.pending.size === 0) current.worker.unref();
  answer?.(reply);
}

function request(legacyPath: string, deadline: number): Promise<string | null | undefined> {
  const current = (reader ??= startReader());
  const id = nextId++;
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    current.pending.set(id, (reply) => {
      clearTimeout(timer);
      if (reply instanceof Error) reject(reply);
      else resolve(reply.text);
    });
    if (deadline !== Infinity) {
      timer = setTimeout(
        () => {
          const late = new SettingsReadLate("settings read missed its deadline");
          // Still starting: no read is running, so the worker is not stuck.
          // It answers this request later, to nobody.
          if (!current.ready) return settle(current, id, late);
          // The worker may be stuck in the read: drop it with everything it
          // owes, since later requests queue behind that read.
          if (reader === current) reader = undefined;
          stuck = current;
          for (const owed of [...current.pending.keys()]) settle(current, owed, late);
          void current.worker.terminate();
        },
        Math.max(0, deadline - Date.now())
      );
    }
    current.worker.ref();
    current.worker.postMessage({ id, legacyPath } satisfies Request);
  });
}

/** Starts the reader ahead of the first deadline-bound request; resolves
 * once it is ready (or could not start). */
export function warmSettingsReader(): Promise<void> {
  if (stuck) return Promise.resolve();
  return (reader ??= startReader()).started;
}

/** The settings record for `legacyPath`; a {@link SettingsReadLate} rejection
 * once `deadline` (epoch ms) has passed without an answer. */
export async function readSettingsRecordOffThread(
  legacyPath: string,
  deadline = Infinity
): Promise<string | null | undefined> {
  if (stuck && deadline !== Infinity) throw new SettingsReadLate("settings reader still stuck in a read");
  if (stuck) return readRuntimeSettingsRecord(legacyPath);
  try {
    return await request(legacyPath, deadline);
  } catch (error) {
    if (error instanceof SettingsReadLate) throw error;
    if (deadline !== Infinity) throw new SettingsReadLate("settings reader unavailable");
    return readRuntimeSettingsRecord(legacyPath);
  }
}
