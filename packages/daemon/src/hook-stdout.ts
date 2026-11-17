/**
 * #1573: the hook clients' answer must be fully written before they exit.
 *
 * Node writes to a pipe asynchronously on POSIX, and `process.exit()` drops a
 * write still pending ("A note on process I/O", Node.js process docs). A hook
 * answer larger than the pipe buffer (a rule kernel is up to 9,400 characters,
 * a deny plus conventions more), read by a slow host, could be cut off. The
 * clients therefore write through {@link emitStdout} and leave through
 * {@link exitAfterStdout}, which waits for the write callback — bounded, so a
 * host that never reads cannot keep the process alive.
 *
 * Stdlib-only: the compiled hook stub imports it.
 */

/** Longest wait for a pending answer; the host's own hook timeout is 2 s. */
export const STDOUT_FLUSH_MAX_MS = 1000;

let pending: Promise<void> = Promise.resolve();

/** Write `payload` to stdout and remember when it has been handed off. */
export function emitStdout(payload: string): void {
  pending = new Promise<void>((resolve) => {
    const stdout = process.stdout;
    const failed = () => resolve();
    // A broken pipe can emit "error" after the write callback has run.
    stdout.once("error", failed);
    try {
      stdout.write(payload, (error) => {
        if (!error) stdout.off("error", failed);
        resolve();
      });
    } catch {
      stdout.off("error", failed);
      resolve();
    }
  });
}

/** Resolves once the last {@link emitStdout} write finished, or after `maxMs`. */
export async function stdoutFlushed(maxMs = STDOUT_FLUSH_MAX_MS): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([pending, new Promise<void>((resolve) => (timer = setTimeout(resolve, maxMs)))]);
  clearTimeout(timer);
}

/** Exit once the answer is written (bounded by {@link STDOUT_FLUSH_MAX_MS}). */
export async function exitAfterStdout(code = 0): Promise<never> {
  await stdoutFlushed();
  process.exit(code);
}
