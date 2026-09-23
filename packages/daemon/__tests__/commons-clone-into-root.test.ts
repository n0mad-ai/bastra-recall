/**
 * `bastra commons enable` on a root the bridges pool already occupies.
 *
 * `bridgesPath()` defaults to `commonsPath()`, and shared recall bridges are
 * on by default, so the daemon mints `bridges/` and `last-mint.json` into
 * ~/.bastra/commons before Commons is ever enabled. A plain `git clone` into
 * that non-empty directory failed with exit 128 for every such user.
 *
 * Runner: `tsx --test __tests__/commons-clone-into-root.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneIntoRoot } from "../src/cli/commons.js";
import { findExecutable } from "../src/cli/exec.js";

const git = findExecutable("git");

function sourceRepo(dir: string): string {
  const src = join(dir, "source");
  mkdirSync(join(src, "recipes"), { recursive: true });
  writeFileSync(join(src, "README.md"), "commons\n");
  writeFileSync(join(src, "recipes", "one.md"), "recipe\n");
  const g = (...args: string[]) => {
    const r = spawnSync(git!, ["-C", src, ...args], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  };
  g("init", "-q");
  g("add", ".");
  g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  return `file://${src}`;
}

function withFixture(fn: (dir: string, url: string, root: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "bastra-commons-clone-"));
  try {
    fn(dir, sourceRepo(dir), join(dir, "commons"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a root that already holds the bridges pool is cloned into, and the pool survives", { skip: !git }, () => {
  withFixture((dir, url, root) => {
    mkdirSync(join(root, "bridges", "en"), { recursive: true });
    writeFileSync(join(root, "bridges", "en", "b.json"), "{}");
    writeFileSync(join(root, "last-mint.json"), '{"minted":20}');

    // Revert-check: put the plain `git clone … path` back and this is `ok: false`.
    const r = cloneIntoRoot(git!, url, root);
    assert.deepEqual(r, { ok: true });
    assert.ok(existsSync(join(root, ".git")), "the root is now the checkout");
    assert.ok(existsSync(join(root, "recipes", "one.md")), "the recipes arrived");
    assert.equal(readFileSync(join(root, "bridges", "en", "b.json"), "utf8"), "{}", "the minted bridges are untouched");
    assert.equal(readFileSync(join(root, "last-mint.json"), "utf8"), '{"minted":20}');
    assert.deepEqual(readdirSync(dir).filter((n) => n.includes("-clone-")), [], "no staging directory is left behind");
  });
});

test("a name on both sides is refused by name, and the local file is not overwritten", { skip: !git }, () => {
  withFixture((dir, url, root) => {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "README.md"), "mine\n");

    // Revert-check: drop the clash filter and README.md is overwritten.
    const r = cloneIntoRoot(git!, url, root);
    assert.equal(r.ok, false);
    assert.match((r as { detail: string }).detail, /README\.md/, "the refusal names the clash");
    assert.equal(readFileSync(join(root, "README.md"), "utf8"), "mine\n", "the user's file stays");
    assert.ok(!existsSync(join(root, ".git")), "a refused clone leaves no half checkout");
    assert.deepEqual(readdirSync(dir).filter((n) => n.includes("-clone-")), []);
  });
});

test("an absent root is a plain clone", { skip: !git }, () => {
  withFixture((_dir, url, root) => {
    assert.deepEqual(cloneIntoRoot(git!, url, root), { ok: true });
    assert.ok(existsSync(join(root, "recipes", "one.md")));
  });
});
