/**
 * #1518: the backend (ranking, boot, bridge, scheduled jobs) does not import
 * from the CLI implementation in `src/cli/`; the CLI builds on the backend.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const BACKEND = ["recall-handler.ts", "boot-storage.ts", "boot-recall-options.ts", "bridge.ts", "daemon-jobs.ts"];

test("#1518 backend modules import nothing from src/cli/", () => {
  for (const file of BACKEND) {
    const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
    const fromCli = [...source.matchAll(/\bfrom\s+["']\.\/cli\/[^"']+["']/g)].map(([found]) => found);
    assert.deepEqual(fromCli, [], file);
  }
});
