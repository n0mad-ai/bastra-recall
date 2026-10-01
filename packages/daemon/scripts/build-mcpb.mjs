#!/usr/bin/env node
/**
 * Build the Claude Desktop Extension (.mcpb) — the double-click install
 * path: manifest + icon + the published npm package as the bundled server.
 *
 *   node scripts/build-mcpb.mjs            # pull @bastra-recall/* from npm
 *   node scripts/build-mcpb.mjs --local    # pack the workspace tarballs
 *                                          # (CI release path — no registry
 *                                          # propagation race; the same pack
 *                                          # as npm publish, but WITHOUT
 *                                          # stub/manifest.json, which only
 *                                          # the npm publish job writes)
 *
 * Output: mcpb/bastra-recall-<version>.mcpb
 * Staging (mcpb/build/) and the .mcpb artifact are gitignored.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const daemonRoot = resolve(here, "..");
const repoRoot = resolve(daemonRoot, "..", "..");
const mcpbDir = join(daemonRoot, "mcpb");
const buildDir = join(mcpbDir, "build");
const local = process.argv.includes("--local");

const version = JSON.parse(readFileSync(join(daemonRoot, "package.json"), "utf8")).version;

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: "inherit" });

// 1. Clean staging. The server dir gets its OWN package.json so npm anchors
// there — without it, npm climbs up to the daemon workspace and rewrites
// the real package.json/lockfile.
rmSync(buildDir, { recursive: true, force: true });
mkdirSync(join(buildDir, "server"), { recursive: true });
writeFileSync(
  join(buildDir, "server", "package.json"),
  JSON.stringify({ name: "bastra-recall-mcpb-server", version: "0.0.0", private: true }, null, 2) + "\n",
  "utf8",
);

// 2. Manifest from template + icon.
const manifest = readFileSync(join(mcpbDir, "manifest.template.json"), "utf8").replaceAll("__VERSION__", version);
writeFileSync(join(buildDir, "manifest.json"), manifest, "utf8");
cpSync(join(mcpbDir, "icon.png"), join(buildDir, "icon.png"));

// 3. Install the server package (+ deps) into the bundle.
const installArgs = ["install", "--omit=dev", "--no-audit", "--no-fund", "--install-links=false"];
if (local) {
  // npm pack runs each workspace's prepack (asset staging) — the tarballs
  // are exactly what a release publishes.
  const tarballDir = join(buildDir, "tarballs");
  mkdirSync(tarballDir, { recursive: true });
  for (const ws of ["packages/core", "packages/statusline", "packages/daemon"]) {
    run("npm", ["pack", "--pack-destination", tarballDir], join(repoRoot, ws));
  }
  const tarballs = readdirSync(tarballDir).filter((f) => f.endsWith(".tgz")).map((f) => join(tarballDir, f));
  run("npm", [...installArgs, ...tarballs], join(buildDir, "server"));
  rmSync(tarballDir, { recursive: true, force: true });
} else {
  run("npm", [...installArgs, `@bastra-recall/daemon@${version}`], join(buildDir, "server"));
}

// 4. Sanity: the entry point must exist in the staged bundle.
const entry = join(buildDir, "server", "node_modules", "@bastra-recall", "daemon", "dist", "mcp-forwarder.js");
readFileSync(entry);

// 5. Pack + validate via the official CLI (devDependency @anthropic-ai/mcpb).
const out = join(mcpbDir, `bastra-recall-${version}.mcpb`);
rmSync(out, { force: true });
run("npx", ["mcpb", "pack", buildDir, out], repoRoot);
console.log(`\n✓ ${out}`);
