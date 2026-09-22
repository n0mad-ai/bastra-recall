/**
 * #240/A9, A10, B11 — three independent defects with one shape: an operation
 * reports success while its effect was silently lost or never happened.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "@bastra-recall/core";
import { existsSync } from "node:fs";
import { addFloor, release, listFloors, MAX_FLOORS } from "../src/floors.js";
import { openDocument } from "../src/documents-handler.js";

// ─── A9: floor registry under concurrency ───────────────────────

async function floorsFile(t: { after: (fn: () => unknown) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "bastra-floors-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, "floors.json");
}

test("A9: parallel addFloor calls all persist", async (t) => {
  const path = await floorsFile(t);

  // The natural shape: a surface pins several memories for ONE decision.
  await Promise.all(
    Array.from({ length: MAX_FLOORS }, (_, i) =>
      addFloor({ memory_id: `mem-${i}`, condition: "decision-x", reason: "r" }, path),
    ),
  );

  const persisted = await listFloors(undefined, path);
  assert.equal(
    persisted.length,
    MAX_FLOORS,
    `expected ${MAX_FLOORS} floors, got ${persisted.length} — a lost floor is a silently dropped hard constraint`,
  );
});

test("A9: the cap is enforced against committed state, not a stale read", async (t) => {
  const path = await floorsFile(t);

  const results = await Promise.allSettled(
    Array.from({ length: MAX_FLOORS + 8 }, (_, i) =>
      addFloor({ memory_id: `mem-${i}`, condition: "c", reason: "r" }, path),
    ),
  );

  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal((await listFloors(undefined, path)).length, MAX_FLOORS);
  assert.equal(rejected.length, 8, "over-cap adds must be rejected, not silently dropped");
});

test("A9: a parallel release actually releases", async (t) => {
  const path = await floorsFile(t);
  for (let i = 0; i < 5; i++) {
    await addFloor({ memory_id: `keep-${i}`, condition: "gone", reason: "r" }, path);
  }

  await Promise.all([
    release("gone", path),
    addFloor({ memory_id: "new-1", condition: "stays", reason: "r" }, path),
  ]);

  const left = await listFloors(undefined, path);
  assert.ok(
    !left.some((e) => e.condition === "gone"),
    "released floors must not survive a concurrent add",
  );
  assert.ok(left.some((e) => e.memory_id === "new-1"), "the concurrent add must survive too");
});

// ─── A10: import ids are derived from source identity ───────────

test("A10: same basename in different source folders keeps stable ids on reimport", async (t) => {
  const { importVault } = await import("../src/import-vault.js");
  const root = await mkdtemp(join(tmpdir(), "bastra-import-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const src = join(root, "src");
  const target = join(root, "vault");
  await mkdir(join(src, "a"), { recursive: true });
  await mkdir(join(src, "b"), { recursive: true });
  await mkdir(target, { recursive: true });

  const note = (title: string) => `# ${title}\n\nSome body for ${title}.\n`;
  await writeFile(join(src, "a", "same.md"), note("Same A"), "utf8");
  await writeFile(join(src, "b", "same.md"), note("Same B"), "utf8");

  const idsFor = async () => {
    const vault = new Vault(target);
    await vault.init();
    const out = new Map<string, string>();
    for (const m of vault.list()) out.set(m.fm.id, m.fm.title);
    await vault.stop?.();
    return out;
  };

  await importVault(target, src, { label: "demo" });
  const before = await idsFor();
  assert.equal(before.size, 2, `expected two imported notes, got ${[...before.keys()]}`);

  // Remove one source file and reimport — the OTHER note's id must not move.
  await rm(join(src, "a", "same.md"));
  await importVault(target, src, { label: "demo" });
  const after = await idsFor();

  const bTitleBefore = [...before.entries()].find(([, t2]) => t2.includes("Same B"))?.[0];
  const bTitleAfter = [...after.entries()].find(([, t2]) => t2.includes("Same B"))?.[0];
  assert.ok(bTitleBefore && bTitleAfter, "the surviving note must still be present");
  assert.equal(
    bTitleAfter,
    bTitleBefore,
    "removing a sibling must not move the surviving note's id",
  );

  const titles = [...after.values()];
  assert.equal(
    new Set(titles).size,
    titles.length,
    `no content may end up duplicated under two ids: ${JSON.stringify(titles)}`,
  );
});

test("A10: a wikilink between nested imported notes resolves to a real id", async (t) => {
  // The A10 id change put the relative directory into the id, but every link
  // resolver still recomputed `slugify(label + basename)` — so a nested note
  // linking to a sibling produced a ghost on the very first import.
  const { importVault } = await import("../src/import-vault.js");
  const root = await mkdtemp(join(tmpdir(), "bastra-import-links-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const src = join(root, "src");
  const target = join(root, "vault");
  await mkdir(join(src, "a"), { recursive: true });
  await mkdir(target, { recursive: true });

  await writeFile(join(src, "a", "one.md"), "# One\n\nOne links to [[two]].\n", "utf8");
  await writeFile(join(src, "a", "two.md"), "# Two\n\nSecond note.\n", "utf8");

  const res = await importVault(target, src, { label: "demo" });

  const vault = new Vault(target);
  await vault.init();
  t.after(async () => {
    await vault.stop?.();
  });

  const ids = new Set(vault.list().map((m) => m.fm.id));
  const one = vault.list().find((m) => m.fm.title.includes("One"));
  assert.ok(one, "the linking note must have imported");

  const linked = [...(one.body.matchAll(/\[\[([^\]]+)\]\]/g))].map((m) => m[1]);
  assert.ok(linked.length > 0, "the wikilink must survive the import");
  for (const target of linked) {
    assert.ok(
      ids.has(target),
      `[[${target}]] must point at an imported id, have ${JSON.stringify([...ids])}`,
    );
  }
  assert.equal(res.skipped.length, 0);
});

test("A10 (Weg C): a pre-A10 twin stays as a visible active duplicate — never trashed", async (t) => {
  // Weg C: the import NEVER trashes an existing node. Automatic retirement of
  // a pre-A10 twin could not be made loss-free across four re-audit rounds
  // (orphaned sources, enriched frontmatter, TOCTOU), and its only failure
  // mode was silent, irreversible loss. So a pre-A10 node simply stays active
  // next to the new one; the user (or a future opt-in `bastra migrate`)
  // removes it with a confirmed delete.
  const { importVault, IMPORT_ROOT } = await import("../src/import-vault.js");
  const root = await mkdtemp(join(tmpdir(), "bastra-import-wegc-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const src = join(root, "src");
  const target = join(root, "vault");
  await mkdir(join(src, "a"), { recursive: true });
  const importFolder = join(target, IMPORT_ROOT, "demo");
  await mkdir(importFolder, { recursive: true });

  await writeFile(join(src, "a", "note.md"), "# Note\n\nA nested note.\n", "utf8");
  // A pre-A10 twin — even with an identical body, it is left alone.
  await writeFile(
    join(importFolder, "demo-note.md"),
    `---\nid: demo-note\ntitle: Note\ntype: reference\nsummary: the old identity\ntopic_path: [imported, demo]\ntags: [imported]\nscope: demo\nrecall_when: ["note"]\ncreated: 2026-06-01\nupdated: 2026-06-01\n---\n\n# Note\n\nA nested note.\n`,
    "utf8",
  );

  const res = await importVault(target, src, { label: "demo" });

  const vault = new Vault(target);
  await vault.init();
  t.after(async () => {
    await vault.stop?.();
  });

  assert.deepEqual(res.migrated, [], "Weg C never migrates");
  assert.ok(vault.get("demo-a-note"), "the new identity is written");
  assert.ok(vault.get("demo-note"), "the pre-A10 twin stays active — not trashed");
  assert.equal(
    existsSync(join(target, ".bastra", "trash", "demo-note.md")),
    false,
    "nothing is moved to trash",
  );
});


test("A10: a fresh import with root+nested same basename keeps BOTH", async (t) => {
  // The migration used to derive one legacy candidate per file and retire it
  // on mere existence. On a FIRST import `same.md` legitimately mints
  // `demo-same`; processing `z/same.md` computed the same legacy candidate,
  // found the file this very run had just written, and trashed it.
  for (const [first, second] of [["same.md", "z/same.md"], ["z/same.md", "same.md"]]) {
    const { importVault } = await import("../src/import-vault.js");
    const root = await mkdtemp(join(tmpdir(), "bastra-import-rootnested-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const src = join(root, "src");
    const target = join(root, "vault");
    await mkdir(join(src, "z"), { recursive: true });
    await mkdir(target, { recursive: true });
    // written in both orders so the result cannot depend on directory order
    await writeFile(join(src, first), `# ${first}\n\nBody ${first}.\n`, "utf8");
    await writeFile(join(src, second), `# ${second}\n\nBody ${second}.\n`, "utf8");

    const res = await importVault(target, src, { label: "demo" });
    const vault = new Vault(target);
    await vault.init();
    const active = vault.list().map((m) => m.fm.id).sort();
    await vault.stop?.();

    assert.deepEqual(active, ["demo-same", "demo-z-same"], `order ${first} first`);
    assert.deepEqual(res.migrated, [], "a first import has nothing to migrate");
    assert.deepEqual(res.ids.slice().sort(), active, "reported ids must match what is active");
  }
});

test("A10: a declared index.md is not overwritten by the synthetic index", async (t) => {
  const { importVault } = await import("../src/import-vault.js");
  const root = await mkdtemp(join(tmpdir(), "bastra-import-index-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const src = join(root, "src");
  const target = join(root, "vault");
  await mkdir(src, { recursive: true });
  await mkdir(target, { recursive: true });

  await writeFile(
    join(src, "index.md"),
    "---\ntype: reference\nname: Source Index Note\n---\n\nIrreplaceable source content.\n",
    "utf8",
  );
  await writeFile(join(src, "other.md"), "# Other\n\nOther body.\n", "utf8");
  await writeFile(
    join(src, "MEMORY.md"),
    "# Memory\n\n## Section A\n\n- [Index](index.md) the index note\n- [Other](other.md) another\n",
    "utf8",
  );

  const res = await importVault(target, src, { label: "demo" });
  assert.equal(new Set(res.ids).size, res.ids.length, `result.ids must not repeat: ${JSON.stringify(res.ids)}`);

  const vault = new Vault(target);
  await vault.init();
  t.after(async () => {
    await vault.stop?.();
  });
  const real = vault.get("demo-index");
  assert.ok(real, "the source note keeps its id");
  assert.equal(real.fm.title, "Source Index Note");
  assert.ok(real.body.includes("Irreplaceable"), "source content must survive");
  assert.notEqual(res.indexNode, "demo-index", "the synthetic index needs its own id");
});

test("A10: a legacy collision family is left as a visible duplicate, not auto-migrated", async (t) => {
  // Weg A (conservative): a pre-A10 collision family — `demo-same`,
  // `demo-same-2`, `demo-same-3` for three colliding `same.md` — carries no
  // provenance saying which legacy id belonged to which source path. Mapping
  // them back is a guess, and a wrong guess trashes live content, so the
  // family is NOT auto-migrated. The legacy nodes remain as visible,
  // recoverable duplicates; the ambiguous cleanup belongs to a manifest-backed
  // `bastra migrate`, not to an automatic pass that must never lose data.
  const { importVault, IMPORT_ROOT } = await import("../src/import-vault.js");
  const root = await mkdtemp(join(tmpdir(), "bastra-import-suffix-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const src = join(root, "src");
  const target = join(root, "vault");
  for (const d of ["a", "b", "c"]) await mkdir(join(src, d), { recursive: true });
  const folder = join(target, IMPORT_ROOT, "demo");
  await mkdir(folder, { recursive: true });
  for (const d of ["a", "b", "c"]) {
    await writeFile(join(src, d, "same.md"), `# Same ${d}\n\nBody ${d}.\n`, "utf8");
  }
  const legacy = (id: string) =>
    `---\nid: ${id}\ntitle: ${id}\ntype: reference\nsummary: legacy\ntopic_path: [imported, demo]\ntags: [imported]\nscope: demo\nrecall_when: ["x"]\ncreated: 2026-06-01\nupdated: 2026-06-01\n---\n\nlegacy\n`;
  for (const id of ["demo-same", "demo-same-2", "demo-same-3"]) {
    await writeFile(join(folder, `${id}.md`), legacy(id), "utf8");
  }

  const res = await importVault(target, src, { label: "demo" });
  const vault = new Vault(target);
  await vault.init();
  const active = vault.list().map((m) => m.fm.id).sort();
  await vault.stop?.();

  assert.deepEqual(res.migrated, [], "a collision family must not be auto-migrated");
  // The three new nodes plus the three untouched legacy nodes — nothing lost.
  assert.deepEqual(active, [
    "demo-a-same",
    "demo-b-same",
    "demo-c-same",
    "demo-same",
    "demo-same-2",
    "demo-same-3",
  ]);
});

test("A10: link lookup is slug-equivalent to id minting", async (t) => {
  const { importVault } = await import("../src/import-vault.js");
  for (const [file, link] of [["Two.md", "two"], ["gate_catalog.md", "gate_catalog"]]) {
    const root = await mkdtemp(join(tmpdir(), "bastra-import-slugkey-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const src = join(root, "src");
    const target = join(root, "vault");
    await mkdir(join(src, "a"), { recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(join(src, "a", file), `# Target\n\nTarget body.\n`, "utf8");
    await writeFile(join(src, "a", "one.md"), `# One\n\nLinks to [[${link}]].\n`, "utf8");

    await importVault(target, src, { label: "demo" });
    const vault = new Vault(target);
    await vault.init();
    const ids = new Set(vault.list().map((m) => m.fm.id));
    const one = vault.list().find((m) => m.fm.title.includes("One"));
    const links = [...(one?.body ?? "").matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]);
    await vault.stop?.();

    assert.ok(links.length > 0, `${file}: the link must survive`);
    for (const target2 of links) {
      assert.ok(ids.has(target2), `${file}: [[${target2}]] must exist, have ${JSON.stringify([...ids])}`);
    }
  }
});


test("A10: an empty/skipped source does NOT trash its legacy node", async (t) => {
  // Re-audit P1: the legacy node was trashed on mere existence, so an empty
  // source (imported: 0) left no active node at all — pure data loss.
  const { importVault, IMPORT_ROOT } = await import("../src/import-vault.js");
  const root = await mkdtemp(join(tmpdir(), "bastra-import-empty-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const src = join(root, "src");
  const target = join(root, "vault");
  await mkdir(join(src, "a"), { recursive: true });
  const folder = join(target, IMPORT_ROOT, "demo");
  await mkdir(folder, { recursive: true });
  await writeFile(join(src, "a", "empty.md"), "", "utf8");
  await writeFile(
    join(folder, "demo-empty.md"),
    `---\nid: demo-empty\ntitle: Empty\ntype: reference\nsummary: the valid legacy node\ntopic_path: [imported, demo]\ntags: [imported]\nscope: demo\nrecall_when: ["x"]\ncreated: 2026-06-01\nupdated: 2026-06-01\n---\n\nlegacy body\n`,
    "utf8",
  );

  const res = await importVault(target, src, { label: "demo" });
  assert.equal(res.imported, 0, "the empty source imports nothing");
  assert.deepEqual(res.migrated, [], "nothing may be retired without a written successor");

  const vault = new Vault(target);
  await vault.init();
  t.after(async () => {
    await vault.stop?.();
  });
  assert.ok(vault.get("demo-empty"), "the valid legacy node must survive an import that produced no successor");
});

test("A10 (Weg C): an orphaned node of a removed source stays active (F1 regression)", async (t) => {
  // Adversary finding F1: import `notes.md` (ALPHA) + `sub/notes.md` (BETA),
  // then remove `notes.md` and reimport. `demo-notes` holds the removed file's
  // ALPHA content; its basename-twin `demo-sub-notes` holds BETA. Every
  // automatic rule that trashed `demo-notes` here lost ALPHA. Weg C trashes
  // nothing, so the orphan simply stays active — kept as a regression anchor.
  const { importVault } = await import("../src/import-vault.js");
  const root = await mkdtemp(join(tmpdir(), "bastra-import-orphan-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const src = join(root, "src");
  const target = join(root, "vault");
  await mkdir(join(src, "sub"), { recursive: true });

  await writeFile(join(src, "notes.md"), "# Notes\n\nALPHA unique content.\n", "utf8");
  await writeFile(join(src, "sub", "notes.md"), "# Notes\n\nBETA unique content.\n", "utf8");
  await importVault(target, src, { label: "demo" });

  // Remove the root file; reimport with only the nested one.
  await rm(join(src, "notes.md"));
  const res = await importVault(target, src, { label: "demo" });

  const vault = new Vault(target);
  await vault.init();
  t.after(async () => {
    await vault.stop?.();
  });
  assert.deepEqual(res.migrated, [], "an orphan with different content must not be migrated");
  const orphan = vault.get("demo-notes");
  assert.ok(orphan, "the orphaned node must survive");
  assert.ok(orphan.body.includes("ALPHA"), "its unique content must still be active, not only in trash");
});

test("A10 (Weg C): a genuinely failed save leaves everything untouched", async (t) => {
  // A real saveMemory failure — a non-empty directory occupies the successor's
  // write target so temp+rename cannot land. Weg C trashes nothing regardless,
  // so the pre-A10 twin is trivially safe; the test also asserts the import
  // reports the failure rather than swallowing it.
  //
  // #245 moved WHERE this is caught: a directory on the target path makes the
  // ownership read fail with EISDIR, and ownership is now fail-closed, so the
  // import refuses at the Pass-0 gate instead of trying the save and failing.
  // Both are correct outcomes and both are visible in skipped[] — the
  // assertion below accepts either cause, but keeps the guarantee that matters
  // sharp: nothing imported, nothing overwritten, the legacy node alive.
  const { importVault, IMPORT_ROOT } = await import("../src/import-vault.js");
  const root = await mkdtemp(join(tmpdir(), "bastra-import-savefail-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const src = join(root, "src");
  const target = join(root, "vault");
  await mkdir(join(src, "a"), { recursive: true });
  const folder = join(target, IMPORT_ROOT, "demo");
  await mkdir(folder, { recursive: true });
  await writeFile(join(src, "a", "note.md"), "# Note\n\nreal content.\n", "utf8");
  // Block the successor's write target with a non-empty directory.
  await mkdir(join(folder, "demo-a-note.md"), { recursive: true });
  await writeFile(join(folder, "demo-a-note.md", "blocker"), "x", "utf8");
  await writeFile(
    join(folder, "demo-note.md"),
    `---\nid: demo-note\ntitle: Note\ntype: reference\nsummary: legacy\ntopic_path: [imported, demo]\ntags: [imported]\nscope: demo\nrecall_when: ["x"]\ncreated: 2026-06-01\nupdated: 2026-06-01\n---\n\nlegacy body\n`,
    "utf8",
  );

  const res = await importVault(target, src, { label: "demo" });

  assert.equal(res.imported, 0, "the successor save must not land");
  assert.ok(
    res.skipped.some((s) => /save failed|ownership/.test(s.reason)),
    `expected a visible save failure or ownership refusal, got ${JSON.stringify(res.skipped)}`,
  );
  assert.deepEqual(res.migrated, [], "no successor written → nothing migrated");

  const vault = new Vault(target);
  await vault.init();
  t.after(async () => {
    await vault.stop?.();
  });
  assert.ok(vault.get("demo-note"), "the legacy node must survive a failed successor save");
});

test("P1-a: an id freed by a removed sibling is not stolen to overwrite a stranger", async (t) => {
  // Codex gegencheck of 5cf71bb: Weg C removed the TRASH path, but the routine
  // saveMemory(overwrite:true) is itself a silent-replace. `a/note.md` and
  // `a-note.md` both slugify to `demo-a-note`; on the first import the sorted
  // walk gives `demo-a-note` to `a/note.md` and `demo-a-note-2` to `a-note.md`.
  // Remove `a/note.md`, reimport: with a fresh batch allocator `a-note.md`
  // grabbed the freed `demo-a-note` and overwrote the OTHER note's content —
  // temp+rename, so it was gone, not even in trash.
  const { importVault } = await import("../src/import-vault.js");
  const root = await mkdtemp(join(tmpdir(), "bastra-import-steal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const src = join(root, "src");
  const target = join(root, "vault");
  await mkdir(join(src, "a"), { recursive: true });
  await mkdir(target, { recursive: true });

  // Distinct content on each side — path-slug collision, different memories.
  await writeFile(join(src, "a", "note.md"), "# Nested Beta\n\nNESTED-BETA unique body.\n", "utf8");
  await writeFile(join(src, "a-note.md"), "# Root Alpha\n\nROOT-ALPHA unique body.\n", "utf8");
  await importVault(target, src, { label: "demo" });

  // The file that owned `demo-a-note` is removed; only `a-note.md` remains.
  await rm(join(src, "a", "note.md"));
  await importVault(target, src, { label: "demo" });

  const vault = new Vault(target);
  await vault.init();
  t.after(async () => {
    await vault.stop?.();
  });
  const bodies = vault.list().map((m) => m.body).join("\n");
  assert.ok(bodies.includes("ROOT-ALPHA"), "the reimported file's own content must be present");
  assert.ok(
    bodies.includes("NESTED-BETA"),
    "the removed sibling's node must NOT be overwritten — its unique content must still be active",
  );
  assert.equal(
    existsSync(join(target, ".bastra", "trash", "demo-a-note.md")),
    false,
    "and it must not have been silently discarded to trash either",
  );
});

test("P1-b: the synthetic index never overwrites a foreign node on its fallback id", async (t) => {
  // Codex gegencheck of 5cf71bb: the synthetic index draws `uniqueId(label-index)`
  // from the batch allocator only. A pre-existing `demo-index-2` on disk (a
  // different memory) is invisible to that allocator, so the index landed its
  // `-2` fallback right on top of it — overwrite:true, unique content gone.
  const { importVault, IMPORT_ROOT } = await import("../src/import-vault.js");
  const root = await mkdtemp(join(tmpdir(), "bastra-import-idxsteal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const src = join(root, "src");
  const target = join(root, "vault");
  await mkdir(src, { recursive: true });
  const folder = join(target, IMPORT_ROOT, "demo");
  await mkdir(folder, { recursive: true });

  // A foreign node already sitting on the id the synthetic index will fall back to.
  await writeFile(
    join(folder, "demo-index-2.md"),
    `---\nid: demo-index-2\ntitle: Legacy Index Two\ntype: reference\nsummary: unique legacy\ntopic_path: [imported, demo]\ntags: [imported]\nscope: demo\nrecall_when: ["x"]\nsource: legacy-hand-authored\ncreated: 2026-06-01\nupdated: 2026-06-01\n---\n\nUNIQUE-LEGACY-INDEX-2 body.\n`,
    "utf8",
  );
  // A source whose index.md takes `demo-index`, plus a MEMORY.md that mints the
  // synthetic index — which then needs a fallback id and hits `demo-index-2`.
  await writeFile(
    join(src, "index.md"),
    "---\ntype: reference\nname: Source Index Note\n---\n\nSource index content.\n",
    "utf8",
  );
  await writeFile(join(src, "other.md"), "# Other\n\nOther body.\n", "utf8");
  await writeFile(
    join(src, "MEMORY.md"),
    "# Memory\n\n## Section A\n\n- [Index](index.md) the index note\n- [Other](other.md) another\n",
    "utf8",
  );

  const res = await importVault(target, src, { label: "demo" });

  const vault = new Vault(target);
  await vault.init();
  t.after(async () => {
    await vault.stop?.();
  });
  const legacy = vault.get("demo-index-2");
  assert.ok(
    legacy && legacy.body.includes("UNIQUE-LEGACY-INDEX-2"),
    "the synthetic index must not overwrite a foreign node sitting on its fallback id",
  );
  assert.notEqual(res.indexNode, "demo-index-2", "the synthetic index needs an id that is not foreign-owned");
});

// ─── B11: open_document tells the truth ─────────────────────────

test("B11: opening a document whose file is gone reports failure", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-open-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(
    join(dir, "doc.md"),
    `---
id: doc-x
title: Doc X
type: doc
summary: s
topic_path: [d]
tags: [d]
scope: d
recall_when: ["doc x"]
original_path: ${join(dir, "definitely-missing.pdf")}
created: 2026-05-01
updated: 2026-05-01
---

body
`,
    "utf8",
  );
  const vault = new Vault(dir);
  await vault.init();
  t.after(async () => {
    await vault.stop?.();
  });

  const res = await openDocument(vault, { id: "doc-x" });
  // Die Zusicherung gilt überall; die BEGRÜNDUNG ist plattformabhängig. Auf
  // macOS greift der Existenz-Check, anderswo steigt open_document schon davor
  // aus (documents-handler.ts:228) — der Test verlangte bisher überall die
  // macOS-Meldung und war auf den Linux-Runnern der CI dauerhaft rot.
  assert.equal(res.ok, false, "a missing file must not be reported as opened");
  assert.match(
    res.message ?? "",
    process.platform === "darwin" ? /no longer exists/ : /only supported on macOS/,
  );
});
