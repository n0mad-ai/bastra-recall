import { mock } from "node:test";

/** Run a semantic lane assertion without charging real runner stalls to its
 * deadline. The independent expiry controls use production time and timers. */
export async function withFixtureClock<T>(run: () => Promise<T>): Promise<T> {
  mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  try {
    return await run();
  } finally {
    mock.timers.reset();
  }
}
