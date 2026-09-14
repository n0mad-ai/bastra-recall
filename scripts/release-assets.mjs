#!/usr/bin/env node
/**
 * release-assets.mjs — which files a complete release carries, and whether the
 * draft already carries them (#549).
 *
 *   node scripts/release-assets.mjs <tag>    # exits non-zero while any is missing
 *
 * This list used to live inline in the workflow's `promote` job, which meant it
 * could only ever be asserted as a YAML text pattern. It is a decision, not
 * formatting: `publish-release-set.mjs` asks it before it publishes the first
 * npm package, so npm `latest` cannot move while a binary, a checksum, the
 * desktop extension or a Finder installer is still missing.
 *
 * `gh` is taken from PATH, so the check is exercisable against a stub.
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Exact asset names. GitHub normalizes the spaces in the .command names to dots. */
export const REQUIRED_ASSETS = [
  "bastra-hook-x86_64-unknown-linux-gnu",
  "bastra-hook-aarch64-unknown-linux-gnu",
  "bastra-hook-x86_64-apple-darwin",
  "bastra-hook-aarch64-apple-darwin",
  "bastra-hook-x86_64-unknown-linux-gnu.sha256",
  "bastra-hook-aarch64-unknown-linux-gnu.sha256",
  "bastra-hook-x86_64-apple-darwin.sha256",
  "bastra-hook-aarch64-apple-darwin.sha256",
  "Install.Bastra.command",
  "Uninstall.Bastra.command",
];

/** The bundle carries the version in its name, so it is matched by shape. */
export const REQUIRED_ASSET_PATTERNS = [
  { label: "*.mcpb", test: (n) => /\.mcpb$/.test(n) },
  { label: "*.mcpb.sha256", test: (n) => /\.mcpb\.sha256$/.test(n) },
];

/** Everything a complete release must carry that `names` does not. */
export function missingAssets(names) {
  const have = new Set(names);
  const missing = REQUIRED_ASSETS.filter((want) => !have.has(want));
  for (const { label, test } of REQUIRED_ASSET_PATTERNS) {
    if (!names.some(test)) missing.push(label);
  }
  return missing;
}

/** The asset names attached to `tag`, draft or published. */
export function fetchAssetNames(tag, repo) {
  const args = ["release", "view", tag, "--json", "assets", "--jq", ".assets[].name"];
  if (repo) args.push("--repo", repo);
  const res = spawnSync("gh", args, { encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(
      `gh release view ${tag} failed (${res.status}):\n` +
        `${`${res.stdout ?? ""}${res.stderr ?? ""}`.trim()}`,
    );
  }
  return (res.stdout ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Throws unless `tag` already carries every required asset. Callers that are
 * about to make something public use this as a precondition.
 */
export function assertCompleteAssets(tag, repo) {
  const names = fetchAssetNames(tag, repo);
  const missing = missingAssets(names);
  if (missing.length > 0) {
    throw new Error(
      `the release ${tag} is missing ${missing.length} required asset(s):\n` +
        missing.map((m) => `  - ${m}`).join("\n"),
    );
  }
  return names;
}

// CLI: `node scripts/release-assets.mjs <tag>`
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tag = process.argv[2] ?? process.env.TAG ?? "";
  if (!tag) {
    console.error("usage: node scripts/release-assets.mjs <tag>");
    process.exit(1);
  }
  try {
    const names = assertCompleteAssets(tag, process.env.GITHUB_REPOSITORY);
    console.log(names.join("\n"));
    console.log(`✓ ${tag} carries every required release asset`);
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }
}
