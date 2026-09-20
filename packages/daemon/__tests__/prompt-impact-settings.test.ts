/**
 * Tests for src/code-graph/prompt-impact-settings.ts — the #607 opt-in
 * resolution (env > file > default off).
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getPromptImpactEnabled, setPromptImpactEnabled, PROMPT_IMPACT_DEFAULT } from "../src/code-graph/prompt-impact-settings.js";
import { readSettings } from "../src/settings.js";

async function withTempFile<T>(fn: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "bastra-prompt-impact-settings-"));
  try {
    return await fn(join(dir, "cli-settings.json"));
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

test("default is off when neither env nor file has an opinion", async () => {
  assert.equal(PROMPT_IMPACT_DEFAULT, false);
  await withTempFile(async (path) => {
    assert.equal(await getPromptImpactEnabled(path, {}), false);
  });
});

test("setPromptImpactEnabled persists and getPromptImpactEnabled reads it back", async () => {
  await withTempFile(async (path) => {
    await setPromptImpactEnabled(true, path);
    assert.equal(await getPromptImpactEnabled(path, {}), true);
    assert.deepEqual((await readSettings(path)).promptImpact, { enabled: true });

    await setPromptImpactEnabled(false, path);
    assert.equal(await getPromptImpactEnabled(path, {}), false);
  });
});

test("BASTRA_PROMPT_IMPACT wins over the stored file in both directions", async () => {
  await withTempFile(async (path) => {
    await setPromptImpactEnabled(true, path);
    assert.equal(
      await getPromptImpactEnabled(path, { BASTRA_PROMPT_IMPACT: "off" }),
      false,
      "env off must override a stored true",
    );

    await setPromptImpactEnabled(false, path);
    assert.equal(
      await getPromptImpactEnabled(path, { BASTRA_PROMPT_IMPACT: "on" }),
      true,
      "env on must override a stored false (or an absent file)",
    );
  });
});

test("an unrecognized env value falls through to the file, not the default", async () => {
  await withTempFile(async (path) => {
    await setPromptImpactEnabled(true, path);
    assert.equal(
      await getPromptImpactEnabled(path, { BASTRA_PROMPT_IMPACT: "maybe" }),
      true,
      "a typo must not silently disable a stored opt-in",
    );
  });
});

test("BASTRA_PROMPT_IMPACT accepts the same on/off vocabulary as the sibling env flags", async () => {
  await withTempFile(async (path) => {
    for (const on of ["1", "true", "on", "yes", "ON", "Yes"]) {
      assert.equal(await getPromptImpactEnabled(path, { BASTRA_PROMPT_IMPACT: on }), true, on);
    }
    for (const off of ["0", "false", "off", "no", "OFF"]) {
      assert.equal(await getPromptImpactEnabled(path, { BASTRA_PROMPT_IMPACT: off }), false, off);
    }
  });
});
