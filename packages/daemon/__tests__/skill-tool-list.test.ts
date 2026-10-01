/**
 * The SKILL.md "Tools:" list is what a client reads to learn which tools it
 * has. Compare the list and each minimum surface with the registry, so a new
 * registered tool cannot silently disappear from the skill description.
 *
 * Run: npx tsx --test packages/daemon/__tests__/skill-tool-list.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ALL_TOOL_DEFS, toolNamesForSurface } from "../src/tool-defs.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

async function toolsBySurface(): Promise<{ search: string[]; write: string[]; full: string[] }> {
  const body = await readFile(join(REPO, "packages/skill/SKILL.md"), "utf8");
  const frontmatter = body.split(/^---$/m)[1] ?? "";
  const match = frontmatter.match(/Tools: search=([^;]+); write=([^;]+); full=([^\n.]+)/);
  assert.ok(match, "SKILL.md frontmatter has no tiered Tools: list");
  const names = (group: string) => group.split(",").map((name) => name.trim());
  return { search: names(match[1]), write: names(match[2]), full: names(match[3]) };
}

test("the SKILL.md tool list follows every registered tool and its minimum surface", async () => {
  const listed = await toolsBySurface();
  const search = toolNamesForSurface("search") ?? [];
  const write = toolNamesForSurface("write") ?? [];
  const registered = ALL_TOOL_DEFS.map((tool) => tool.name);
  const sorted = (names: readonly string[]) => [...names].sort();
  assert.deepEqual(sorted(listed.search), sorted(search));
  assert.deepEqual(sorted(listed.write), sorted(write.filter((name) => !search.includes(name))));
  assert.deepEqual(sorted(listed.full), sorted(registered.filter((name) => !write.includes(name))));
  assert.equal(new Set([...listed.search, ...listed.write, ...listed.full]).size, registered.length);
});
