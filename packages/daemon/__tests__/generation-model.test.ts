/**
 * Tests for the hardware→model recommendation (cli/hardware.ts) and the
 * generation-model resolver precedence (settings.ts).
 *
 * Runner: node --import tsx --test packages/daemon/__tests__/generation-model.test.ts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recommendTextModel } from "../src/cli/hardware.js";
import {
  resolveGenerationModel,
  setGenerationModel,
  GENERATION_MODEL_DEFAULT,
} from "../src/settings.js";

test("recommendTextModel: RAM tiers map to the right model", () => {
  // Below the 16 GB baseline → no generation model.
  assert.equal(recommendTextModel(8).model, null);
  assert.equal(recommendTextModel(8).tier, "keyword-only");
  // Baseline → tev1:4b, the small model new installs are offered.
  assert.equal(recommendTextModel(16).model, "tev1:4b");
  assert.equal(recommendTextModel(16).sizeGB, 4.5);
  assert.equal(recommendTextModel(16).tier, "baseline");
  assert.equal(recommendTextModel(16).alt, undefined);
  // …and the note claims nothing that was not measured.
  assert.match(recommendTextModel(16).note, /follows from its size \(4\.5 GB\); it was not measured on a 16 GB machine/);
  // 24 GB → tev1:4b, 12B offered as opt-in alternative.
  assert.equal(recommendTextModel(24).model, "tev1:4b");
  assert.equal(recommendTextModel(24).tier, "enhanced");
  assert.equal(recommendTextModel(24).alt?.model, "gemma4:12b");
  assert.equal(recommendTextModel(31).model, "tev1:4b");
  // 32 GB+ → 12B default.
  assert.equal(recommendTextModel(32).model, "gemma4:12b");
  assert.equal(recommendTextModel(64).model, "gemma4:12b");
});

test("resolveGenerationModel: env > cli-settings > default", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bastra-genmodel-"));
  const path = join(dir, "cli-settings.json");
  const savedExpand = process.env.BASTRA_EXPAND_MODEL;
  const savedRerank = process.env.BASTRA_RERANK_MODEL;
  delete process.env.BASTRA_EXPAND_MODEL;
  delete process.env.BASTRA_RERANK_MODEL;
  try {
    // 3. nothing set → the runtime default. NOT the model new installs are
    // offered (tev1:4b): an existing install without a stored choice must keep
    // running the model it has pulled.
    assert.equal(await resolveGenerationModel(path), GENERATION_MODEL_DEFAULT);
    assert.equal(GENERATION_MODEL_DEFAULT, "gemma3:4b");
    assert.notEqual(GENERATION_MODEL_DEFAULT, recommendTextModel(16).model);

    // 2. cli-settings wins over the default.
    await setGenerationModel("gemma4:12b", path);
    assert.equal(await resolveGenerationModel(path), "gemma4:12b");

    // 1. env wins over cli-settings.
    process.env.BASTRA_EXPAND_MODEL = "custom-model:x";
    assert.equal(await resolveGenerationModel(path), "custom-model:x");

    // BASTRA_RERANK_MODEL is the secondary env source.
    delete process.env.BASTRA_EXPAND_MODEL;
    process.env.BASTRA_RERANK_MODEL = "rerank-model:y";
    assert.equal(await resolveGenerationModel(path), "rerank-model:y");
  } finally {
    if (savedExpand === undefined) delete process.env.BASTRA_EXPAND_MODEL;
    else process.env.BASTRA_EXPAND_MODEL = savedExpand;
    if (savedRerank === undefined) delete process.env.BASTRA_RERANK_MODEL;
    else process.env.BASTRA_RERANK_MODEL = savedRerank;
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
