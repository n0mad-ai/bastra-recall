/**
 * #455 — one canonical instruction source. The Cursor rule and the
 * Codex/ChatGPT plugin skill are GENERATED from packages/skill/SKILL.md; this
 * test fails when a projection is stale or was edited by hand.
 *
 * Run: npx tsx --test packages/daemon/__tests__/skill-projections.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const gen = await import(resolve(REPO, "scripts", "build-skill-projections.mjs"));

const canonical = await readFile(join(REPO, "packages", "skill", "SKILL.md"), "utf8");
const canonicalBody = gen.splitFrontmatter(canonical).body.trimEnd();

test("#455: the committed Cursor rule is exactly the generator's output", async () => {
  const committed = await readFile(gen.PROJECTIONS.cursor, "utf8");
  assert.equal(committed, gen.renderCursorRule(canonical), "cursor-rules.mdc is stale or hand-edited — run `npm run skill:build`");
});

test("#455: the committed plugin skill is exactly the generator's output", async () => {
  const committed = await readFile(join(gen.PROJECTIONS.pluginSkillDir, "SKILL.md"), "utf8");
  assert.equal(committed, gen.renderPluginSkill(canonical), "plugin SKILL.md is stale or hand-edited — run `npm run skill:build`");
});

test("#455: every projection carries the canonical body verbatim and the canonical hash", async () => {
  const hash = gen.canonicalHash(canonical);
  for (const file of [gen.PROJECTIONS.cursor, join(gen.PROJECTIONS.pluginSkillDir, "SKILL.md")]) {
    const text = await readFile(file, "utf8");
    assert.ok(text.includes(canonicalBody), `${file} does not contain the canonical body`);
    assert.ok(text.includes(`canonical ${hash}`), `${file} does not carry the canonical hash`);
    assert.ok(text.includes("GENERATED"), `${file} is not marked as generated`);
  }
});

test("#455: the projections keep only client metadata in their frontmatter — no second policy", async () => {
  const cursor = gen.splitFrontmatter(await readFile(gen.PROJECTIONS.cursor, "utf8"));
  assert.match(cursor.frontmatter, /alwaysApply: true/);
  // The drift #455 named: fixed score guidance and a separate "recall first"
  // policy authored only for Cursor. Neither may come back.
  assert.doesNotMatch(cursor.body.replace(canonicalBody, ""), /~100\+|Below\s+~30 is noise/);
  const plugin = gen.splitFrontmatter(await readFile(join(gen.PROJECTIONS.pluginSkillDir, "SKILL.md"), "utf8"));
  assert.match(plugin.frontmatter, /^name: bastra-recall$/m);
  assert.equal(plugin.body.replace(canonicalBody, "").replace(/<!--[^>]*-->/g, "").trim(), "");
});

test("#455: the plugin skill dir carries every reference file the body points at, and the OpenAI metadata", async () => {
  for (const name of gen.REFERENCE_FILES) {
    assert.ok(existsSync(join(gen.PROJECTIONS.pluginSkillDir, name)), `${name} missing next to the plugin SKILL.md`);
    const [a, b] = await Promise.all([
      readFile(join(REPO, "packages", "skill", name), "utf8"),
      readFile(join(gen.PROJECTIONS.pluginSkillDir, name), "utf8"),
    ]);
    assert.equal(a, b, `${name} in the plugin differs from the canonical copy`);
  }
  const [a, b] = await Promise.all([
    readFile(join(REPO, "packages", "skill", "agents", "openai.yaml"), "utf8"),
    readFile(join(gen.PROJECTIONS.pluginSkillDir, "agents", "openai.yaml"), "utf8"),
  ]);
  assert.equal(a, b);
});

test("#763: the frustration trigger text names a repetition phrase, never the bare word for \"again\"", async () => {
  const { MEMORY_TOOL_DEFS } = await import("../src/tool-defs-memory.js");
  const save = MEMORY_TOOL_DEFS.find((t) => t.name === "save_memory");
  assert.ok(save, "save_memory tool def");
  const bare = /["']again["'],\s*["']wieder["']/;
  for (const [what, text] of [
    ["SKILL.md", canonical],
    ["save_memory description", save.description],
    ["docs/triggers.md", await readFile(join(REPO, "docs", "triggers.md"), "utf8")],
  ] as const) {
    assert.doesNotMatch(text, bare, `${what} lists the bare adverb as a frustration signal`);
    assert.match(text, /schon wieder/, `${what} names the repetition phrase`);
  }
});
