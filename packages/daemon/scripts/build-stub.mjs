#!/usr/bin/env node
/**
 * build-stub.mjs — compile stub/bastra-hook.ts with deno (#344).
 *
 * One place for the permission flags: they are the stub's security contract
 * (network limited to loopback; exec limited to `sh`/`ps` on Unix and
 * `cmd`/`mode` on Windows for the statusline — shells still run commands, so this is
 * defence in depth, not a sandbox, and read/write/env are unscoped), and the
 * release workflow compiles the same file once
 * per target (#350). Two package.json strings carrying the same flag list is
 * how they drift.
 *
 *   node scripts/build-stub.mjs                  # host binary → stub/bastra-hook
 *   node scripts/build-stub.mjs --target <t>     # cross-compile → stub/bastra-hook-<t>
 *
 * <t> is a deno target triple, e.g. aarch64-apple-darwin, x86_64-apple-darwin,
 * x86_64-unknown-linux-gnu, aarch64-unknown-linux-gnu, x86_64-pc-windows-msvc. The statusline bundle
 * (packages/statusline/dist) must be built first — the stub embeds it.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { STUB_BUILD_INFO, statuslineBundleDigest, stubSourceDigest, stubSourcesDirty } from "./stub-source-digest.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const ti = args.indexOf("--target");
const target = ti >= 0 ? args[ti + 1] : null;
if (ti >= 0 && !target) {
  console.error("usage: node scripts/build-stub.mjs [--target <triple>] [--output <path>]");
  process.exit(2);
}
const oi = args.indexOf("--output");
const explicitOutput = oi >= 0 ? args[oi + 1] : null;
if (oi >= 0 && !explicitOutput) {
  console.error("usage: node scripts/build-stub.mjs [--target <triple>] [--output <path>]");
  process.exit(2);
}
// `--output` exists for the parity guard (#546): it builds a binary of its own
// in a temp dir rather than overwriting the one the developer's hooks are
// currently running. Without it, `npm test` would replace a live binary.
const windows = target ? target.endsWith("-windows-msvc") : process.platform === "win32";
const suffix = windows ? ".exe" : "";
const output = explicitOutput ?? (target ? `stub/bastra-hook-${target}${suffix}` : `stub/bastra-hook${suffix}`);

// A sibling temporary directory keeps rename on the same filesystem. Deno may
// unlink its output before compilation; it must never see the published path.
const finalOutput = resolve(packageRoot, output);
mkdirSync(dirname(finalOutput), { recursive: true });
const staging = mkdtempSync(join(dirname(finalOutput), ".bastra-hook-build-"));
const stagedOutput = join(staging, windows ? "bastra-hook.exe" : "bastra-hook");
const denoArgs = [
  "compile",
  ...(target ? ["--target", target] : []),
  // The stub has no npm dependencies. The import map points the shared
  // dependency-free core path helper at its local source.
  // Without this flag deno sees the workspace package.json, switches to
  // bring-your-own-node_modules and embeds the whole node_modules tree: the
  // 168 MB binary #350 is named after carried ~108 MB of it, and a build on
  // a fuller checkout reached 723 MB. With it the binary is the deno runtime
  // plus ~150 KB of our code.
  "--no-npm",
  "--import-map=stub/import-map.json",
  "--sloppy-imports",
  "--allow-net=127.0.0.1",
  "--allow-env",
  "--allow-read",
  "--allow-write",
  "--allow-sys",
  windows ? "--allow-run=cmd,cmd.exe,mode,mode.com" : "--allow-run=sh,/bin/sh,ps",
  "--output", stagedOutput,
  "stub/bastra-hook.ts",
];

/**
 * Stamp the build into the binary (#546).
 *
 * A compiled stub has no sources next to it, so "was this built from the
 * sources that are here now?" is only answerable if the binary carries the
 * answer. The digest goes in through a generated module the stub imports —
 * `deno compile` embeds it like any other — and the placeholder is put back
 * afterwards, so a build never leaves the working tree dirty and running the
 * stub from source keeps reporting "no build" (stub/build-info.ts).
 */
function git(...a) {
  try {
    return execFileSync("git", ["-C", packageRoot, ...a], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15_000,
    }).trim();
  } catch {
    return null;
  }
}

// Everything the stamp says is read BEFORE the stamp is written, so the build
// can never describe a tree its own output has already changed. Since #546 the
// dirty flag is scoped to the stub's source closure, which excludes this file,
// that ordering is belt and braces rather than the load-bearing part — but a
// stamp that reads the world after changing it is the kind of detail that goes
// wrong later.
const info = {
  source_digest: stubSourceDigest(),
  revision: git("rev-parse", "HEAD"),
  dirty: stubSourcesDirty(),
  built_at: new Date().toISOString(),
  // The statusline bundle rides inside the same binary but is not in the stub's
  // source closure, so until #547 a fresh binary could carry a statusline built
  // from anything at all and still report itself current. Read here, from the
  // very bundle `deno compile` is about to embed.
  statusline_digest: statuslineBundleDigest(),
};

const placeholder = readFileSync(STUB_BUILD_INFO, "utf8");
const stamped = placeholder.replace(
  /export const STUB_BUILD_INFO: StubBuildInfo = \{[\s\S]*?\n\};/,
  "export const STUB_BUILD_INFO: StubBuildInfo = " + JSON.stringify(info, null, 2) + ";",
);
if (stamped === placeholder) {
  console.error("error: could not stamp stub/build-info.ts — its STUB_BUILD_INFO declaration moved");
  rmSync(staging, { recursive: true, force: true });
  process.exit(1);
}

let r;
// Ctrl-C reaches this process and deno alike. With no handler installed node
// dies on the spot and the `finally` below never runs, leaving the tracked
// build-info.ts stamped — and the next build would keep that stamp as its
// "placeholder". A handler keeps node alive until spawnSync returns, so
// handled signals let the finally restore it. A signal sent only to node may
// not stop deno; preserve that signal as the eventual exit status too.
let interrupted = null;
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => { interrupted ??= sig; });
}
try {
  writeFileSync(STUB_BUILD_INFO, stamped, "utf8");
  r = spawnSync("deno", denoArgs, { cwd: packageRoot, stdio: "inherit" });
} finally {
  writeFileSync(STUB_BUILD_INFO, placeholder, "utf8");
}
// spawnSync blocked signal callbacks. Give them one event-loop turn before a
// synchronous process.exit can turn a parent-only SIGTERM/SIGHUP into success.
await new Promise((resolve) => setImmediate(resolve));
const signal = interrupted ?? r.signal;
if (signal) {
  rmSync(staging, { recursive: true, force: true });
  process.exit({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }[signal] ?? 1);
}
if (r.error) {
  rmSync(staging, { recursive: true, force: true });
  console.error(`error: could not run deno (${r.error.message}) — install it from https://deno.com`);
  process.exit(1);
}
try {
  if (r.status !== 0) process.exitCode = r.status ?? 1;
  else {
    if (!statSync(stagedOutput).isFile() || statSync(stagedOutput).size === 0) throw new Error("compiler produced no usable binary");
    // Cross-target executables cannot run here. Release CI verifies its native
    // target independently before upload; every native publication is stamped.
    const hostTarget = `${process.arch === "arm64" ? "aarch64" : "x86_64"}-${process.platform === "darwin" ? "apple-darwin" : process.platform === "win32" ? "pc-windows-msvc" : "unknown-linux-gnu"}`;
    if (!target || target === hostTarget) {
      const check = spawnSync(stagedOutput, ["version"], { encoding: "utf8", timeout: 5000 });
      let stamp;
      try { stamp = JSON.parse(check.stdout); } catch { /* invalid binary */ }
      if (check.error || check.status !== 0 || !stamp || stamp.source_digest !== info.source_digest ||
          info.statusline_digest === null || stamp.statusline_digest !== info.statusline_digest) {
        throw new Error("compiled hook does not contain the current hook and statusline");
      }
    }
    renameSync(stagedOutput, finalOutput);
  }
} catch (error) {
  console.error(`error: hook build not published: ${error.message}`);
  process.exitCode = 1;
} finally {
  rmSync(staging, { recursive: true, force: true });
}
