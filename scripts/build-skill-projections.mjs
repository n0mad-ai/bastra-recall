#!/usr/bin/env node
/**
 * One canonical instruction source, projected to every client (#455).
 *
 * `packages/skill/SKILL.md` is the ONLY hand-authored source of stable Bastra
 * Recall behaviour: it owns the triggers (when to recall, when to save); the
 * gated reference files next to it own the rarely needed modules; the MCP tool
 * descriptions own call mechanics; hooks inject runtime state. Two client
 * copies used to be authored by hand and had already drifted from it — the
 * Cursor rule carried fixed score guidance and a long "recall first" policy of
 * its own, the Codex/ChatGPT plugin a separate shortened one — so a policy
 * change (#454) could land on Claude and leave Cursor with the opposite rule.
 * That is exactly the "skill ≠ rules drift" #7 warned about.
 *
 * DECISION: generated projections, not thin wrappers. A wrapper would have to
 * point at a file the client cannot read: Cursor rules are self-contained
 * `.mdc` files in the project, and a Codex plugin ships its own SKILL.md. So
 * each projection is the canonical BODY verbatim, under client-specific
 * frontmatter (metadata only — display name, `alwaysApply`, install note), with
 * a generated header carrying the canonical hash. Behavioural prose is never
 * written twice; what differs per client is the envelope.
 *
 * Runs on every daemon build (prepare-package-assets) and via
 * `npm run skill:build`. `skill-projections.test.ts` fails when a projection
 * is stale or edited by hand; #456 extends that to the packaged assets, CI and
 * doctor.
 */
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CANONICAL_DIR = resolve(REPO_ROOT, "packages", "skill");
export const REFERENCE_FILES = ["topology.md", "taxonomy.md", "intake.md", "commons.md"];
export const PROJECTIONS = {
  cursor: resolve(CANONICAL_DIR, "cursor-rules.mdc"),
  pluginSkillDir: resolve(REPO_ROOT, "plugins", "bastra-recall", "skills", "bastra-recall"),
};

/** Split `---\n…\n---\n` frontmatter from the body. */
export function splitFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) throw new Error("canonical SKILL.md has no frontmatter");
  return { frontmatter: m[1], body: text.slice(m[0].length) };
}

export function canonicalHash(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

const header = (hash) =>
  `<!-- GENERATED from packages/skill/SKILL.md (canonical ${hash}) by scripts/build-skill-projections.mjs — do not edit; edit the canonical file and run \`npm run skill:build\` -->\n`;

/**
 * Cursor project rule: `.cursor/rules/bastra-recall.mdc`. Cursor reads only
 * this one file, so the reference files are named as shipped-elsewhere.
 */
export function renderCursorRule(canonical) {
  const { body } = splitFrontmatter(canonical);
  const hash = canonicalHash(canonical);
  return (
    `---\n` +
    `description: Persistent memory across sessions via the bastra-recall MCP server — recall before acting, save durable rules and hard-won fixes.\n` +
    `alwaysApply: true\n` +
    `---\n` +
    header(hash) +
    body.trimEnd() +
    `\n\n---\n\n` +
    `**Cursor note (generated):** the reference files named above (\`topology.md\`, \`taxonomy.md\`, \`intake.md\`, \`commons.md\`) are not part of this rule file. ` +
    `They ship in the \`bastra-recall\` npm package under \`skill/\`; read them there when a signal above points at one.\n`
  );
}

/**
 * Codex / ChatGPT plugin skill. Same body, plugin frontmatter (name + a short
 * description carrying the install pointer — metadata, not policy). The
 * reference files are copied next to it so every pointer in the body resolves.
 */
export function renderPluginSkill(canonical) {
  const { body } = splitFrontmatter(canonical);
  const hash = canonicalHash(canonical);
  return (
    `---\n` +
    `name: bastra-recall\n` +
    `description: Proactive private local memory for ChatGPT and Codex — recall before acting, save durable rules, lessons and decisions without being asked. Requires the local bastra-recall MCP server installed by \`bastra install codex\`.\n` +
    `---\n` +
    header(hash) +
    body.trimEnd() +
    `\n`
  );
}

export async function buildSkillProjections({ write = true } = {}) {
  const canonical = await readFile(resolve(CANONICAL_DIR, "SKILL.md"), "utf8");
  const out = {
    cursor: renderCursorRule(canonical),
    pluginSkill: renderPluginSkill(canonical),
  };
  if (write) {
    await writeFile(PROJECTIONS.cursor, out.cursor, "utf8");
    await mkdir(resolve(PROJECTIONS.pluginSkillDir, "agents"), { recursive: true });
    await writeFile(resolve(PROJECTIONS.pluginSkillDir, "SKILL.md"), out.pluginSkill, "utf8");
    for (const name of REFERENCE_FILES) {
      await copyFile(resolve(CANONICAL_DIR, name), resolve(PROJECTIONS.pluginSkillDir, name));
    }
    await copyFile(
      resolve(CANONICAL_DIR, "agents", "openai.yaml"),
      resolve(PROJECTIONS.pluginSkillDir, "agents", "openai.yaml"),
    );
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildSkillProjections();
  console.error("[skill:build] projections written: cursor-rules.mdc, plugins/bastra-recall/skills/bastra-recall/");
}
