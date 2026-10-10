import { maybeEmitModelHint } from "../../src/cli/update-hint.js";

const shown = await maybeEmitModelHint({
  settingsPath: process.argv[2],
  shownPath: process.argv[3],
  ramGB: 16,
  recommendation: {
    id: "hint-worker-fixture",
    models: { baseline: { model: "fixture-new:4b", sizeGB: 1, improves: "Invented fixture improvement." } },
  },
});
process.exitCode = shown ? 10 : 0;
