import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Exercise the real build orchestration with a fake compiler, without fetching
// a runtime or executing a Windows binary. Actual cross-compilation is separate.
test("Windows cross-build produces the named .exe with Windows permissions and restores stamp", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "bastra-windows-build-"));
  try {
    for (const dir of ["scripts", "stub", "bin"]) mkdirSync(join(root, dir));
    for (const file of ["build-stub.mjs", "stub-source-digest.mjs"]) copyFileSync(resolve(import.meta.dirname, "../scripts", file), join(root, "scripts", file));
    copyFileSync(resolve(import.meta.dirname, "../stub/build-info.ts"), join(root, "stub/build-info.ts"));
    const placeholder = readFileSync(join(root, "stub/build-info.ts"), "utf8");
    writeFileSync(join(root, "stub/bastra-hook.ts"), 'import { STUB_BUILD_INFO } from "./build-info.ts";\nconsole.log(STUB_BUILD_INFO);\n');
    writeFileSync(join(root, "bin/deno"), `#!${process.execPath}\nconst fs = require('node:fs'); const args = process.argv.slice(2); fs.writeFileSync('args.json', JSON.stringify(args)); fs.writeFileSync(args[args.indexOf('--output') + 1], 'fixture compiler output');\n`);
    chmodSync(join(root, "bin/deno"), 0o755);
    const result = spawnSync(process.execPath, [join(root, "scripts/build-stub.mjs"), "--target", "x86_64-pc-windows-msvc"], { encoding: "utf8", env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}` } });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(join(root, "stub/bastra-hook-x86_64-pc-windows-msvc.exe")));
    const args = JSON.parse(readFileSync(join(root, "args.json"), "utf8")) as string[];
    assert.equal(args[args.indexOf("--target") + 1], "x86_64-pc-windows-msvc");
    assert.ok(args.includes("--allow-run=cmd,cmd.exe,mode,mode.com"));
    assert.ok(!args.includes("--allow-run=sh,/bin/sh,ps"));
    assert.ok(args.includes("--no-npm"));
    assert.ok(args.includes("--import-map=stub/import-map.json"));
    assert.equal(readFileSync(join(root, "stub/build-info.ts"), "utf8"), placeholder);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
