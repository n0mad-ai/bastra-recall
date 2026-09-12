/**
 * #528 — `bastra update --dry-run` printed "would: 1) run the update command
 * above" for a source checkout, where the command was
 * `git pull && npm ci && npm run build`. The real source branch ran none of it:
 * it printed advice and then re-registered every surface and restarted the
 * daemon from whatever `dist` was lying there. Dry-run and execution described
 * different operations, and "done" could mean "the pulled revision is still
 * unbuilt and nothing about it is live".
 *
 * The contract now is the second one the issue offers: update refreshes an
 * ALREADY BUILT checkout, verifies that before touching anything, and refuses
 * otherwise (see src/cli/source-build.ts for why that beats owning the build).
 *
 * Run: npx tsx --test packages/daemon/__tests__/update-source-build.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cmdUpdate, detectInstallMode, verifySourceCheckout } from "../src/cli/update.js";
import { parseArgs } from "../src/cli/commands.js";
import { decideSourceBuild, inspectSourceBuild } from "../src/cli/source-build.js";

const REBUILD = "git pull && npm ci && npm run build";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-528-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

/** Captures what a writer-taking function printed. */
function capture(): { write: (s: string) => void; text: () => string } {
  let buf = "";
  return { write: (s) => { buf += s; }, text: () => buf };
}

/**
 * A checkout with one workspace package. `distAgeMs` > 0 backdates the build
 * output, which is what "pulled but never rebuilt" looks like on disk.
 * `dist: false` leaves the build out entirely.
 */
async function fakeCheckout(
  dir: string,
  opts: { dist: boolean; distAgeMs?: number },
): Promise<{ root: string; cliFile: string }> {
  const root = join(dir, "checkout");
  // A plain file named `.git` is what a worktree carries — gitRootFor accepts both.
  await mkdir(join(root, "packages", "daemon", "src", "cli"), { recursive: true });
  await writeFile(join(root, ".git"), "gitdir: /nowhere\n", "utf8");
  await writeFile(join(root, "packages", "daemon", "src", "cli", "update.ts"), "export {};\n", "utf8");
  const cliFile = join(root, "packages", "daemon", "dist", "cli", "update.js");
  if (opts.dist) {
    await mkdir(join(root, "packages", "daemon", "dist", "cli"), { recursive: true });
    await writeFile(cliFile, "export {};\n", "utf8");
    if (opts.distAgeMs) {
      const when = new Date(Date.now() - opts.distAgeMs);
      await utimes(cliFile, when, when);
    }
  }
  return { root, cliFile };
}

// ─── the verdict, as a pure decision ─────────────────────────────────────────

test("#528 — a checkout with no build output at all is refused as unbuilt", () => {
  const s = decideSourceBuild({ newestSourceMs: 1000, newestBuildMs: null, revision: "abc1234" });
  assert.equal(s.ok, false);
  assert.equal(s.reason, "unbuilt");
});

test("#528 — a build older than its sources is refused as stale", () => {
  const s = decideSourceBuild({ newestSourceMs: 2000, newestBuildMs: 1000, revision: "abc1234" });
  assert.equal(s.ok, false);
  assert.equal(s.reason, "stale");
});

test("#528 — a build at least as new as its sources passes", () => {
  const s = decideSourceBuild({ newestSourceMs: 1000, newestBuildMs: 1000, revision: "abc1234" });
  assert.equal(s.ok, true);
  assert.equal(s.reason, "current");
});

test("#528 — a tree without workspace sources is not vetoed", () => {
  const s = decideSourceBuild({ newestSourceMs: null, newestBuildMs: null, revision: null });
  assert.equal(s.ok, true);
  assert.equal(s.reason, "unknown");
});

// ─── the same, read off a real directory ─────────────────────────────────────

test("#528 — inspectSourceBuild reads a freshly built checkout as current", async () => {
  await withTempDir(async (dir) => {
    const { root } = await fakeCheckout(dir, { dist: true });
    // git is not asked for a fake checkout; the revision may be null.
    const s = inspectSourceBuild(root, null);
    assert.equal(s.reason, "current");
    assert.equal(s.ok, true);
  });
});

test("#528 — inspectSourceBuild reads a pulled-but-unbuilt checkout as stale", async () => {
  await withTempDir(async (dir) => {
    const { root } = await fakeCheckout(dir, { dist: true, distAgeMs: 60 * 60 * 1000 });
    const s = inspectSourceBuild(root, null);
    assert.equal(s.reason, "stale");
    assert.equal(s.ok, false);
  });
});

test("#528 — inspectSourceBuild reads a never-built checkout as unbuilt", async () => {
  await withTempDir(async (dir) => {
    const { root } = await fakeCheckout(dir, { dist: false });
    const s = inspectSourceBuild(root, null);
    assert.equal(s.reason, "unbuilt");
    assert.equal(s.ok, false);
  });
});

// ─── the step the update actually takes ──────────────────────────────────────

test("#528 — a stale source checkout stops the update before re-registration", async () => {
  await withTempDir(async (dir) => {
    const { cliFile } = await fakeCheckout(dir, { dist: true, distAgeMs: 60 * 60 * 1000 });
    const cap = capture();
    const verdict = verifySourceCheckout(cliFile, REBUILD, cap.write);
    // rc !== 0 is what cmdUpdate returns on, so nothing below it runs: no
    // surface is re-registered and the daemon is not restarted.
    assert.equal(verdict.rc, 1);
    assert.match(cap.text(), /older than its sources/);
    assert.match(cap.text(), /Nothing was re-registered/);
    assert.match(cap.text(), new RegExp(REBUILD.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});

test("#528 — a never-built source checkout stops the update too", async () => {
  await withTempDir(async (dir) => {
    const { cliFile } = await fakeCheckout(dir, { dist: false });
    const cap = capture();
    // No dist/ means the cli file does not exist either — the checkout root is
    // still found from the path, which is what the real CLI would hand in.
    const verdict = verifySourceCheckout(cliFile, REBUILD, cap.write);
    assert.equal(verdict.rc, 1);
    assert.match(cap.text(), /no build output/);
  });
});

test("#528 — a current source checkout lets the update proceed", async () => {
  await withTempDir(async (dir) => {
    const { cliFile } = await fakeCheckout(dir, { dist: true });
    const cap = capture();
    const verdict = verifySourceCheckout(cliFile, REBUILD, cap.write);
    assert.equal(verdict.rc, 0);
    assert.match(cap.text(), /build in this checkout is current/);
    // …and it must never claim to have pulled, installed or built anything.
    assert.match(cap.text(), /nothing is pulled, installed or built here/);
  });
});

// ─── dry-run parity ──────────────────────────────────────────────────────────

test("#528 — the source dry-run describes the verification, not a build it never runs", async (t) => {
  if (detectInstallMode().mode !== "source") {
    t.skip("not running from a source checkout");
    return;
  }
  const realWrite = process.stdout.write.bind(process.stdout);
  let out = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    const rc = await cmdUpdate(parseArgs(["update", "--dry-run"]));
    assert.equal(rc, 0);
  } finally {
    process.stdout.write = realWrite;
  }
  assert.doesNotMatch(out, /would: 1\) run the update command above/);
  assert.match(out, /would: 1\) verify this checkout's build is current/);
  assert.match(out, /no pull, no install, no build/);
  // The rebuild command may still be shown — but never as something this
  // command performs.
  assert.doesNotMatch(out, /^ {2}update command: git pull/m);
});
