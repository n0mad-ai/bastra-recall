/**
 * Tests for the local patch registry (#269).
 *
 * Every case runs against a REAL file tree and a REAL `git apply` — the whole
 * feature is a claim about what git does to a directory, and a mocked git would
 * only test the mock. The tree is a throwaway under os.tmpdir(); nothing here
 * touches a real installation or a real ~/.bastra.
 *
 * Run with:
 *   npx tsx --test packages/daemon/__tests__/patch-registry.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  addPatch,
  activePatches,
  applySeries,
  formatApplyOutcome,
  patchSubject,
  pendingPatchNotice,
  probePatch,
  readIndex,
  readLastRun,
  removePatch,
  smokeCheck,
  statusAll,
  writeLastRun,
} from "../src/patch-registry.js";

/** A scratch HOME + a scratch install root, torn down by the caller. */
function scratch(): { home: string; root: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), "bastra-patch-test-"));
  const home = join(base, "home");
  const root = join(base, "install");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  return { home, root, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

/** A unified diff that turns `before` into `after` for `relPath`. Written by
 *  hand rather than shelled out to `git diff`, so the test does not depend on a
 *  repo existing anywhere. */
function diffFor(relPath: string, before: string[], after: string[]): string {
  return (
    `diff --git a/${relPath} b/${relPath}\n` +
    `--- a/${relPath}\n` +
    `+++ b/${relPath}\n` +
    `@@ -1,${before.length} +1,${after.length} @@\n` +
    before.map((l) => `-${l}`).join("\n") +
    "\n" +
    after.map((l) => `+${l}`).join("\n") +
    "\n"
  );
}

function writePatchFile(dir: string, name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, body, "utf8");
  return p;
}

test("patchSubject reads a git-format Subject and strips the [PATCH] decoration", () => {
  assert.equal(patchSubject("Subject: [PATCH 1/3] fix the tokenizer\n", "fb"), "fix the tokenizer");
  assert.equal(patchSubject("Subject: plain subject\n", "fb"), "plain subject");
  assert.equal(patchSubject("no subject here\n", "fallback.patch"), "fallback.patch");
});

test("addPatch registers, orders in steps of ten, and rejects a non-patch", () => {
  const s = scratch();
  try {
    const p1 = writePatchFile(s.root, "a.patch", diffFor("src/a.txt", ["old"], ["new"]));
    const p2 = writePatchFile(s.root, "b.patch", "Subject: second one\n" + diffFor("src/b.txt", ["x"], ["y"]));

    const r1 = addPatch(p1, s.home);
    const r2 = addPatch(p2, s.home);

    assert.ok(r1.entry.id.startsWith("010-"), `expected 010- prefix, got ${r1.entry.id}`);
    assert.ok(r2.entry.id.startsWith("020-"), `expected 020- prefix, got ${r2.entry.id}`);
    assert.equal(r2.entry.subject, "second one");
    assert.equal(activePatches(s.home).length, 2);
    assert.ok(existsSync(r1.path));

    const notAPatch = writePatchFile(s.root, "c.txt", "just some prose, no diff header\n");
    assert.throws(() => addPatch(notAPatch, s.home), /does not look like a patch/);
    assert.equal(activePatches(s.home).length, 2, "a rejected file must not land in the series");
  } finally {
    s.cleanup();
  }
});

test("removePatch drops the entry and the file, and reports an unknown id", () => {
  const s = scratch();
  try {
    const p = writePatchFile(s.root, "a.patch", diffFor("src/a.txt", ["old"], ["new"]));
    const { entry, path } = addPatch(p, s.home);
    assert.equal(removePatch(entry.id, s.home), true);
    assert.equal(activePatches(s.home).length, 0);
    assert.equal(existsSync(path), false);
    assert.equal(removePatch("999-nope", s.home), false);
  } finally {
    s.cleanup();
  }
});

test("probePatch separates clean, already-upstream and conflict", () => {
  const s = scratch();
  try {
    writeFileSync(join(s.root, "src", "a.txt"), "old\n", "utf8");
    const clean = writePatchFile(s.root, "clean.patch", diffFor("src/a.txt", ["old"], ["new"]));
    assert.equal(probePatch(s.root, clean).state, "clean");

    // Apply it, then the SAME patch must read as already present — this is the
    // ordering guarantee: a merged patch is never offered for a second apply.
    const applied = applySeries(s.root, { home: s.home, skipSmoke: true });
    void applied;
    writeFileSync(join(s.root, "src", "a.txt"), "new\n", "utf8");
    assert.equal(probePatch(s.root, clean).state, "already-upstream");

    // A patch whose context no longer exists anywhere.
    const conflicting = writePatchFile(
      s.root,
      "conflict.patch",
      diffFor("src/a.txt", ["something else entirely"], ["replacement"]),
    );
    const probe = probePatch(s.root, conflicting);
    assert.equal(probe.state, "conflict");
    assert.ok(probe.detail && probe.detail.length > 0, "a conflict must carry git's own reason");
  } finally {
    s.cleanup();
  }
});

test("a patch git skips is a conflict, never a silent retire", () => {
  // Regression guard for the trap found in the first end-to-end run: `git apply
  // --check` exits 0 on a patch it SKIPPED. Read as success, the reverse probe
  // says "already upstream" and applySeries auto-retires a patch the user still
  // needs — a silent loss, which is the one thing this feature must not do.
  const s = scratch();
  try {
    writeFileSync(join(s.root, "src", "a.txt"), "old\n", "utf8");
    // A hunk header that claims one line while the body carries a different
    // shape — enough for git to give up on the file rather than fail loudly.
    const malformed =
      `diff --git a/src/a.txt b/src/a.txt\n` +
      `--- a/src/a.txt\n` +
      `+++ b/src/a.txt\n` +
      `@@ -2,1 +2,1 @@\n` +
      `-old\n` +
      `+new\n`;
    const file = writePatchFile(s.root, "malformed.patch", malformed);
    const probe = probePatch(s.root, file);
    assert.notEqual(probe.state, "already-upstream", "a skipped patch must never read as merged upstream");

    addPatch(file, s.home);
    const out = applySeries(s.root, { home: s.home, skipSmoke: true });
    assert.equal(out.retired.length, 0, "nothing may be retired on the strength of a skip");
    assert.equal(activePatches(s.home).length, 1, "the patch stays in the series");
  } finally {
    s.cleanup();
  }
});

test("applySeries applies in order, retires what upstream absorbed, sets aside the rest", () => {
  const s = scratch();
  try {
    writeFileSync(join(s.root, "src", "keep.txt"), "old\n", "utf8");
    writeFileSync(join(s.root, "src", "merged.txt"), "already-new\n", "utf8");
    writeFileSync(join(s.root, "src", "moved.txt"), "upstream rewrote this\n", "utf8");

    addPatch(writePatchFile(s.root, "p1.patch", diffFor("src/keep.txt", ["old"], ["patched"])), s.home);
    addPatch(
      writePatchFile(s.root, "p2.patch", diffFor("src/merged.txt", ["already-old"], ["already-new"])),
      s.home,
    );
    addPatch(
      writePatchFile(s.root, "p3.patch", diffFor("src/moved.txt", ["what it used to say"], ["local fix"])),
      s.home,
    );

    const out = applySeries(s.root, { home: s.home, skipSmoke: true });

    assert.equal(out.applied.length, 1, "the clean patch applies");
    assert.equal(out.retired.length, 1, "the merged one retires");
    assert.equal(out.setAside.length, 1, "the conflicting one is set aside");
    assert.equal(readFileSync(join(s.root, "src", "keep.txt"), "utf8"), "patched\n");
    assert.equal(
      readFileSync(join(s.root, "src", "moved.txt"), "utf8"),
      "upstream rewrote this\n",
      "a set-aside patch must never touch the file",
    );

    // The retired one leaves the active series but stays in the index as history.
    const idx = readIndex(s.home);
    assert.equal(idx.patches.length, 3);
    assert.equal(activePatches(s.home).length, 2);
    assert.equal(idx.patches.filter((p) => p.retired_reason === "merged-upstream").length, 1);
  } finally {
    s.cleanup();
  }
});

test("applySeries reverses everything it applied when the install stops booting", () => {
  const s = scratch();
  try {
    // A dist/cli.js that exits non-zero once the patch has been applied: the
    // patch is textually fine and semantically fatal, which is exactly the case
    // the boot check exists for.
    mkdirSync(join(s.root, "dist"), { recursive: true });
    writeFileSync(join(s.root, "dist", "cli.js"), "process.exit(0);\n", "utf8");
    writeFileSync(join(s.root, "src", "a.txt"), "old\n", "utf8");

    addPatch(writePatchFile(s.root, "ok.patch", diffFor("src/a.txt", ["old"], ["new"])), s.home);
    addPatch(
      writePatchFile(s.root, "boom.patch", diffFor("dist/cli.js", ["process.exit(0);"], ["process.exit(3);"])),
      s.home,
    );

    const out = applySeries(s.root, { home: s.home });

    assert.equal(out.ok, false);
    assert.equal(out.rolledBack, true);
    assert.equal(out.applied.length, 0, "a rolled-back run reports nothing as applied");
    assert.ok(out.smokeError && out.smokeError.length > 0);
    assert.equal(
      readFileSync(join(s.root, "src", "a.txt"), "utf8"),
      "old\n",
      "the unrelated patch is reversed too — the run is the unit, not the patch",
    );
    assert.equal(readFileSync(join(s.root, "dist", "cli.js"), "utf8"), "process.exit(0);\n");
  } finally {
    s.cleanup();
  }
});

test("applySeries changes nothing on a dry run", () => {
  const s = scratch();
  try {
    writeFileSync(join(s.root, "src", "a.txt"), "old\n", "utf8");
    addPatch(writePatchFile(s.root, "p.patch", diffFor("src/a.txt", ["old"], ["new"])), s.home);

    const out = applySeries(s.root, { home: s.home, dryRun: true });
    assert.equal(out.applied.length, 1, "a dry run still reports what would happen");
    assert.equal(readFileSync(join(s.root, "src", "a.txt"), "utf8"), "old\n", "but touches nothing");
    assert.equal(activePatches(s.home).length, 1, "and retires nothing");
  } finally {
    s.cleanup();
  }
});

test("an empty registry is a skip, not a failure", () => {
  const s = scratch();
  try {
    const out = applySeries(s.root, { home: s.home });
    assert.equal(out.ok, true);
    assert.ok(out.skipped);
    assert.equal(formatApplyOutcome(out).includes("no patches registered"), true);
  } finally {
    s.cleanup();
  }
});

test("statusAll reports one row per active patch", () => {
  const s = scratch();
  try {
    writeFileSync(join(s.root, "src", "a.txt"), "old\n", "utf8");
    addPatch(writePatchFile(s.root, "p.patch", diffFor("src/a.txt", ["old"], ["new"])), s.home);
    const rows = statusAll(s.root, s.home);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, "clean");
  } finally {
    s.cleanup();
  }
});

test("smokeCheck passes when there is nothing to boot", () => {
  const s = scratch();
  try {
    assert.equal(smokeCheck(s.root).ok, true, "a tree without dist/cli.js cannot fail a boot it never does");
  } finally {
    s.cleanup();
  }
});

test("pendingPatchNotice reports set-aside patches and forgets resolved ones", () => {
  const s = scratch();
  try {
    writeFileSync(join(s.root, "src", "a.txt"), "upstream moved this\n", "utf8");
    const { entry } = addPatch(
      writePatchFile(s.root, "p.patch", diffFor("src/a.txt", ["what it used to say"], ["local fix"])),
      s.home,
    );

    const out = applySeries(s.root, { home: s.home, skipSmoke: true });
    writeLastRun(out, s.home);
    assert.equal(readLastRun(s.home)?.setAside.length, 1);

    const notice = pendingPatchNotice(s.home);
    assert.ok(notice, "a set-aside patch must surface");
    assert.ok(notice!.includes(entry.id));
    assert.ok(notice!.includes("never forced"));

    // The user removes the patch. The record still names it, but it is no longer
    // the user's problem — reporting it again would train them to ignore this.
    removePatch(entry.id, s.home);
    assert.equal(pendingPatchNotice(s.home), null);
  } finally {
    s.cleanup();
  }
});

test("pendingPatchNotice stays silent after a clean run", () => {
  const s = scratch();
  try {
    writeFileSync(join(s.root, "src", "a.txt"), "old\n", "utf8");
    addPatch(writePatchFile(s.root, "p.patch", diffFor("src/a.txt", ["old"], ["new"])), s.home);
    writeLastRun(applySeries(s.root, { home: s.home, skipSmoke: true }), s.home);
    assert.equal(pendingPatchNotice(s.home), null, "nothing set aside, nothing to say");
  } finally {
    s.cleanup();
  }
});

/**
 * A source checkout, which is the shape the two roots diverge in: the CLI runs
 * from `<repo>/packages/daemon`, and a `git format-patch` off the same checkout
 * addresses `packages/core/...` from `<repo>`.
 */
function sourceCheckout(): { home: string; repo: string; installRoot: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), "bastra-patch-src-"));
  const home = join(base, "home");
  const repo = join(base, "repo");
  const installRoot = join(repo, "packages", "daemon");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(repo, "packages", "core", "src"), { recursive: true });
  mkdirSync(installRoot, { recursive: true });
  writeFileSync(join(installRoot, "package.json"), '{ "name": "@bastra-recall/daemon" }\n', "utf8");
  writeFileSync(join(repo, "packages", "core", "src", "a.txt"), "old\n", "utf8");
  const g = (...args: string[]) => {
    const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
    return r.stdout;
  };
  g("init", "-q", "-b", "main");
  g("config", "user.email", "test@example.invalid");
  g("config", "user.name", "test");
  g("add", "-A");
  g("commit", "-qm", "initial");
  return { home, repo, installRoot, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function gitIn(repo: string, ...args: string[]): { status: number | null; stdout: string } {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "" };
}

test("a source install addresses patches from the repo root, not the package root", () => {
  const s = sourceCheckout();
  try {
    const target = join(s.repo, "packages", "core", "src", "a.txt");
    addPatch(
      writePatchFile(s.home, "p.patch", diffFor("packages/core/src/a.txt", ["old"], ["new"])),
      s.home,
    );

    // The install root is the daemon package; the patch names a path outside it.
    // `git apply` run from there does not fail on such a path — it SKIPS it and
    // exits 0 — so the verdict has to come from the repo root or it is fiction.
    assert.equal(statusAll(s.installRoot, s.home)[0].state, "clean");

    const out = applySeries(s.installRoot, { home: s.home, skipSmoke: true });
    assert.equal(out.applied.length, 1, "the patch applies");
    assert.equal(out.setAside.length, 0);
    // The claim under test is about the tree, not the report: "applied" has to
    // mean the file changed.
    assert.equal(readFileSync(target, "utf8"), "new\n", "reported applied, so the file must have changed");
  } finally {
    s.cleanup();
  }
});

test("a patch git skips is never counted as applied", () => {
  const s = sourceCheckout();
  try {
    // Nothing outside the repo is addressable, and git says so by skipping.
    addPatch(writePatchFile(s.home, "p.patch", diffFor("../outside.txt", ["old"], ["new"])), s.home);
    const out = applySeries(s.installRoot, { home: s.home, skipSmoke: true });
    assert.equal(out.applied.length, 0, "a skip is not an apply — the fix would be silently missing");
    assert.equal(out.retired.length, 0, "and it is not upstream either");
    assert.equal(out.setAside.length, 1);
  } finally {
    s.cleanup();
  }
});

test("a 3-way that cannot merge leaves the tree and the index exactly as they were", () => {
  const s = sourceCheckout();
  try {
    const rel = "packages/core/src/a.txt";
    const target = join(s.repo, rel);

    // A patch git can attempt a real 3-way with: it carries the blob ids of the
    // pre-image, so `--3way` has something to merge from.
    writeFileSync(target, "local fix\n", "utf8");
    gitIn(s.repo, "commit", "-qam", "local fix");
    const patch = gitIn(s.repo, "format-patch", "-1", "--stdout").stdout;
    gitIn(s.repo, "reset", "-q", "--hard", "HEAD~1");

    // Upstream rewrote the same region, so neither direction is clean and the
    // merge has a genuine conflict to fail on.
    writeFileSync(target, "upstream rewrote this line entirely\n", "utf8");
    gitIn(s.repo, "commit", "-qam", "upstream");

    const before = readFileSync(target, "utf8");
    const indexBefore = gitIn(s.repo, "status", "--porcelain").stdout;

    const { entry } = addPatch(writePatchFile(s.home, "p.patch", patch), s.home);
    const out = applySeries(s.installRoot, { home: s.home, skipSmoke: true });

    assert.equal(out.setAside.length, 1, "a patch that cannot merge is set aside");
    assert.equal(out.setAside[0].entry.id, entry.id);
    assert.equal(out.applied.length, 0);
    // `git apply --3way` writes conflict markers and stages them BEFORE it
    // reports failure, so "it returned non-zero" is not evidence the file
    // survived. The promise is that the file is untouched; check the file.
    assert.equal(readFileSync(target, "utf8"), before, "the file must be byte-identical");
    assert.ok(!readFileSync(target, "utf8").includes("<<<<<<<"), "no conflict markers may be left behind");
    assert.equal(gitIn(s.repo, "status", "--porcelain").stdout, indexBefore, "the index must be untouched");
  } finally {
    s.cleanup();
  }
});

/**
 * Builds a rename patch whose 3-way is guaranteed to conflict, and returns the
 * paths involved. `name` picks the file so the same shape can be built once
 * with an ASCII path and once with one git will C-quote.
 */
function conflictingRenamePatch(
  s: { home: string; repo: string },
  fromName: string,
  toName: string,
): { patch: string; fromAbs: string; toAbs: string } {
  const dir = "packages/core/src";
  const fromAbs = join(s.repo, dir, fromName);
  const toAbs = join(s.repo, dir, toName);

  // Enough shared context that git records a rename (similarity) rather than a
  // delete plus an add — the rename header is the whole point of the fixture.
  writeFileSync(fromAbs, "one\ntwo\nthree\nfour\nfive\nsix\n", "utf8");
  gitIn(s.repo, "add", "-A");
  gitIn(s.repo, "commit", "-qm", "content to rename");
  gitIn(s.repo, "mv", `${dir}/${fromName}`, `${dir}/${toName}`);
  writeFileSync(toAbs, "one\nTWO\nthree\nfour\nfive\nsix\n", "utf8");
  gitIn(s.repo, "add", "-A");
  gitIn(s.repo, "commit", "-qm", "rename + edit");
  const patch = gitIn(s.repo, "format-patch", "-1", "--stdout").stdout;
  gitIn(s.repo, "reset", "-q", "--hard", "HEAD~1");

  // Upstream rewrote the same region under the OLD name, so the merge has a
  // genuine conflict and the source path is what the apply deletes.
  writeFileSync(fromAbs, "upstream rewrote every line of this file\n", "utf8");
  gitIn(s.repo, "commit", "-qam", "upstream");
  return { patch, fromAbs, toAbs };
}

test("a rename patch that fails its 3-way puts the source path back", () => {
  const s = sourceCheckout();
  try {
    const { patch, fromAbs, toAbs } = conflictingRenamePatch(s, "a.txt", "b.txt");
    assert.match(patch, /^rename from /m, "fixture must actually be a rename patch");

    const before = readFileSync(fromAbs, "utf8");
    const indexBefore = gitIn(s.repo, "status", "--porcelain").stdout;

    addPatch(writePatchFile(s.home, "p.patch", patch), s.home);
    const out = applySeries(s.installRoot, { home: s.home, skipSmoke: true });

    assert.equal(out.applied.length, 0);
    assert.equal(out.setAside.length, 1, "a rename that cannot merge is set aside like any other");
    // `git apply --numstat` names only the DESTINATION of a rename. Snapshot
    // that alone and a failed merge takes both paths with it: the destination
    // unlinked because it did not exist before, the source gone because the
    // apply deleted it and nothing recorded that it was ever there.
    assert.ok(existsSync(fromAbs), "the rename source must still exist");
    assert.equal(readFileSync(fromAbs, "utf8"), before, "and be byte-identical");
    assert.ok(!existsSync(toAbs), "the destination must not be left behind");
    assert.equal(gitIn(s.repo, "status", "--porcelain").stdout, indexBefore, "the index must be untouched");
  } finally {
    s.cleanup();
  }
});

test("a rename path git C-quotes is enumerated, not guessed at", () => {
  const s = sourceCheckout();
  try {
    // git writes non-ASCII paths in the rename header as "sp\303\244t.txt",
    // regardless of what the -z plumbing reports. A vault of Cyrillic memories
    // is the normal case here, not an exotic one.
    const { patch, fromAbs, toAbs } = conflictingRenamePatch(s, "спät.txt", "спäter.txt");
    assert.match(patch, /^rename from "/m, "fixture must produce a quoted rename header");

    const before = readFileSync(fromAbs, "utf8");
    addPatch(writePatchFile(s.home, "p.patch", patch), s.home);
    const out = applySeries(s.installRoot, { home: s.home, skipSmoke: true });

    assert.equal(out.setAside.length, 1);
    assert.ok(existsSync(fromAbs), "the quoted source path must be decoded and restored");
    assert.equal(readFileSync(fromAbs, "utf8"), before);
    assert.ok(!existsSync(toAbs), "the destination must not be left behind");
    assert.equal(gitIn(s.repo, "status", "--porcelain").stdout, "", "the index must be untouched");
  } finally {
    s.cleanup();
  }
});

/**
 * A repo where one patch merges ONLY through `--3way`, which is the case a
 * reverse-apply cannot undo. The merge produces a file that matches neither
 * side of the patch, so `git apply --reverse` cannot find its post-image and
 * fails — leaving the patched bytes on disk under a report that says they were
 * reversed.
 */
function threeWayFixture(s: { repo: string }): { target: string; patch: string } {
  const target = join(s.repo, "packages", "core", "src", "a.txt");
  const lines = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
  const at = (i: number, text: string) => lines.map((l, n) => (n === i ? text : l)).join("\n") + "\n";

  writeFileSync(target, lines.join("\n") + "\n", "utf8");
  gitIn(s.repo, "commit", "-qam", "ten lines");
  writeFileSync(target, at(1, "local fix"), "utf8");
  gitIn(s.repo, "commit", "-qam", "local fix");
  const patch = gitIn(s.repo, "format-patch", "-1", "--stdout").stdout;
  gitIn(s.repo, "reset", "-q", "--hard", "HEAD~1");

  // Upstream rewrites a CONTEXT line of the same hunk: near enough that the
  // plain apply can no longer find its context, far enough that the 3-way has
  // an unambiguous merge and succeeds.
  writeFileSync(target, at(4, "upstream"), "utf8");
  gitIn(s.repo, "commit", "-qam", "upstream");
  return { target, patch };
}

function bootBreaker(installRoot: string, extra: string[] = []): string {
  mkdirSync(join(installRoot, "dist"), { recursive: true });
  writeFileSync(join(installRoot, "dist", "cli.js"), "process.exit(0);\n", "utf8");
  return diffFor("packages/daemon/dist/cli.js", ["process.exit(0);"], [...extra, "process.exit(3);"]);
}

test("a 3-way patch is put back by the rollback", () => {
  const s = sourceCheckout();
  try {
    const { target, patch } = threeWayFixture(s);
    const boom = bootBreaker(s.installRoot);
    const cli = join(s.installRoot, "dist", "cli.js");

    const before = readFileSync(target, "utf8");
    const statusBefore = gitIn(s.repo, "status", "--porcelain").stdout;

    addPatch(writePatchFile(s.home, "threeway.patch", patch), s.home);
    addPatch(writePatchFile(s.home, "boom.patch", boom), s.home);

    const out = applySeries(s.installRoot, { home: s.home });

    assert.equal(out.ok, false);
    assert.equal(out.rolledBack, true, "everything went back, so the run may say so");
    assert.equal(out.unrestored, undefined);
    assert.equal(out.applied.length, 0, "a verified rollback reports nothing as applied");
    // The claim is about the tree, not the report. Reversing the patch fails
    // here — this passes only because the rollback copies bytes back.
    assert.equal(readFileSync(target, "utf8"), before, "the merged file must be byte-identical again");
    assert.ok(!readFileSync(target, "utf8").includes("local fix"), "no patched line may survive");
    assert.equal(readFileSync(cli, "utf8"), "process.exit(0);\n", "and the patch that broke the boot is gone too");
    assert.equal(gitIn(s.repo, "status", "--porcelain").stdout, statusBefore, "the index must be untouched");
  } finally {
    s.cleanup();
  }
});

test("a rollback that cannot put a file back says so instead of claiming it worked", (t) => {
  if (process.getuid?.() === 0) {
    t.skip("running as root, which ignores the permission bits this case is built on");
    return;
  }
  const s = sourceCheckout();
  try {
    const rel = "packages/core/src/a.txt";
    const target = join(s.repo, rel);
    // The paths the module reports come from `git rev-parse --show-toplevel`,
    // which resolves symlinks — and on macOS the temp root is one (/var).
    const reported = join(realpathSync(s.repo), rel);
    // The boot check runs the PATCHED cli, which is the one hook a test has
    // between the apply and the rollback: it takes the write permission off the
    // very file the rollback is about to put back, then fails to boot.
    const boom = bootBreaker(s.installRoot, [`require("fs").chmodSync(${JSON.stringify(target)}, 0o444);`]);

    addPatch(writePatchFile(s.home, "p.patch", diffFor(rel, ["old"], ["local fix"])), s.home);
    addPatch(writePatchFile(s.home, "boom.patch", boom), s.home);

    const out = applySeries(s.installRoot, { home: s.home });
    chmodSync(target, 0o644); // so the assertions below and the teardown can get at it

    assert.equal(out.ok, false);
    assert.equal(out.rolledBack, false, "a rollback nobody could verify must not be reported as one");
    assert.deepEqual(out.unrestored, [reported]);
    assert.equal(out.applied.length, 2, "a half-restored install keeps naming what went on");
    assert.equal(readFileSync(target, "utf8"), "local fix\n", "and the file really is still patched");

    writeLastRun(out, s.home);
    assert.deepEqual(readLastRun(s.home)?.unrestored, [reported], "the record carries it to the next session");

    const notice = pendingPatchNotice(s.home);
    assert.ok(notice, "an install in this state has to speak up");
    assert.ok(notice!.includes("neither patched nor the one the updater produced"));
    assert.ok(notice!.includes(reported), "the operator has to be told which file");
    assert.ok(notice!.includes("~/.bastra/update-backups"), "and where the pre-update bytes still are");
    assert.ok(!notice!.includes("running unpatched"), "which is the one thing this install is NOT");
    assert.ok(formatApplyOutcome(out).includes(reported));
  } finally {
    s.cleanup();
  }
});

test("a restore that has to recreate a file keeps its permission bits", () => {
  const s = sourceCheckout();
  try {
    const { patch, fromAbs } = conflictingRenamePatch(s, "a.txt", "b.txt");
    chmodSync(fromAbs, 0o755);
    gitIn(s.repo, "commit", "-qam", "make it executable");

    addPatch(writePatchFile(s.home, "p.patch", patch), s.home);
    const out = applySeries(s.installRoot, { home: s.home, skipSmoke: true });

    assert.equal(out.setAside.length, 1, "the rename still cannot merge");
    assert.ok(existsSync(fromAbs), "and the source path is put back");
    // The apply DELETES the rename source, so the restore has to create it
    // again — a plain writeFileSync hands back 0644 to a file that was runnable.
    assert.equal(statSync(fromAbs).mode & 0o777, 0o755, "including the bit that makes it runnable");
  } finally {
    s.cleanup();
  }
});

test("a rollback recreates a directory the rename emptied", () => {
  const s = sourceCheckout();
  try {
    // A file alone in its directory, renamed OUT of it. `git apply` removes the
    // directory it empties, so the copy-back has nowhere to write the source
    // back to — and an ENOENT here would be reported as a file needing hand
    // repair, over a rollback there was nothing wrong with.
    const dir = join(s.repo, "packages", "core", "src", "lonely");
    const from = join(dir, "a.txt");
    mkdirSync(dir, { recursive: true });
    writeFileSync(from, "one\ntwo\nthree\nfour\nfive\nsix\n", "utf8");
    gitIn(s.repo, "add", "-A");
    gitIn(s.repo, "commit", "-qm", "a file alone in a directory");
    gitIn(s.repo, "mv", "packages/core/src/lonely/a.txt", "packages/core/src/renamed.txt");
    gitIn(s.repo, "commit", "-qm", "rename it out");
    const patch = gitIn(s.repo, "format-patch", "-1", "--stdout").stdout;
    gitIn(s.repo, "reset", "-q", "--hard", "HEAD~1");
    assert.match(patch, /^rename from /m, "fixture must actually be a rename patch");

    const boom = bootBreaker(s.installRoot);
    const before = readFileSync(from, "utf8");
    const statusBefore = gitIn(s.repo, "status", "--porcelain").stdout;

    addPatch(writePatchFile(s.home, "rename.patch", patch), s.home);
    addPatch(writePatchFile(s.home, "boom.patch", boom), s.home);

    const out = applySeries(s.installRoot, { home: s.home });

    assert.equal(out.ok, false);
    assert.equal(out.unrestored, undefined, "a directory that can be made again is not a hand repair");
    assert.equal(out.rolledBack, true);
    assert.ok(existsSync(dir), "the emptied directory has to come back");
    assert.equal(readFileSync(from, "utf8"), before, "with the file byte-identical inside it");
    assert.ok(!existsSync(join(s.repo, "packages", "core", "src", "renamed.txt")), "and the destination gone");
    assert.equal(gitIn(s.repo, "status", "--porcelain").stdout, statusBefore, "the index must be untouched");
  } finally {
    s.cleanup();
  }
});
