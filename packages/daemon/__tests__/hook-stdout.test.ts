/**
 * #1573 — a hook client's answer is written completely before it exits.
 *
 * Writes to a pipe are asynchronous on POSIX and `process.exit()` drops what
 * is still pending. A child writes an answer far larger than any pipe buffer
 * and exits through `exitAfterStdout`; the parent holds the pipe unread for a
 * moment (a slow host) and must still receive every byte. With the former
 * `process.stdout.write(...)` + `process.exit(0)` the child exits with most of
 * the answer still queued.
 *
 * Runner: npm test (scripts/test-env.mjs isolates HOME and the logs).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const helper = new URL("../src/hook-stdout.ts", import.meta.url).href;
const SIZE = 4 * 1024 * 1024;

function runChild(source: string): Promise<{ bytes: number; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let bytes = 0;
    child.stdout.pause();
    // A slow reader: nothing is read until the child has had time to exit.
    setTimeout(() => {
      child.stdout.on("data", (chunk: Buffer) => (bytes += chunk.length));
      child.stdout.resume();
    }, 300);
    child.on("error", reject);
    child.on("close", (code) => resolve({ bytes, code }));
  });
}

test("#1573: exitAfterStdout leaves only after a large answer reached a slow reader", async () => {
  const { bytes, code } = await runChild(
    `import { emitStdout, exitAfterStdout } from ${JSON.stringify(helper)};
     emitStdout("x".repeat(${SIZE}));
     void exitAfterStdout();`
  );
  assert.equal(code, 0);
  assert.equal(bytes, SIZE);
});

test("#1573: a closed host pipe does not crash the hook client", { skip: process.platform === "win32" }, async () => {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `import { emitStdout, exitAfterStdout } from ${JSON.stringify(helper)};
       emitStdout("x".repeat(${SIZE}));
       void exitAfterStdout();`,
    ],
    { stdio: ["ignore", "pipe", "pipe"], timeout: 5000 }
  );
  child.stdout.destroy();
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  assert.equal(code, 0, stderr);
  assert.equal(stderr, "");
});
