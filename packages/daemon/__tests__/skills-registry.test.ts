/**
 * Tests für die Skills-Registry (#215): declare-once Identitäten für Link-
 * Ziele auf anderen Surfaces — Registry-CRUD, id-Validierung, und die
 * buildGraph-Integration (skill statt ghost, standalone-Emission, Vault-
 * Memory gewinnt über Registry-Eintrag).
 *
 * Runner: `tsx --test __tests__/skills-registry.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, buildGraph } from "@bastra-recall/core";
import { addSkill, listSkills, removeSkill, MAX_SKILLS } from "../src/skills-registry.js";

async function tmpRegistry(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "skills-"));
  return join(dir, "skills.json");
}

function memoryMarkdown(id: string, related: string[] = []): string {
  const rel = related.map((r) => `  - ${r}`).join("\n");
  return [
    "---",
    `id: ${id}`,
    `title: Title of ${id}`,
    "type: reference",
    `summary: Summary of ${id}`,
    "topic_path:\n  - test",
    "tags:\n  - test",
    "scope: skills-test",
    `recall_when:\n  - ${id}`,
    ...(related.length ? ["related:", rel] : []),
    "created: 2026-07-17",
    "updated: 2026-07-17",
    "---",
    "",
    `Body of ${id}.`,
  ].join("\n");
}

test("registry: add/list/remove roundtrip, upsert by id, missing file = empty", async () => {
  const path = await tmpRegistry();
  try {
    assert.deepEqual(await listSkills(path), []);
    await addSkill({ id: "uncertainty-check", label: "Uncertainty check" }, path);
    await addSkill({ id: "rebalance" }, path);
    await addSkill({ id: "uncertainty-check", note: "updated" }, path); // upsert
    const entries = await listSkills(path);
    assert.equal(entries.length, 2);
    const uc = entries.find((e) => e.id === "uncertainty-check");
    assert.equal(uc?.label, undefined); // upsert replaced the entry wholesale
    assert.equal(uc?.note, "updated");
    assert.equal(await removeSkill("rebalance", path), true);
    assert.equal(await removeSkill("rebalance", path), false);
    assert.equal((await listSkills(path)).length, 1);
  } finally {
    await rm(join(path, ".."), { recursive: true, force: true });
  }
});

test("registry: rejects non-slug ids and enforces the cap", async () => {
  const path = await tmpRegistry();
  try {
    await assert.rejects(addSkill({ id: "Not A Slug" }, path), /invalid skill id/);
    await assert.rejects(addSkill({ id: "../escape" }, path), /invalid skill id/);
    for (let i = 0; i < MAX_SKILLS; i++) await addSkill({ id: `skill-${i}` }, path);
    await assert.rejects(addSkill({ id: "one-too-many" }, path), /cap reached/);
    await addSkill({ id: "skill-0", label: "update ok" }, path); // upsert past cap is fine
  } finally {
    await rm(join(path, ".."), { recursive: true, force: true });
  }
});

test("buildGraph: registered id becomes a skill node in the skills ring, not a ghost", async () => {
  const vaultDir = await mkdtemp(join(tmpdir(), "skills-vault-"));
  try {
    const memDir = join(vaultDir, "memories", "projects", "skills-test");
    await mkdir(memDir, { recursive: true });
    await writeFile(join(memDir, "linker.md"), memoryMarkdown("linker", ["uncertainty-check", "truly-unwritten"]));
    const vault = new Vault(vaultDir);
    await vault.init();

    // without the registry: both targets are ghosts
    const plain = buildGraph(vault);
    assert.equal(plain.nodes.filter((n) => n.kind === "ghost").length, 2);

    const g = buildGraph(vault, [
      { id: "uncertainty-check", label: "Uncertainty check", note: "lives in ~/.claude/skills" },
    ]);
    const skill = g.nodes.find((n) => n.id === "uncertainty-check");
    assert.equal(skill?.kind, "skill");
    assert.equal(skill?.cluster, "skills");
    assert.equal(skill?.group, "skills");
    assert.equal(skill?.title, "Uncertainty check");
    assert.equal(skill?.summary, "lives in ~/.claude/skills");
    assert.deepEqual(skill?.linked_by, ["linker"]);
    assert.ok(skill && skill.degree > 0); // the related edge still counts
    // the other target stays an ordinary ghost; the skills cluster is listed
    assert.equal(g.nodes.find((n) => n.id === "truly-unwritten")?.kind, "ghost");
    assert.ok(g.clusters.some((c) => c.key === "skills"));
    assert.ok(g.groups.some((c) => c.key === "skills"));
  } finally {
    await rm(vaultDir, { recursive: true, force: true });
  }
});

test("buildGraph: a skill stays on the map with zero live links (the disappearance fix)", async () => {
  const vaultDir = await mkdtemp(join(tmpdir(), "skills-vault-"));
  try {
    const memDir = join(vaultDir, "memories", "projects", "skills-test");
    await mkdir(memDir, { recursive: true });
    await writeFile(join(memDir, "solo.md"), memoryMarkdown("solo"));
    const vault = new Vault(vaultDir);
    await vault.init();
    const g = buildGraph(vault, [{ id: "orphan-skill" }]);
    const skill = g.nodes.find((n) => n.id === "orphan-skill");
    assert.equal(skill?.kind, "skill");
    assert.equal(skill?.title, "orphan-skill"); // no label → id
    assert.equal(skill?.degree, 0);
    assert.deepEqual(skill?.linked_by, []);
  } finally {
    await rm(vaultDir, { recursive: true, force: true });
  }
});

test("buildGraph: a vault memory with the same id wins over the registry entry", async () => {
  const vaultDir = await mkdtemp(join(tmpdir(), "skills-vault-"));
  try {
    const memDir = join(vaultDir, "memories", "projects", "skills-test");
    await mkdir(memDir, { recursive: true });
    await writeFile(join(memDir, "real-note.md"), memoryMarkdown("real-note"));
    const vault = new Vault(vaultDir);
    await vault.init();
    const g = buildGraph(vault, [{ id: "real-note", label: "should be ignored" }]);
    const node = g.nodes.find((n) => n.id === "real-note");
    assert.equal(node?.kind, "memory"); // the file is the truth
    assert.equal(node?.title, "Title of real-note");
    assert.equal(g.nodes.filter((n) => n.id === "real-note").length, 1); // no duplicate
  } finally {
    await rm(vaultDir, { recursive: true, force: true });
  }
});
