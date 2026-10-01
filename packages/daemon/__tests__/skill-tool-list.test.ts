/**
 * The SKILL.md "Tools:" list is what a client reads to learn which tools it
 * has, so a registered tool missing from it is a tool the skill never reaches
 * for. find_code (search tier) and archive_memory (full profile) were
 * registered but absent from the list. PRIVACY.md had the opposite problem: it
 * told users to edit the Markdown files directly, which SKILL.md itself calls
 * unreconstructable (no audit log, updated stamp, id lock or index refresh).
 *
 * Run: npx tsx --test packages/daemon/__tests__/skill-tool-list.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ALL_TOOL_DEFS } from "../src/tool-defs.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

async function toolsLine(path: string): Promise<string> {
  const body = await readFile(join(REPO, path), "utf8");
  const frontmatter = body.split(/^---$/m)[1] ?? "";
  const match = frontmatter.match(/Tools: ([^\n]+)/);
  assert.ok(match, `${path} frontmatter has no "Tools:" list`);
  return match[1];
}

test("the SKILL.md tool list names find_code and archive_memory", async () => {
  const registered = new Set(ALL_TOOL_DEFS.map((t) => t.name));
  const line = await toolsLine("packages/skill/SKILL.md");
  for (const name of ["find_code", "archive_memory"]) {
    assert.ok(registered.has(name), `${name} is no longer a registered tool`);
    assert.ok(line.includes(name), `SKILL.md Tools: list does not name ${name}`);
  }
});

test("PRIVACY.md sends memory edits through the tools, not the files", async () => {
  const body = await readFile(join(REPO, "docs", "PRIVACY.md"), "utf8");
  assert.doesNotMatch(body, /Inspect and edit the Markdown files directly/);
  assert.doesNotMatch(body, /Prüfe und bearbeite Markdown-Dateien direkt/);
  assert.match(body, /edit_memory/);
});
