import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isOurStatusline, patchClaudeCodeStatusline } from "../src/cli/adapters/claude-code.js";

const feed = {
  type: "command",
  command: "/opt/homebrew/Cellar/node@24/24.16.0/bin/node /Users/n0mad/Projekte/bastra-recall/packages/statusline/dist/claude-panel-feed.mjs",
  refreshInterval: 1,
};

test("#1327: only the marker and complete supported commands grant ownership", () => {
  assert.equal(isOurStatusline(feed), false);
  for (const command of [
    "node /pkg/statusline/dist/index.mjs --style=powerline",
    '"/Program Files/node.exe" "C:/pkg/statusline/dist/index.mjs" --style=powerline',
    "/pkg/stub/bastra-hook statusline --style=powerline",
  ]) assert.equal(isOurStatusline({ command }), true, command);
  for (const command of [
    "echo bastra-statusline", "bastra-hook statusline-foreign", "bastra-hook statusline ; echo foreign",
    "node /pkg/statusline/dist/index.mjs.foreign", "node /pkg/statusline/dist/index.mjs && echo foreign",
  ]) assert.equal(isOurStatusline({ command }), false, command);
  assert.equal(isOurStatusline({ ...feed, __bastraRecall: true }), true);
  assert.equal(isOurStatusline({ ...feed, __nexusRecall: true }), false);
});

for (const stubPresent of [true, false]) {
  test(`#1327: install (stub=${stubPresent}) and uninstall preserve the exact Ember block`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "bastra-statusline-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const settingsPath = join(dir, "settings.json");
    const before = JSON.stringify({ statusLine: feed, foreign: true });
    await writeFile(settingsPath, before);
    const opts = { settingsPath, dryRun: false, force: false, stubPresent };
    assert.equal((await patchClaudeCodeStatusline("install", opts)).status, "foreign-kept");
    assert.equal((await patchClaudeCodeStatusline("uninstall", opts)).status, "not-present");
    assert.equal(await readFile(settingsPath, "utf8"), before);
    const output: string[] = [];
    const log = console.log;
    console.log = (s) => { output.push(String(s)); };
    try {
      assert.equal((await patchClaudeCodeStatusline("install", { ...opts, force: true })).status, "installed");
    } finally { console.log = log; }
    assert.ok(output.includes(`replacing foreign statusLine ${feed.command}`));
    assert.equal(isOurStatusline(JSON.parse(await readFile(settingsPath, "utf8")).statusLine), true);
  });
}
