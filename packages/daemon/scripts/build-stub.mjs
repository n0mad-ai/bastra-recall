#!/usr/bin/env node
/**
 * build-stub.mjs — compile stub/bastra-hook.ts with deno (#344).
 *
 * One place for the permission flags: they are the stub's security contract
 * (loopback only, no arbitrary exec — `sh`/`ps` are what the skip gate and
 * the statusline need), and the release workflow compiles the same file once
 * per target (#350). Two package.json strings carrying the same flag list is
 * how they drift.
 *
 *   node scripts/build-stub.mjs                  # host binary → stub/bastra-hook
 *   node scripts/build-stub.mjs --target <t>     # cross-compile → stub/bastra-hook-<t>
 *
 * <t> is a deno target triple, e.g. aarch64-apple-darwin, x86_64-apple-darwin,
 * x86_64-unknown-linux-gnu, aarch64-unknown-linux-gnu. The statusline bundle
 * (packages/statusline/dist) must be built first — the stub embeds it.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
const output = explicitOutput ?? (target ? `stub/bastra-hook-${target}` : "stub/bastra-hook");

const denoArgs = [
  "compile",
  ...(target ? ["--target", target] : []),
  // The stub has no npm dependencies — node: builtins and two local modules.
  // Without this flag deno sees the workspace package.json, switches to
  // bring-your-own-node_modules and embeds the whole node_modules tree: the
  // 168 MB binary #350 is named after carried ~108 MB of it, and a build on
  // a fuller checkout reached 723 MB. With it the binary is the deno runtime
  // plus ~150 KB of our code.
  "--no-npm",
  "--sloppy-imports",
  "--allow-net=127.0.0.1",
  "--allow-env",
  "--allow-read",
  "--allow-write",
  "--allow-sys",
  "--allow-run=sh,/bin/sh,ps",
  "--output", output,
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
  process.exit(1);
}

let r;
try {
  writeFileSync(STUB_BUILD_INFO, stamped, "utf8");
  r = spawnSync("deno", denoArgs, { cwd: packageRoot, stdio: "inherit" });
} finally {
  writeFileSync(STUB_BUILD_INFO, placeholder, "utf8");
}
if (r.error) {
  console.error(`error: could not run deno (${r.error.message}) — install it from https://deno.com`);
  process.exit(1);
}
process.exit(r.status ?? 1);
