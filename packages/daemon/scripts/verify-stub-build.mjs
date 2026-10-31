#!/usr/bin/env node
// Release/deploy activation guard: compare the actual executable, not mtimes
// or its git revision (which changes for unrelated documentation commits).
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stubSourceDigest, statuslineBundleDigest } from "./stub-source-digest.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const binary = resolve(process.argv[2] ?? resolve(packageRoot, "stub", process.platform === "win32" ? "bastra-hook.exe" : "bastra-hook"));
const run = spawnSync(binary, ["version"], { encoding: "utf8", timeout: 5000 });
let stamp;
try { stamp = JSON.parse(run.stdout); } catch { /* unusable binary */ }
const bundle = statuslineBundleDigest();
if (run.error || run.status !== 0 || !stamp || stamp.source_digest !== stubSourceDigest() ||
    bundle === null || stamp.statusline_digest !== bundle) {
  console.error(`Hook build verification failed: ${binary} is missing, unusable, or does not contain the current hook and statusline. Rebuild before activation.`);
  process.exit(1);
}
console.log(`Verified current hook and embedded statusline: ${binary}`);
