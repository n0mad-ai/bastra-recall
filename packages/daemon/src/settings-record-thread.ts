/**
 * #1650: the authoritative settings record, read off the event loop.
 *
 * `readRuntimeSettingsRecord` is synchronous (statSync, a synchronous SQLite
 * open and query). On a per-edit path that has a deadline, a stalled disk
 * under the data directory would stop the daemon's whole event loop there,
 * before any timer can fire. So the read runs in one long-lived worker
 * thread; the caller waits for it only until its deadline. A worker that
 * misses a deadline is dropped — it may be stuck in the stalled read — and
 * the next call starts a fresh one.
 *
 * Same answer as the direct call: undefined = no record, null = record
 * deleted or database unavailable. The environment is shared with the worker
 * (SHARE_ENV), so BASTRA_DB_PATH changes reach it. A worker that cannot run
 * at all (it inherits the parent's flags, and a `node --input-type … -e`
 * parent refuses a file entry point) falls back to the direct read: that is
 * an immediate failure, not a stall, and the settings must still count.
 *
 * This file is also the worker's entry point.
 */
import { SHARE_ENV, Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { readRuntimeSettingsRecord } from "./runtime-feature-settings.js";

const ROLE = "bastra-settings-record-reader";

type Request = { id: number; legacyPath: string };
type Reply = { id: number; text: string | null | undefined };

if (!isMainThread && workerData === ROLE) {
  parentPort?.on("message", ({ id, legacyPath }: Request) => {
    parentPort?.postMessage({ id, text: readRuntimeSettingsRecord(legacyPath) } satisfies Reply);
  });
}

/** Raised when the record has not arrived by the caller's deadline. */
export class SettingsReadLate extends Error {}

type Reader = { worker: Worker; pending: Map<number, (reply: Reply | Error) => void> };
let reader: Reader | undefined;
let nextId = 0;

function startReader(): Reader {
  const worker = new Worker(new URL(import.meta.url), { workerData: ROLE, env: SHARE_ENV });
  worker.unref(); // an idle reader never keeps the process alive; see settle()
  const current: Reader = { worker, pending: new Map() };
  const fail = (why: string) => {
    if (reader === current) reader = undefined;
    for (const id of [...current.pending.keys()]) settle(current, id, new Error(why));
  };
  worker.on("message", (reply: Reply) => settle(current, reply.id, reply));
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
          // The worker may be stuck in the read: drop it with everything it
          // owes, since later requests queue behind that read.
          if (reader === current) reader = undefined;
          const late = new SettingsReadLate("settings read missed its deadline");
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

/** The settings record for `legacyPath`; a {@link SettingsReadLate} rejection
 * once `deadline` (epoch ms) has passed without an answer. */
export async function readSettingsRecordOffThread(
  legacyPath: string,
  deadline = Infinity
): Promise<string | null | undefined> {
  try {
    return await request(legacyPath, deadline);
  } catch (error) {
    if (error instanceof SettingsReadLate) throw error;
    return readRuntimeSettingsRecord(legacyPath);
  }
}
