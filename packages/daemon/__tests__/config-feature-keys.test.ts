/**
 * #634 — reflex memories and the change-impact block are switched with
 * `bastra config set`, like every other feature in doctor's features block.
 * Before, the only way was hand-editing ~/.bastra/cli-settings.json, and the
 * doctor hint said exactly that.
 *
 * Runs against a temp HOME: the developer's own settings are never touched.
 *
 * Runner: node --import tsx --import ./scripts/test-env.mjs --test packages/daemon/__tests__/config-feature-keys.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cmdConfig } from "../src/cli/config-cmd.js";
import { parseArgs } from "../src/cli/commands.js";

async function withHome(t: test.TestContext): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "bastra-config-keys-"));
  const saved = { HOME: process.env.HOME, REFLEX: process.env.BASTRA_REFLEX, PI: process.env.BASTRA_PROMPT_IMPACT };
  process.env.HOME = home;
  delete process.env.BASTRA_REFLEX;
  delete process.env.BASTRA_PROMPT_IMPACT;
  t.after(async () => {
    process.env.HOME = saved.HOME;
    if (saved.REFLEX !== undefined) process.env.BASTRA_REFLEX = saved.REFLEX;
    if (saved.PI !== undefined) process.env.BASTRA_PROMPT_IMPACT = saved.PI;
    await rm(home, { recursive: true, force: true });
  });
  return home;
}

const run = (...argv: string[]) => cmdConfig(parseArgs(["config", ...argv]));
const stored = async (home: string) => JSON.parse(await readFile(join(home, ".bastra", "cli-settings.json"), "utf8"));

test("reflex.enabled: set off/true lands in the file and keeps maxPerTurn", async (t) => {
  // Revert-check: drop "reflex.enabled" from KNOWN_KEYS → exit 2.
  const home = await withHome(t);
  await mkdir(join(home, ".bastra"), { recursive: true });
  await writeFile(join(home, ".bastra", "cli-settings.json"), JSON.stringify({ reflex: { maxPerTurn: 3 } }));
  assert.equal(await run("set", "reflex.enabled", "off"), 0);
  assert.deepEqual((await stored(home)).reflex, { maxPerTurn: 3, enabled: false });
  assert.equal(await run("set", "reflex.enabled", "true"), 0);
  assert.deepEqual((await stored(home)).reflex, { maxPerTurn: 3, enabled: true });
  assert.equal(await run("get", "reflex.enabled"), 0);
});

test("promptImpact.enabled: set on lands in the file", async (t) => {
  const home = await withHome(t);
  assert.equal(await run("set", "promptImpact.enabled", "on"), 0);
  assert.deepEqual((await stored(home)).promptImpact, { enabled: true });
  assert.equal(await run("get", "promptImpact.enabled"), 0);
});

test("invalid values are rejected with exit 2 and nothing is written", async (t) => {
  const home = await withHome(t);
  assert.equal(await run("set", "reflex.enabled", "maybe"), 2);
  assert.equal(await run("set", "promptImpact.enabled"), 2);
  await assert.rejects(readFile(join(home, ".bastra", "cli-settings.json"), "utf8"));
});
