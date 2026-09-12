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
 * The counter-review then showed that the first version of that verification
 * checked TIMESTAMPS, which prove nothing about which sources produced a build.
 * The three bypass forms it named each have a regression test below: output
 * copied from another revision, a checkout moved to another revision, and a
 * plain `touch`. All three are refused because the build now stamps itself with
 * its revision (dist/.build-revision) and the check compares that with HEAD.
 *
 * Run: npx tsx --test packages/daemon/__tests__/update-source-build.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { cmdUpdate, detectInstallMode, verifySourceCheckout } from "../src/cli/update.js";
import { parseArgs } from "../src/cli/commands.js";
import {
  decideSourceBuild,
  inspectSourceBuild,
  provenRevision,
  type HeadState,
} from "../src/cli/source-build.js";
import { parseBuildStamp, readBuildStamp } from "../src/build-stamp.js";
import { buildHealthPayload } from "../src/http-health.js";
import { decideLiveRevision, describeLiveRevision, liveRevisionOfDaemon } from "../src/cli/live-revision.js";

const REBUILD = "git pull && npm ci && npm run build";
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

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
  await writeFile(
    join(root, "packages", "daemon", "package.json"),
    JSON.stringify({ name: "d", scripts: { build: "tsc" } }),
    "utf8",
  );
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

// ─── a real git checkout, for the revision-level bypasses ────────────────────

/** git, isolated from the developer's own config and identity. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    },
  }).trim();
}

/** A real one-package repo at one commit. */
async function realCheckout(dir: string, name: string): Promise<string> {
  const root = join(dir, name);
  await mkdir(join(root, "packages", "daemon", "src"), { recursive: true });
  // The writer script is invoked exactly as a package build invokes it.
  await mkdir(join(root, "scripts"), { recursive: true });
  await cp(join(REPO_ROOT, "scripts", "write-build-revision.mjs"), join(root, "scripts", "write-build-revision.mjs"));
  await writeFile(
    join(root, "packages", "daemon", "package.json"),
    JSON.stringify({ name: "d", scripts: { build: "tsc" } }),
    "utf8",
  );
  await writeFile(join(root, "packages", "daemon", "src", "a.ts"), "export const v = 1;\n", "utf8");
  // Build output is ignored here exactly as it is in the repo — otherwise every
  // build would leave the tree "dirty" and nothing could ever be proved.
  await writeFile(join(root, ".gitignore"), "dist/\n", "utf8");
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "one");
  return root;
}

/**
 * Builds the package — output plus the stamp, written by the REAL build script
 * from the package directory, exactly as `npm run build` does.
 */
async function build(root: string, body = "export const v = 1;\n"): Promise<void> {
  const dist = join(root, "packages", "daemon", "dist");
  await mkdir(dist, { recursive: true });
  await writeFile(join(dist, "a.js"), body, "utf8");
  execFileSync(process.execPath, [join(root, "scripts", "write-build-revision.mjs"), "dist"], {
    cwd: join(root, "packages", "daemon"),
    encoding: "utf8",
  });
}

/** A second commit that changes nothing under `packages/*​/src`. */
function commitElsewhere(root: string, text: string): void {
  execFileSync("/bin/sh", ["-c", `printf '%s\\n' '${text}' > README.md`], { cwd: root });
  git(root, "add", "-A");
  git(root, "commit", "-qm", text);
}

/** Sets every dist file's mtime to now — the `touch dist/**` bypass. */
async function touchDist(root: string): Promise<void> {
  const now = new Date();
  await utimes(join(root, "packages", "daemon", "dist", "a.js"), now, now);
}

const HEAD: HeadState = { revision: "a".repeat(40), dirty: false };
const STAMP = { revision: "a".repeat(40), dirty: false, builtAt: null };

// ─── the verdict, as a pure decision ─────────────────────────────────────────

test("#528 — a checkout with no build output at all is refused as unbuilt", () => {
  const s = decideSourceBuild({ newestSourceMs: 1000, newestBuildMs: null, head: HEAD, built: null });
  assert.equal(s.ok, false);
  assert.equal(s.reason, "unbuilt");
});

test("#528 — a build older than its sources is refused as stale", () => {
  const s = decideSourceBuild({ newestSourceMs: 2000, newestBuildMs: 1000, head: HEAD, built: STAMP });
  assert.equal(s.ok, false);
  assert.equal(s.reason, "stale");
});

test("#528 — a build stamped with HEAD, in a clean tree, passes", () => {
  const s = decideSourceBuild({ newestSourceMs: 1000, newestBuildMs: 1000, head: HEAD, built: STAMP });
  assert.equal(s.ok, true);
  assert.equal(s.reason, "current");
  assert.equal(provenRevision(s), HEAD.revision);
});

test("#528 — a build stamped with another revision is refused as a mismatch", () => {
  const s = decideSourceBuild({
    newestSourceMs: 1000,
    newestBuildMs: 2000,
    head: HEAD,
    built: { revision: "b".repeat(40), dirty: false, builtAt: null },
  });
  assert.equal(s.ok, false);
  assert.equal(s.reason, "mismatch");
  assert.equal(provenRevision(s), null);
});

test("#528 — a build with no stamp is refused, not silently accepted", () => {
  const s = decideSourceBuild({ newestSourceMs: 1000, newestBuildMs: 2000, head: HEAD, built: null });
  assert.equal(s.ok, false);
  assert.equal(s.reason, "unstamped");
});

test("#528 — without git there is no HEAD to compare against, so nothing is proved", () => {
  const s = decideSourceBuild({ newestSourceMs: 1000, newestBuildMs: 2000, head: null, built: STAMP });
  assert.equal(s.ok, false);
  assert.equal(s.reason, "unverifiable");
});

test("#528 — a dirty tree proceeds but proves no revision", () => {
  const built = decideSourceBuild({
    newestSourceMs: 1000,
    newestBuildMs: 2000,
    head: { revision: HEAD.revision, dirty: true },
    built: { revision: HEAD.revision, dirty: true, builtAt: null },
  });
  assert.equal(built.ok, true, "a build of the sources on disk is still the build that would go live");
  assert.equal(built.reason, "dirty");
  assert.equal(provenRevision(built), null, "HEAD plus uncommitted work is not HEAD");
});

test("#528 — a tree without workspace sources is not vetoed", () => {
  const s = decideSourceBuild({ newestSourceMs: null, newestBuildMs: null, head: null, built: null });
  assert.equal(s.ok, true);
  assert.equal(s.reason, "unknown");
});

// ─── the stamp itself ────────────────────────────────────────────────────────

test("#528 — the build stamp is parsed, and a stamp without a revision counts as none", () => {
  const s = parseBuildStamp("revision=abc\ndirty=true\nbuilt_at=2026-09-12T00:00:00.000Z\n");
  assert.deepEqual(s, { revision: "abc", dirty: true, builtAt: "2026-09-12T00:00:00.000Z" });
  assert.equal(parseBuildStamp("dirty=false\n"), null);
  assert.equal(parseBuildStamp(""), null);
});

test("#528 — the build writes the stamp; it is not guessed by the check", async () => {
  await withTempDir(async (dir) => {
    const root = await realCheckout(dir, "repo");
    await build(root);
    const stamp = readBuildStamp(join(root, "packages", "daemon", "dist"));
    assert.equal(stamp?.revision, git(root, "rev-parse", "HEAD"));
    assert.equal(stamp?.dirty, false);
  });
});

// ─── the same, read off a real directory ─────────────────────────────────────

test("#528 — inspectSourceBuild reads a freshly built checkout as current", async () => {
  await withTempDir(async (dir) => {
    const root = await realCheckout(dir, "repo");
    await build(root);
    const s = inspectSourceBuild(root);
    assert.equal(s.reason, "current");
    assert.equal(s.ok, true);
    assert.equal(s.builtRevision, git(root, "rev-parse", "HEAD"));
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

test("#528 — a package that declares no build (eval runs from tsx) is not demanded to have a dist", async () => {
  await withTempDir(async (dir) => {
    const root = await realCheckout(dir, "repo");
    await build(root);
    await mkdir(join(root, "packages", "eval", "src"), { recursive: true });
    await writeFile(join(root, "packages", "eval", "package.json"), JSON.stringify({ name: "e", scripts: { lift: "tsx" } }), "utf8");
    await writeFile(join(root, "packages", "eval", "src", "x.ts"), "export {};\n", "utf8");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "eval");
    await build(root);
    assert.equal(inspectSourceBuild(root).reason, "current");
  });
});

// ─── the three bypass forms from the counter-review ──────────────────────────

test("#528 — build output copied in from another revision is refused", async () => {
  await withTempDir(async (dir) => {
    const source = await realCheckout(dir, "source");
    await build(source);
    const other = await realCheckout(dir, "other");
    commitElsewhere(other, "second");
    // The copy is newer than every source file here — the mtime check is happy.
    await cp(join(source, "packages", "daemon", "dist"), join(other, "packages", "daemon", "dist"), {
      recursive: true,
    });
    await touchDist(other);

    const s = inspectSourceBuild(other);
    assert.equal(s.ok, false, "a build from a foreign revision must not be re-registered");
    assert.equal(s.reason, "mismatch");
    assert.equal(s.builtRevision, git(source, "rev-parse", "HEAD"));
    assert.equal(s.headRevision, git(other, "rev-parse", "HEAD"));
  });
});

test("#528 — a checkout moved to another revision after the build is refused", async () => {
  await withTempDir(async (dir) => {
    const root = await realCheckout(dir, "repo");
    const first = git(root, "rev-parse", "HEAD");
    // The two revisions differ OUTSIDE packages/*/src, so checking one out
    // moves no source mtime at all and the timestamps stay "current".
    commitElsewhere(root, "second");
    await build(root);
    git(root, "checkout", "-q", first);

    const s = inspectSourceBuild(root);
    assert.equal(s.ok, false, "the build belongs to the other revision, not to HEAD");
    assert.equal(s.reason, "mismatch");
    assert.equal(s.headRevision, first);
    assert.notEqual(s.builtRevision, first);
  });
});

test("#528 — a touched stale build is refused", async () => {
  await withTempDir(async (dir) => {
    const root = await realCheckout(dir, "repo");
    await build(root);
    // New sources, committed: the build is genuinely out of date …
    await writeFile(join(root, "packages", "daemon", "src", "a.ts"), "export const v = 2;\n", "utf8");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "second");
    assert.equal(inspectSourceBuild(root).reason, "stale");
    // … and one `touch` used to make it read as current.
    await touchDist(root);

    const s = inspectSourceBuild(root);
    assert.equal(s.ok, false, "a timestamp is not evidence of which sources were built");
    assert.equal(s.reason, "mismatch");
  });
});

test("#528 — a build from before the stamp existed is refused rather than trusted", async () => {
  await withTempDir(async (dir) => {
    const root = await realCheckout(dir, "repo");
    await build(root);
    await rm(join(root, "packages", "daemon", "dist", ".build-revision"));

    const s = inspectSourceBuild(root);
    assert.equal(s.ok, false);
    assert.equal(s.reason, "unstamped");
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

test("#528 — a checkout built from another revision stops the update", async () => {
  await withTempDir(async (dir) => {
    const root = await realCheckout(dir, "repo");
    const first = git(root, "rev-parse", "HEAD");
    commitElsewhere(root, "second");
    await build(root);
    git(root, "checkout", "-q", first);

    const cap = capture();
    const verdict = verifySourceCheckout(join(root, "packages", "daemon", "dist", "a.js"), REBUILD, cap.write);
    assert.equal(verdict.rc, 1);
    assert.match(cap.text(), /was produced from .*, not from HEAD/);
    assert.match(cap.text(), /Nothing was re-registered/);
  });
});

test("#528 — a current source checkout lets the update proceed", async () => {
  await withTempDir(async (dir) => {
    const root = await realCheckout(dir, "repo");
    await build(root);
    const cap = capture();
    const verdict = verifySourceCheckout(join(root, "packages", "daemon", "dist", "a.js"), REBUILD, cap.write);
    assert.equal(verdict.rc, 0);
    assert.match(cap.text(), /was produced from HEAD/);
    // …and it must never claim to have pulled, installed or built anything.
    assert.match(cap.text(), /nothing is pulled, installed or built here/);
  });
});

test("#528 — a dirty checkout proceeds and says the revision is not claimed", async () => {
  await withTempDir(async (dir) => {
    const root = await realCheckout(dir, "repo");
    await writeFile(join(root, "packages", "daemon", "src", "a.ts"), "export const v = 9;\n", "utf8");
    await build(root);
    const cap = capture();
    const verdict = verifySourceCheckout(join(root, "packages", "daemon", "dist", "a.js"), REBUILD, cap.write);
    assert.equal(verdict.rc, 0);
    assert.equal(verdict.state.reason, "dirty");
    assert.equal(provenRevision(verdict.state), null);
    assert.match(cap.text(), /plus uncommitted changes/);
    assert.match(cap.text(), /will not claim a verified revision/);
  });
});

// ─── what is LIVE, as opposed to what is on disk ─────────────────────────────

test("#528 — /health names the revision the running daemon was built from", () => {
  const base = {
    vaultSize: () => 691,
    version: "0.9.2",
    embedding: { on: false, providerId: null, source: "default" as const },
    updateState: () => null,
  };
  // A version number is shared by every build of a release; the revision is not.
  assert.equal(buildHealthPayload({ ...base, buildRevision: "a".repeat(40) }).build_revision, "a".repeat(40));
  // Explicitly null rather than absent: "I do not know" must be readable as an
  // answer, not indistinguishable from a daemon that predates the field.
  assert.equal(buildHealthPayload(base).build_revision, null);
});

test("#528 — the live revision comes from the daemon, not from the disk that was verified", () => {
  const head = "a".repeat(40);
  assert.equal(decideLiveRevision({ provenHead: head, daemonReachable: true, daemonRevision: head }), "live");
  assert.equal(
    decideLiveRevision({ provenHead: head, daemonReachable: true, daemonRevision: "b".repeat(40) }),
    "other-build",
  );
  assert.equal(decideLiveRevision({ provenHead: head, daemonReachable: true, daemonRevision: null }), "unknown-build");
  assert.equal(decideLiveRevision({ provenHead: head, daemonReachable: false, daemonRevision: null }), "no-daemon");
  assert.equal(decideLiveRevision({ provenHead: null, daemonReachable: true, daemonRevision: head }), "unprovable");
});

test("#528 — a daemon on another build is never reported as a live HEAD", async () => {
  const head = "a".repeat(40);
  const state = decideSourceBuild({
    newestSourceMs: 1,
    newestBuildMs: 2,
    head: { revision: head, dirty: false },
    built: { revision: head, dirty: false, builtAt: null },
  });
  // The no-LaunchAgent branch: nothing restarted the daemon, so it still
  // answers from the build it was started with.
  const { verdict, daemonRevision } = await liveRevisionOfDaemon(head, {
    attempts: 2,
    sleep: async () => {},
    probe: async () => ({ ok: true, detail: "", buildRevision: "b".repeat(40) }),
  });
  assert.equal(verdict, "other-build");
  const said = describeLiveRevision(verdict, { state, daemonRevision });
  assert.match(said.report, /still answers from bbbbbbb/);
  assert.match(said.closing, /registered, NOT live/);
  assert.doesNotMatch(said.closing, /is live in the running daemon/);
});

test("#528 — an unreachable daemon is reported as 'goes live on the next start', not as live", async () => {
  const head = "a".repeat(40);
  const state = decideSourceBuild({
    newestSourceMs: 1,
    newestBuildMs: 2,
    head: { revision: head, dirty: false },
    built: { revision: head, dirty: false, builtAt: null },
  });
  const { verdict, daemonRevision } = await liveRevisionOfDaemon(head, {
    attempts: 2,
    sleep: async () => {},
    probe: async () => ({ ok: false, detail: "not reachable" }),
  });
  assert.equal(verdict, "no-daemon");
  const said = describeLiveRevision(verdict, { state, daemonRevision });
  assert.doesNotMatch(said.closing, /is live/);
  assert.match(said.closing, /goes live on the next daemon start/);
});

test("#528 — a daemon answering from HEAD is the proof the closing line may state", async () => {
  const head = "a".repeat(40);
  const state = decideSourceBuild({
    newestSourceMs: 1,
    newestBuildMs: 2,
    head: { revision: head, dirty: false },
    built: { revision: head, dirty: false, builtAt: null },
  });
  let calls = 0;
  const { verdict, daemonRevision } = await liveRevisionOfDaemon(head, {
    attempts: 3,
    sleep: async () => {},
    // A just-kickstarted daemon is not up on the first probe.
    probe: async () => (++calls < 2 ? { ok: false, detail: "starting" } : { ok: true, detail: "", buildRevision: head }),
  });
  assert.equal(verdict, "live");
  assert.match(describeLiveRevision(verdict, { state, daemonRevision }).closing, /HEAD aaaaaaa is live/);
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
