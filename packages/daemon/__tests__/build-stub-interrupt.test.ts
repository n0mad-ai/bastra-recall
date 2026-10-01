/**
 * scripts/build-stub.mjs stamps the tracked stub/build-info.ts, runs
 * `deno compile` through spawnSync, and puts the placeholder back in a
 * `finally`. spawnSync blocks the event loop and node's default SIGINT action
 * kills the process without running that `finally`, so an interrupted build
 * left the tracked file stamped — and the next build kept the stamp as its
 * "placeholder".
 *
 * The script runs in a throwaway package root with a fake `deno` that hangs,
 * and the whole process group gets the SIGINT a terminal Ctrl-C would send.
 *
 * Run: npx tsx --test packages/daemon/__tests__/build-stub-interrupt.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPTS = resolve(import.meta.dirname, "..", "scripts");
const REAL_BUILD_INFO = resolve(import.meta.dirname, "..", "stub", "build-info.ts");

test("Ctrl-C during deno compile restores stub/build-info.ts", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "bastra-build-stub-"));
  try {
    mkdirSync(join(root, "scripts"), { recursive: true });
    mkdirSync(join(root, "stub"), { recursive: true });
    mkdirSync(join(root, "bin"), { recursive: true });
    for (const f of ["build-stub.mjs", "stub-source-digest.mjs"]) copyFileSync(join(SCRIPTS, f), join(root, "scripts", f));
    copyFileSync(REAL_BUILD_INFO, join(root, "stub", "build-info.ts"));
    writeFileSync(join(root, "stub", "bastra-hook.ts"), 'import { STUB_BUILD_INFO } from "./build-info.ts";\nconsole.log(STUB_BUILD_INFO);\n');
    const started = join(root, "deno-started");
    writeFileSync(join(root, "bin", "deno"), `#!/bin/sh\ntouch "${started}"\nsleep 30\n`);
    chmodSync(join(root, "bin", "deno"), 0o755);
    const placeholder = readFileSync(join(root, "stub", "build-info.ts"), "utf8");

    const child = spawn(process.execPath, [join(root, "scripts", "build-stub.mjs")], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}` },
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) =>
      child.on("close", (code, signal) => done({ code, signal })),
    );
    for (let i = 0; i < 200 && !existsSync(started); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(existsSync(started), "the fake deno never started");
    assert.notEqual(readFileSync(join(root, "stub", "build-info.ts"), "utf8"), placeholder, "the stamp was not written before deno ran");

    process.kill(-(child.pid as number), "SIGINT");
    const { code, signal } = await exited;

    assert.equal(readFileSync(join(root, "stub", "build-info.ts"), "utf8"), placeholder, "an interrupted build left build-info.ts stamped");
    assert.equal(signal, null, "node died on the signal instead of unwinding");
    assert.equal(code, 130);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
