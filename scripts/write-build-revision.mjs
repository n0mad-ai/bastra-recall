#!/usr/bin/env node
/**
 * Stamp a build with the revision it was produced from (#528).
 *
 * `bastra update` refuses a source checkout whose build is not current. That
 * check used to be mtime-only, and an mtime proves nothing about WHICH sources
 * produced the output: `dist` copied in from another revision, a checkout moved
 * to a different revision afterwards, or a plain `touch dist/**` all read as
 * "current" and the command then named HEAD as the revision that went live.
 *
 * So the build says it itself. Every package build ends here and writes
 * `dist/.build-revision`; the check compares that against HEAD instead of
 * guessing from timestamps, and an old build without the file is refused
 * rather than silently accepted.
 *
 * Not a failure when there is no git: a package built from a published tarball
 * has no revision to record, and a build must not die over a stamp. The
 * verifier is the place that decides what a missing stamp means.
 *
 * No `built_at` timestamp (#554): this file ships inside the published
 * tarball, and `scripts/publish-release-set.mjs` compares that tarball's
 * digest against the registry's to decide whether a resumed publish can skip
 * a package already there. A wall-clock timestamp made two builds of the
 * identical tree pack to two different digests, seconds apart — so a genuine
 * resume (rerun after a partial publish) could never match and always hit the
 * hard "NOT this release" failure the check exists to avoid. `revision` and
 * `dirty` already say everything the file exists to prove; nothing reads
 * `built_at` (checked across the repo, including `/health` and `build-stamp.ts`),
 * so dropping it changes no reported behaviour — it only makes the tarball
 * reproducible, which is what the digest comparison assumes.
 *
 * Usage: node scripts/write-build-revision.mjs <distDir>   (cwd = package root)
 */
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root: this script lives in <root>/scripts/. */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function git(...args) {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15_000,
    });
  } catch {
    return null;
  }
}

const distDir = resolve(process.cwd(), process.argv[2] ?? "dist");
if (!existsSync(distDir)) {
  // Nothing was emitted — the build itself will have said so.
  process.exit(0);
}

const revision = git("rev-parse", "HEAD")?.trim();
if (!revision) process.exit(0);

// Untracked files count: an untracked `.ts` under a package's `src` is compiled
// like any other, so "the tree differs from HEAD" is the honest question here.
// Recorded AFTER the build, so it describes the tree the output came from.
const dirty = (git("status", "--porcelain") ?? "").trim() !== "";

writeFileSync(
  resolve(distDir, ".build-revision"),
  `revision=${revision}\ndirty=${dirty}\n`,
  "utf8",
);
