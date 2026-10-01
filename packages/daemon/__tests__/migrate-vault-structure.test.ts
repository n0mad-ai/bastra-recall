/**
 * scripts/migrate-vault-structure.ts --apply.
 *
 * rename() replaces its target on POSIX, so a flat leftover in the legacy
 * `memorys/` folder silently overwrote the already-migrated note under
 * `memories/` and the run still reported `failed: 0`. A frontmatter `scope`
 * is also joined into the target path, so one carrying a path separator or
 * `..` could move a note out of `memories/` altogether.
 *
 * Run: npx tsx --test packages/daemon/__tests__/migrate-vault-structure.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dirname, "..", "scripts", "migrate-vault-structure.ts");

function note(id: string, scope: string, text: string): string {
  return `---\nid: ${id}\ntitle: ${id}\ntype: lesson\nscope: ${JSON.stringify(scope)}\n---\n\n${text}\n`;
}

function runMigration(vault: string, apply: boolean) {
  return spawnSync(process.execPath, ["--import", "tsx", SCRIPT, ...(apply ? ["--apply"] : [])], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, BASTRA_VAULT_PATH: vault },
  });
}

// <root>/vault is the vault; an escaping scope would land in <root>.
function makeRoot(): { root: string; vault: string } {
  const root = mkdtempSync(join(tmpdir(), "bastra-migrate-structure-"));
  const vault = join(root, "vault");
  mkdirSync(join(vault, "memorys"), { recursive: true });
  return { root, vault };
}

test("--apply does not overwrite a note that already exists at the target", () => {
  const { root, vault } = makeRoot();
  try {
    mkdirSync(join(vault, "memories", "user"), { recursive: true });
    writeFileSync(join(vault, "memorys", "dup.md"), note("dup", "user-preference", "OLD flat copy"));
    writeFileSync(join(vault, "memories", "user", "dup.md"), note("dup", "user-preference", "MIGRATED current copy"));

    const dry = runMigration(vault, false);
    assert.match(dry.stdout, /collision/, "the dry-run does not list the collision");

    const res = runMigration(vault, true);
    assert.equal(res.status, 0, res.stderr);
    assert.match(readFileSync(join(vault, "memories", "user", "dup.md"), "utf8"), /MIGRATED current copy/);
    assert.ok(existsSync(join(vault, "memorys", "dup.md")), "the flat copy was moved over the migrated note");
    assert.match(res.stdout, /skipped: 1/);
    assert.doesNotMatch(res.stdout, /collision \(target exists/, "apply should not print the pre-scan collision again");
    assert.equal((res.stderr.match(/skip \(target exists/g) ?? []).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--apply leaves scopes rejected by the normal save path in place", () => {
  const { root, vault } = makeRoot();
  try {
    writeFileSync(join(vault, "memorys", "hidden.md"), note("hidden", ".hidden", "must stay indexed"));
    writeFileSync(join(vault, "memorys", "empty.md"), note("empty", "", "must stay put"));
    const res = runMigration(vault, true);
    assert.equal(res.status, 0, res.stderr);
    assert.ok(existsSync(join(vault, "memorys", "hidden.md")));
    assert.ok(existsSync(join(vault, "memorys", "empty.md")));
    assert.equal(existsSync(join(vault, "memories", "projects", ".hidden", "hidden.md")), false);
    assert.match(res.stderr, /unsafe scope/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dry-run names two sources planned for the same empty target", () => {
  const { root, vault } = makeRoot();
  try {
    mkdirSync(join(vault, "bookmarks"), { recursive: true });
    writeFileSync(join(vault, "memorys", "dup.md"), note("dup", "all-projects", "first source"));
    writeFileSync(join(vault, "bookmarks", "dup.md"), note("dup", "all-projects", "second source"));
    const dry = runMigration(vault, false);
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /collisions: 1/);
    assert.equal(existsSync(join(vault, "memories", "all-projects", "dup.md")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--apply skips a note whose scope would leave memories/", () => {
  const { root, vault } = makeRoot();
  try {
    writeFileSync(join(vault, "memorys", "esc.md"), note("esc", "../../../escaped", "must stay put"));
    writeFileSync(join(vault, "memorys", "ok.md"), note("ok", "all-projects", "moves normally"));

    const res = runMigration(vault, true);
    assert.equal(res.status, 0, res.stderr);
    assert.ok(existsSync(join(vault, "memorys", "esc.md")), "the unsafe-scope note left memorys/");
    assert.equal(existsSync(join(root, "escaped")), false, "a note was written outside the vault");
    assert.ok(existsSync(join(vault, "memories", "all-projects", "ok.md")), "the safe note was not migrated");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
