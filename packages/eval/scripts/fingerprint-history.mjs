#!/usr/bin/env node
/**
 * Match a registered source fingerprint to the commits that produce it (#1536).
 *
 * Several eval runners hash their own source text into their artefact as proof
 * of origin. The one-time Prettier commit 0f9f0604 changed those bytes without
 * changing behaviour, so a rerun carries another fingerprint than the frozen
 * registration and looks like a code change. Registrations are never
 * rewritten; instead this recomputes every recipe at every commit that touched
 * its inputs, so a registered hash is placed in history without guessing.
 *
 *   node packages/eval/scripts/fingerprint-history.mjs            # table for all recipes
 *   node packages/eval/scripts/fingerprint-history.mjs <sha256>   # where does this hash come from
 *   node packages/eval/scripts/fingerprint-history.mjs --json     # every history as JSON
 *
 * A row's commit range lists only the commits that touched the recipe's inputs;
 * the fingerprint holds from its first commit up to the next row's.
 *
 * Read-only: `git log` and `git show` only. The recipes mirror the runners
 * byte for byte; `__tests__/fingerprint-history.test.ts` recomputes every pair
 * of `registrations/fingerprint-map-1536.json` from git with them.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SRC = "packages/eval/src/";
const SCRIPTS = "packages/eval/scripts/";
export const FORMATTER_COMMIT = "0f9f0604";

/** Each recipe: the files it reads (repo-relative) and how it combines them. */
export const RECIPES = {
  "longmemeval-run.ts code_hash": {
    files: [`${SRC}longmemeval-run.ts`, `${SRC}longmemeval-dataset.ts`],
    hash: (bufs) => bufs.reduce((h, b) => h.update(b.toString("utf8")), createHash("sha256")).digest("hex"),
  },
  "chunk-maxsim-run.ts code": {
    files: ["chunk-maxsim-run.ts", "chunk-maxsim.ts", "longmemeval-run.ts", "longmemeval-dataset.ts"].map(
      (f) => SRC + f
    ),
    hash: (bufs, files) =>
      bufs.reduce((h, b, i) => h.update(files[i].slice(SRC.length)).update(b), createHash("sha256")).digest("hex"),
  },
  "chunk-vault-coverage.ts code_sha256": {
    files: [`${SRC}chunk-vault-coverage.ts`, `${SRC}chunk-maxsim.ts`],
    hash: (bufs) => bufs.reduce((h, b) => h.update(b), createHash("sha256")).digest("hex"),
  },
  "evidence-windows-run.ts implementation_sha256": {
    files: [`${SRC}evidence-windows.ts`, `${SRC}evidence-windows-run.ts`],
    hash: (bufs) =>
      createHash("sha256")
        .update(bufs.map((b) => b.toString("utf8")).join(""))
        .digest("hex"),
  },
  "goldset-run.ts hashes.code": {
    files: ["goldset-run.ts", "goldset-dataset.ts", "goldset.ts"].map((f) => SRC + f),
    hash: (bufs) =>
      createHash("sha256")
        .update(bufs.map((b) => b.toString("utf8")).join("\n"))
        .digest("hex"),
  },
  ...Object.fromEntries(
    [
      `${SRC}flat-scale-subset.ts`,
      `${SRC}supersession-durability.ts`,
      `${SRC}supersession-hybrid.ts`,
      `${SRC}correction-sequences.ts`,
      `${SCRIPTS}draft-csls.mjs`,
      `${SCRIPTS}mcp-scope-shadow.py`,
      `${SCRIPTS}model2vec-local-check.py`,
      `${SCRIPTS}recount-test-events.py`,
    ].map((f) => [
      `${f.split("/").at(-1)} code_sha256 (own bytes)`,
      { files: [f], hash: (bufs) => createHash("sha256").update(bufs[0]).digest("hex") },
    ])
  ),
};

const git = (args) =>
  execFileSync("git", args, { encoding: "buffer", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] });

function showAt(commit, file) {
  try {
    return git(["show", `${commit}:${file}`]);
  } catch {
    return null;
  }
}

/** Every distinct fingerprint of a recipe, with the commits that produce it, oldest first. */
export function history(recipe) {
  const commits = git(["log", "--format=%H", "--reverse", "--", ...recipe.files])
    .toString("utf8")
    .split("\n")
    .filter(Boolean);
  const out = [];
  for (const c of commits) {
    const bufs = recipe.files.map((f) => showAt(c, f));
    if (bufs.some((b) => b === null)) continue;
    const h = recipe.hash(bufs, recipe.files);
    const last = out.at(-1);
    if (last && last.sha256 === h) last.last_commit = c;
    else out.push({ sha256: h, first_commit: c, last_commit: c });
  }
  return out;
}

function main() {
  if (process.argv[2] === "--json") {
    const all = Object.fromEntries(Object.entries(RECIPES).map(([name, r]) => [name, history(r)]));
    console.log(JSON.stringify(all, null, 2));
    return;
  }
  const wanted = process.argv[2];
  const formatter = git(["rev-parse", FORMATTER_COMMIT]).toString("utf8").trim();
  for (const [name, recipe] of Object.entries(RECIPES)) {
    const rows = history(recipe);
    const hit = wanted ? rows.filter((r) => r.sha256.startsWith(wanted)) : rows;
    if (!hit.length) continue;
    console.log(`\n${name}`);
    for (const r of hit) {
      const tag = r.first_commit === formatter ? "   <- Prettier commit, behaviour-neutral" : "";
      console.log(`  ${r.sha256}  ${r.first_commit.slice(0, 8)}..${r.last_commit.slice(0, 8)}${tag}`);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
