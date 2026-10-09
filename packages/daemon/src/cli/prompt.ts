/**
 * The CLI's only interactive prompt. TTY-gated by design: in any
 * non-interactive context (piped stdin, a hook, CI, a detached background
 * process) confirm() resolves `false` immediately without reading stdin, so
 * unattended `bastra install` runs never block waiting for input that will
 * never come. This is load-bearing for the staged auto-update path.
 */
import { createInterface } from "node:readline/promises";

/** True only when BOTH stdin and stdout are real TTYs. */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * y/N confirmation, default No — or Y/n (default Yes) with `defaultYes`, where
 * a plain Enter accepts. Returns false in any non-interactive context and on
 * EOF / Ctrl-C during the prompt (even with defaultYes: silence is never
 * consent to a download). Never throws.
 */
export async function confirm(question: string, opts: { defaultYes?: boolean } = {}): Promise<boolean> {
  if (!isInteractive()) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} ${opts.defaultYes ? "[Y/n]" : "[y/N]"} `)).trim();
    if (answer === "") return Boolean(opts.defaultYes);
    return /^y(es)?$/i.test(answer);
  } catch {
    // SIGINT (Ctrl-C) rejects the pending question() — treat as "no".
    return false;
  } finally {
    rl.close();
  }
}

/**
 * One free-text answer, trimmed. Null in any non-interactive context and on
 * EOF / Ctrl-C — "no answer", which a caller must never read as a choice.
 */
export async function ask(question: string): Promise<string | null> {
  if (!isInteractive()) return null;
  return askOn(question, process.stdin, process.stdout);
}

/**
 * ask() on given streams, without the TTY gate (exported for tests).
 *
 * Ctrl-C and EOF both END the question instead of the process: this prompt
 * runs after a command has already done its work, and a Ctrl-C at the prompt
 * must not turn that command's exit code into a signal death. Closing the
 * interface is what settles the promise — `question()` alone never resolves
 * once its input is gone.
 */
export function askOn(question: string, input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Promise<string | null> {
  const rl = createInterface({ input, output });
  return new Promise((resolve) => {
    rl.once("close", () => resolve(null));
    rl.on("SIGINT", () => rl.close());
    rl.question(question).then(
      (answer) => { resolve(answer.trim()); rl.close(); },
      () => resolve(null),
    );
  });
}
