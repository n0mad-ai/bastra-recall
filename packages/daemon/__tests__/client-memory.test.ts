/**
 * #674: notes in Claude Code's and Codex's own memory folders are found,
 * reported with how many are not in the vault yet, and imported through the
 * folder import — after which they no longer count as pending.
 *
 * Run: node --import tsx --test packages/daemon/__tests__/client-memory.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { slugify } from "@bastra-recall/core";
import { clientMemoryLines, findClientMemoryDirs, migrateClientLabels, type ClientMemoryEnv } from "../src/cli/client-memory.js";
import { importVault, IMPORT_ROOT } from "../src/import-vault.js";

const CC_NOTE = `---
name: No silent removals
description: Adding a feature never removes an existing one
type: feedback
---
Adding a feature means extending, never removing what exists.
`;

async function fixture(): Promise<{ root: string; home: string; vault: string }> {
  const root = await mkdtemp(join(tmpdir(), "bastra-client-memory-"));
  const home = join(root, "home");
  const vault = join(root, "vault");
  await mkdir(join(vault, "memories"), { recursive: true });
  const ccMem = join(home, ".claude", "projects", `${home.replace(/[^a-zA-Z0-9]/g, "-")}-Projects-shop`, "memory");
  await mkdir(ccMem, { recursive: true });
  await writeFile(join(ccMem, "feedback_no_silent_removals.md"), CC_NOTE);
  await writeFile(join(ccMem, "MEMORY.md"), "- [No silent removals](feedback_no_silent_removals.md)\n");
  // A project folder with an empty memory dir is not reported.
  await mkdir(join(home, ".claude", "projects", "-empty", "memory"), { recursive: true });
  await mkdir(join(home, ".codex", "memories"), { recursive: true });
  await writeFile(join(home, ".codex", "memories", "deploy.md"), "# Deploy\n\nReleases are cut from main only.\n");
  return { root, home, vault };
}

test("#674 — finds the Claude Code and Codex folders that hold notes, MEMORY.md not counted", async () => {
  const { root, home, vault } = await fixture();
  try {
    const dirs = await findClientMemoryDirs(vault, { home });
    assert.deepEqual(
      dirs.map((d) => [d.client, d.label, d.notes, d.pending]),
      [
        ["claude-code", "claude-code-projects-shop", 1, 1],
        ["codex", "codex", 1, 1],
      ],
    );
    const lines = clientMemoryLines(dirs);
    assert.match(lines[0], /claude-code: .* 1 note\(s\), 1 not in the vault yet/);
    assert.match(lines.at(-1) ?? "", /bastra import clients/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("#674 — after the import the notes are no longer pending; a newer note is", async () => {
  const { root, home, vault } = await fixture();
  try {
    for (const d of await findClientMemoryDirs(vault, { home })) {
      const r = await importVault(vault, d.dir, { label: d.label });
      assert.equal(r.skipped.length, 0);
    }
    assert.ok(existsSync(join(vault, IMPORT_ROOT, "claude-code-projects-shop", ".bastra-imported")));
    let dirs = await findClientMemoryDirs(vault, { home });
    assert.deepEqual(dirs.map((d) => d.pending), [0, 0]);
    assert.deepEqual(clientMemoryLines(dirs).filter((l) => l.includes("import clients")), []);

    const later = new Date(Date.now() + 60_000);
    const fresh = join(home, ".codex", "memories", "new.md");
    await writeFile(fresh, "# New\n\nA note written after the import.\n");
    await utimes(fresh, later, later);
    dirs = await findClientMemoryDirs(vault, { home });
    assert.deepEqual(dirs.map((d) => [d.label, d.pending]), [["claude-code-projects-shop", 0], ["codex", 1]]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("#674 — CLAUDE_CONFIG_DIR / CODEX_HOME move the folders; nothing found means no doctor lines", async () => {
  const { root, home, vault } = await fixture();
  try {
    const dirs = await findClientMemoryDirs(vault, {
      home,
      claudeConfigDir: join(root, "nowhere"),
      codexHome: join(root, "nowhere"),
    });
    assert.deepEqual(dirs, []);
    assert.deepEqual(clientMemoryLines(dirs), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Revert-check: put the flat `readdir` back in describe() (client-memory.ts) →
// all three assertions are red: the folder is not found, the count is 1 not 4,
// and a subfolder edit is not pending.
test("#674 — doctor walks the folder the way the import does: subfolder notes are found, counted, and pending", async () => {
  const { root, home, vault } = await fixture();
  try {
    const ccMem = join(home, ".claude", "projects", `${home.replace(/[^a-zA-Z0-9]/g, "-")}-Projects-nested`, "memory");
    await mkdir(join(ccMem, "feedback"), { recursive: true });
    await mkdir(join(ccMem, ".hidden"), { recursive: true });
    await writeFile(join(ccMem, "MEMORY.md"), "- [b](feedback/b.md)\n");
    for (const n of ["b", "c", "d"]) await writeFile(join(ccMem, "feedback", `${n}.md`), CC_NOTE);
    await writeFile(join(ccMem, ".hidden", "x.md"), CC_NOTE); // the import skips dotdirs
    const find = async () => (await findClientMemoryDirs(vault, { home })).find((d) => d.label === "claude-code-projects-nested")!;

    let d = await find();
    assert.ok(d, "a folder whose notes all sit in subfolders is found");
    const dry = await importVault(vault, d.dir, { label: d.label, dryRun: true });
    assert.equal(d.notes, 3);
    assert.equal(d.notes, dry.scanned, "doctor counts what the import scans");

    await importVault(vault, d.dir, { label: d.label });
    assert.equal((await find()).pending, 0);
    const later = new Date(Date.now() + 60_000);
    await writeFile(join(ccMem, "feedback", "b.md"), CC_NOTE + "edited\n");
    await utimes(join(ccMem, "feedback", "b.md"), later, later);
    assert.equal((await find()).pending, 1, "a subfolder edit after the import is pending");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a project opened in the home directory itself is labelled without the OS user name", async () => {
  const root = await mkdtemp(join(tmpdir(), "bastra-client-memory-"));
  try {
    const home = join(root, "Users", "alice");
    const slug = home.replace(/[^a-zA-Z0-9]/g, "-");
    for (const project of [slug, `${slug}-Projects-shop`]) {
      const mem = join(home, ".claude", "projects", project, "memory");
      await mkdir(mem, { recursive: true });
      await writeFile(join(mem, "feedback_no_silent_removals.md"), CC_NOTE);
    }
    const labels = (await findClientMemoryDirs(null, { home })).map((d) => d.label);
    assert.deepEqual(labels, ["claude-code-home", "claude-code-projects-shop"]);
    assert.ok(labels.every((l) => !l.includes("alice")), labels.join(", "));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// #885 follow-up: `~/home` slugged to the same `claude-code-home` as the home
// directory itself, so both would have been imported into one folder.
test("#885 — a project in ~/home gets a label of its own", async () => {
  const root = await mkdtemp(join(tmpdir(), "bastra-client-memory-"));
  try {
    const home = join(root, "Users", "alice");
    const slug = home.replace(/[^a-zA-Z0-9]/g, "-");
    for (const project of [slug, `${slug}-home`]) {
      const mem = join(home, ".claude", "projects", project, "memory");
      await mkdir(mem, { recursive: true });
      await writeFile(join(mem, "feedback_no_silent_removals.md"), CC_NOTE);
    }
    const labels = (await findClientMemoryDirs(null, { home })).map((d) => d.label);
    assert.deepEqual(labels, ["claude-code-home", "claude-code-home-home"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const LINKED_NOTE = `---
name: Release rule
description: Releases are cut from main
type: feedback
---
Releases come from main only. See [[feedback_no_silent_removals]].
`;

/** A real home path, so the old label is `claude-code-users-alice` (a temp
 *  path would run into the 80-character id cap); the folders sit in the temp
 *  dir through CLAUDE_CONFIG_DIR / CODEX_HOME. */
async function homeFixture(): Promise<{ root: string; env: ClientMemoryEnv; vault: string; mem: (p: string) => string }> {
  const root = await mkdtemp(join(tmpdir(), "bastra-client-memory-"));
  const env = { home: "/Users/alice", claudeConfigDir: join(root, "claude"), codexHome: join(root, "codex") };
  const vault = join(root, "vault");
  await mkdir(join(vault, "memories"), { recursive: true });
  const mem = (project: string) =>
    join(env.claudeConfigDir, "projects", project === "" ? "-Users-alice" : `-Users-alice-${project}`, "memory");
  return { root, env, vault, mem };
}

// Long enough that `claude-code-users-alice-…` and `claude-code-home-…` are cut
// at different places: the new id is not the old one with the label swapped.
const LONG = "feedback_never_remove_an_existing_feature_when_adding_a_new_one_anywhere";

async function seed(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "feedback_no_silent_removals.md"), CC_NOTE);
  await writeFile(join(dir, "feedback_release.md"), LINKED_NOTE);
  await writeFile(join(dir, `${LONG}.md`), CC_NOTE);
}

async function notesText(dir: string): Promise<string> {
  // The notes only: the marker names the source folder, which is a path.
  const files = (await readdir(dir, { recursive: true, withFileTypes: true })).filter((f) => f.name.endsWith(".md"));
  return (await Promise.all(files.map((f) => readFile(join(f.parentPath, f.name), "utf8")))).join("\n");
}

// Revert-check: drop the migrateClientLabels() call → the re-import creates
// every note a second time (`created` 3, not 0) and the old folder stays.
// Swap the old label inside the id instead of minting it from the source
// stamp → red: the long note keeps a cut-off id the import never mints.
test("#885 — an import under the old home label moves to claude-code-home, ids included; a second run is a no-op", async () => {
  const { root, env, vault, mem } = await homeFixture();
  try {
    await seed(mem(""));
    const [d] = await findClientMemoryDirs(vault, env);
    assert.deepEqual([d.label, d.previousLabel], ["claude-code-home", "claude-code-users-alice"]);
    await importVault(vault, d.dir, { label: d.previousLabel }); // what an earlier `import clients` wrote

    const moved = await migrateClientLabels(vault, [d]);
    assert.deepEqual(moved, [{ from: "claude-code-users-alice", to: "claude-code-home", memories: 3 }]);
    assert.equal(existsSync(join(vault, IMPORT_ROOT, "claude-code-users-alice")), false, "the old folder is gone");
    const files = (await readdir(join(vault, IMPORT_ROOT, "claude-code-home"))).sort();
    assert.deepEqual(files.slice(0, 3), [
      ".bastra-imported",
      "claude-code-home-feedback-never-remove-an-existing-feature-when-adding-a-new-one.md",
      "claude-code-home-feedback-no-silent-removals.md",
    ]);
    const text = await notesText(join(vault, IMPORT_ROOT));
    assert.ok(!text.includes("alice"), "no id, link, scope or source stamp keeps the user name");
    assert.match(text, /\[\[claude-code-home-feedback-no-silent-removals\]\]/, "links follow the new ids");

    // The import recognises every note as its own: nothing is written twice.
    const r = await importVault(vault, d.dir, { label: d.label });
    assert.deepEqual([r.written.created, r.skipped.length], [0, 0]);
    assert.deepEqual(await migrateClientLabels(vault, await findClientMemoryDirs(vault, env)), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("#1001 review — migration resumes after content was rewritten but its file was not renamed", async () => {
  const { root, env, vault, mem } = await homeFixture();
  try {
    await seed(mem(""));
    const [d] = await findClientMemoryDirs(vault, env);
    await importVault(vault, d.dir, { label: d.previousLabel });
    const oldDir = join(vault, IMPORT_ROOT, d.previousLabel!);
    const oldFile = join(oldDir, `${d.previousLabel}-feedback-no-silent-removals.md`);
    await writeFile(oldFile, (await readFile(oldFile, "utf8")).replaceAll(d.previousLabel!, d.label));

    const moved = await migrateClientLabels(vault, [d]);
    assert.equal(moved[0]?.skipped, undefined);
    assert.equal(existsSync(join(vault, IMPORT_ROOT, d.label)), true);
    const again = await importVault(vault, d.dir, { label: d.label });
    assert.equal(again.written.created, 0, "a resumed migration does not duplicate a note");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("#1001 review — a renamed long id still rewrites links left in other notes", async () => {
  const { root, env, vault, mem } = await homeFixture();
  try {
    await seed(mem(""));
    await writeFile(join(mem(""), "feedback_release.md"), `${LINKED_NOTE}\nSee [[${LONG}]].\n`);
    const [d] = await findClientMemoryDirs(vault, env);
    await importVault(vault, d.dir, { label: d.previousLabel });
    const oldDir = join(vault, IMPORT_ROOT, d.previousLabel!);
    const oldId = slugify(`${d.previousLabel}-${LONG}`);
    const newId = slugify(`${d.label}-${LONG}`);
    const oldFile = join(oldDir, `${oldId}.md`);
    await writeFile(oldFile, (await readFile(oldFile, "utf8")).replaceAll(d.previousLabel!, d.label).replaceAll(oldId, newId));
    await rename(oldFile, join(oldDir, `${newId}.md`));

    const moved = await migrateClientLabels(vault, [d]);
    assert.equal(moved[0]?.skipped, undefined);
    const text = await notesText(join(vault, IMPORT_ROOT, d.label));
    assert.match(text, new RegExp(`\\[\\[${newId}\\]\\]`));
    assert.ok(!text.includes(`[[${oldId}]]`), "no link to the truncated old id remains");
    const again = await importVault(vault, d.dir, { label: d.label });
    assert.equal(again.written.created, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("#1001 review — an unrecognizable partial id is reported, not rewritten", async () => {
  const { root, env, vault, mem } = await homeFixture();
  try {
    await seed(mem(""));
    const [d] = await findClientMemoryDirs(vault, env);
    await importVault(vault, d.dir, { label: d.previousLabel });
    const oldDir = join(vault, IMPORT_ROOT, d.previousLabel!);
    const oldFile = join(oldDir, `${d.previousLabel}-feedback-no-silent-removals.md`);
    const unknown = join(oldDir, "unexpected-id.md");
    await writeFile(oldFile, (await readFile(oldFile, "utf8")).replaceAll(d.previousLabel!, d.label));
    await rename(oldFile, unknown);

    const result = await migrateClientLabels(vault, [d]);
    assert.match(result[0]?.skipped ?? "", /cannot be reconstructed/);
    assert.equal(existsSync(unknown), true);
    assert.equal(existsSync(join(vault, IMPORT_ROOT, d.label)), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("#885 — a vault without the old folder, or with one another import made, is left alone", async () => {
  const { root, env, vault, mem } = await homeFixture();
  try {
    await seed(mem(""));
    await seed(join(root, "elsewhere"));
    const [d] = await findClientMemoryDirs(vault, env);
    assert.deepEqual(await migrateClientLabels(vault, [d]), []);
    assert.equal(existsSync(join(vault, IMPORT_ROOT)), false);

    // Same folder name, but its marker names another source folder.
    await importVault(vault, join(root, "elsewhere"), { label: d.previousLabel });
    assert.deepEqual(await migrateClientLabels(vault, [d]), []);
    assert.ok(existsSync(join(vault, IMPORT_ROOT, d.previousLabel!, ".bastra-imported")));
    assert.equal(existsSync(join(vault, IMPORT_ROOT, "claude-code-home")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("#885 — ~/home leaves claude-code-home first, then the home directory moves in; a dry run moves nothing", async () => {
  const { root, env, vault, mem } = await homeFixture();
  try {
    await seed(mem(""));
    await seed(mem("home"));
    const dirs = await findClientMemoryDirs(vault, env);
    assert.deepEqual(
      dirs.map((d) => [d.label, d.previousLabel === "claude-code-home"]),
      [
        ["claude-code-home", false],
        ["claude-code-home-home", true],
      ],
    );
    for (const d of dirs) await importVault(vault, d.dir, { label: d.previousLabel });

    const dry = await migrateClientLabels(vault, dirs, { dryRun: true });
    assert.deepEqual(
      dry.map((m) => [m.to, m.skipped === undefined]),
      [
        ["claude-code-home-home", true],
        ["claude-code-home", false], // its target is taken until ~/home has moved
      ],
    );
    assert.ok(existsSync(join(vault, IMPORT_ROOT, dirs[0].previousLabel!)), "a dry run moves nothing");

    const moved = await migrateClientLabels(vault, dirs);
    assert.deepEqual(
      moved.map((m) => [m.to, m.memories, m.skipped]),
      [
        ["claude-code-home-home", 3, undefined],
        ["claude-code-home", 3, undefined],
      ],
    );
    for (const d of await findClientMemoryDirs(vault, env)) {
      const r = await importVault(vault, d.dir, { label: d.label });
      assert.equal(r.written.created, 0, `${d.label}: nothing imported twice`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
