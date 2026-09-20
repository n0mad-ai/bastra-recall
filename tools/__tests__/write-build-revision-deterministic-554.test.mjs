/**
 * #554 — `dist/.build-revision` must pack byte-identical across two builds of
 * the same commit, or a resumed publish can never match.
 *
 * `scripts/publish-release-set.mjs` skips an already-published package only
 * after comparing a fresh `npm pack --dry-run` digest of this checkout
 * against the registry's tarball (`packDigest` / `mismatchReason`, #524).
 * `.build-revision` ships inside that tarball. Before this fix it carried a
 * `built_at=<ISO>` timestamp, so two builds of the identical tree — the
 * original publish and a rerun seconds or days later — produced two
 * different digests and the resume that #524 exists for could never work
 * (v1.0.0 hit exactly this and had to be finished by hand).
 *
 * `scripts/write-build-revision.mjs` derives its repo root from its OWN file
 * location (`dirname(fileURLToPath(import.meta.url))/..`), not from `cwd` or
 * an argument — so this test copies the script into a throwaway git repo
 * shaped like `<repo>/scripts/write-build-revision.mjs` rather than pointing
 * it at a fixture directory.
 *
 * Runner: node --test tools/__tests__/write-build-revision-deterministic-554.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, copyFile, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_SRC = fileURLToPath(new URL("../../scripts/write-build-revision.mjs", import.meta.url));

/** A throwaway git repo shaped like `<repo>/scripts/write-build-revision.mjs`. */
async function fixtureRepo(t) {
  const dir = await mkdtemp(join(tmpdir(), "build-revision-554-"));
  await mkdir(join(dir, "scripts"), { recursive: true });
  await copyFile(SCRIPT_SRC, join(dir, "scripts", "write-build-revision.mjs"));
  await writeFile(join(dir, "package.json"), '{"name":"fixture"}\n', "utf8");
  // `dist/` is gitignored in the real repo (.gitignore:10) — mirrored here, or
  // the stamp the FIRST run writes into `dist/` would itself show up as an
  // untracked file on the second run and flip `dirty` between the two calls,
  // which is a fixture artefact, not the thing this test is about.
  await writeFile(join(dir, ".gitignore"), "dist/\n", "utf8");
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "test@local");
  git("config", "user.name", "test");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10 }));
  return dir;
}

/** Runs the copied script against `dir`'s own dist output. */
function writeRevision(dir) {
  execFileSync("node", [join(dir, "scripts", "write-build-revision.mjs"), "dist"], {
    cwd: dir,
    stdio: "pipe",
  });
  return readFile(join(dir, "dist", ".build-revision"));
}

test("#554 two builds of the same commit produce byte-identical .build-revision files", async (t) => {
  const dir = await fixtureRepo(t);
  await mkdir(join(dir, "dist"), { recursive: true });

  const first = await writeRevision(dir);
  // A real rerun is seconds or days later; a millisecond apart is enough to
  // have failed before this fix, since `built_at` was wall-clock either way.
  await new Promise((r) => setTimeout(r, 10));
  const second = await writeRevision(dir);

  assert.ok(first.equals(second), "two builds at the same commit produced different bytes");
});

test("#554 the stamp no longer carries a built_at timestamp", async (t) => {
  const dir = await fixtureRepo(t);
  await mkdir(join(dir, "dist"), { recursive: true });

  const text = (await writeRevision(dir)).toString("utf8");
  assert.ok(!text.includes("built_at"), `stamp still carries a timestamp:\n${text}`);
  assert.match(text, /^revision=[0-9a-f]{40}\ndirty=false\n$/);
});
