/**
 * One of two overlapping `bastra models switch` processes (see
 * model-decision-binding.test.ts). Role A finishes its switch, then waits at a
 * gate while role B runs start to finish; whatever A still wrote after the gate
 * would land on top of B's state.
 *
 * argv: settingsPath ollamaUrl role gatePath
 */
import { access, writeFile } from "node:fs/promises";

const [settingsPath, ollamaUrl, role, gate] = process.argv.slice(2);
process.env.BASTRA_OLLAMA_URL = ollamaUrl;
const { cmdModels } = await import("../../src/cli/models-cmd.js");
const { enableGenerationModel } = await import("../../src/cli/ollama.js");

const model = `fixture-${role}:4b`;
const id = `rec-${role}`;
const entry = { model, sizeGB: 1, improves: "Fixture only." };
const recommendation = { id, models: { baseline: entry, enhanced: entry, high: entry } };

process.exitCode = await cmdModels({
  sub: "switch",
  positional: ["models", "switch", id, model],
  settingsPath,
  deps: {
    recommendation,
    ramGB: 16,
    enable: async (m, o, p) => {
      const r = await enableGenerationModel(m, o, p, {
        find: () => "/fake/bin/ollama",
        pull: () => { throw new Error("no pull in this fixture"); },
      });
      if (role === "A") {
        await writeFile(`${gate}.ready`, "ready");
        for (let n = 0; ; n++) {
          if (n > 500) throw new Error("gate timeout");
          if (await access(gate).then(() => true, () => false)) break;
          await new Promise((res) => setTimeout(res, 20));
        }
      }
      return r;
    },
  },
});
