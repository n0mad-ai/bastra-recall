/**
 * #1532: golden master for `bastra --help` and every `bastra <command> --help`,
 * taken before cli/help-text.ts was split into command groups. It pins the exact
 * bytes the user sees and the set of commands with a section. Only the CLI
 * version is normalized, so a release bump does not churn the snapshot.
 *
 * Update (only for an intended help text change):
 *   node --import tsx --import ./scripts/test-env.mjs --test --test-update-snapshots \
 *     packages/daemon/__tests__/cli-help-golden.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { COMMAND_HELP, showHelp } from "../src/cli/help-text.js";
import { VERSION } from "../src/cli/helpers.js";

async function printed(command?: string | null): Promise<string> {
  const write = process.stdout.write;
  let text = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    text += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    await showHelp(command);
  } finally {
    process.stdout.write = write;
  }
  return text.split(`bastra ${VERSION} `).join("bastra <version> ");
}

test("#1532 golden master — commands with a help section", async (t) => {
  t.assert.snapshot(Object.keys(COMMAND_HELP));
});

test("#1532 golden master — bastra --help", async (t) => {
  t.assert.snapshot(await printed());
});

test("#1532 golden master — unknown command falls back to the listing", async (t) => {
  t.assert.snapshot((await printed("no-such-command")) === (await printed()));
  assert.equal(await printed(null), await printed());
});

for (const command of Object.keys(COMMAND_HELP).sort()) {
  test(`#1532 golden master — bastra ${command} --help`, async (t) => {
    t.assert.snapshot(await printed(command));
  });
}
