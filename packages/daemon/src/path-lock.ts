/**
 * Per-path write serialisation (#240/A9, #529).
 *
 * Every read-modify-write against a small state file has the same defect when
 * nothing serialises it: Node serves overlapping HTTP requests — and a plain
 * `Promise.all` of CLI/UI calls — concurrently, so all writers read the same
 * old content and the last write wins. Measured for the floor registry (#240):
 * 12 parallel adds → 1 persisted, every call returning HTTP 200 so the caller
 * could not notice. Measured again for the import stores (#529): 80 concurrent
 * `stageImport()` calls reported 80 staged candidates with 1 on disk, and 80
 * concurrent `buildQueue()` calls reported 80 queued conversations with 1 on
 * disk.
 *
 * A per-path promise chain is enough: this is a single local daemon, the state
 * files are tiny, and the writes themselves are atomic (tmp+rename). It does
 * NOT guard against a second process — that would need real file locking,
 * which these features do not warrant.
 */
const pathLocks = new Map<string, Promise<unknown>>();

/**
 * Runs `fn` once every earlier holder of `path` has finished. The chain
 * survives a rejection: a failing writer never poisons the next waiter, and
 * the caller still sees its own error.
 */
export function withPathLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = pathLocks.get(path) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  pathLocks.set(
    path,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}
