import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
const exec = promisify(execFile);
const probe = fileURLToPath(new URL("./fixtures/task-source-security.ts", import.meta.url));

test("five FIFO observations and bounded reads reject without exhausting libuv; stat and normal exit remain live", { skip: process.platform === "win32" ? "POSIX FIFO required" : false }, async () => {
  const result = await exec(process.execPath, ["--import", "tsx", probe, "fifo"], { timeout: 15000 });
  assert.match(result.stdout, /probe passed/);
});
test("descriptor-bound source/evidence reads never observe outside content during real parent-directory swaps", { skip: !["darwin", "linux"].includes(process.platform) ? "No descriptor containment binding on this platform" : false }, async () => {
  const result = await exec(process.execPath, ["--import", "tsx", probe, "swap"], { timeout: 20000 });
  assert.match(result.stdout, /probe passed/);
});

test("file source hardlinks are unavailable with a readable reason; a single-link replacement recovers", async () => {
  const result = await exec(process.execPath, ["--import", "tsx", probe, "hardlink"], { timeout: 15000 });
  assert.match(result.stdout, /probe passed/);
});
