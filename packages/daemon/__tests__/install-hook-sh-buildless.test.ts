import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dirname, "../../skill/install-hook.sh");
const shellOnly = { skip: process.platform === "win32" };

function checkout(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "bastra-install-buildless-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = join(root, "packages", "skill", "install-hook.sh");
  const home = join(root, "home");
  mkdirSync(join(root, "packages", "skill"), { recursive: true });
  mkdirSync(join(home, ".claude"), { recursive: true });
  copyFileSync(SCRIPT, script);
  const settings = join(home, ".claude", "settings.json");
  const run = (...args: string[]) => spawnSync("bash", [script, ...args], {
    env: { ...process.env, HOME: home }, encoding: "utf8",
  });
  return { root, run, settings };
}

test("install-hook.sh uninstalls without dist and keeps a foreign handler in the same entry", shellOnly, (t) => {
  const { run, settings } = checkout(t);
  writeFileSync(settings, JSON.stringify({ hooks: {
    PreToolUse: [{ matcher: "Write", hooks: [
      { type: "command", command: "node /old/daemon/dist/hook.js" },
      { type: "command", command: "~/bin/my-bastra-recall-audit-hook.sh" },
    ] }],
    Stop: [{ hooks: [{ type: "command", command: "node /old/stop-hook.js", __bastraRecall: true }] }],
  } }));
  const result = run("--uninstall");
  assert.equal(result.status, 0, result.stderr);
  const hooks = JSON.parse(readFileSync(settings, "utf8")).hooks;
  assert.deepEqual(hooks.PreToolUse[0].hooks.map((h: { command: string }) => h.command), ["~/bin/my-bastra-recall-audit-hook.sh"]);
  assert.equal(hooks.Stop, undefined);
  assert.ok(existsSync(`${settings}.bak`));
});

test("install-hook.sh checks for a build before changing settings or its backup", shellOnly, (t) => {
  const { run, settings } = checkout(t);
  const original = '{"hooks":{"UserPromptSubmit":[]}}\n';
  writeFileSync(settings, original);
  writeFileSync(`${settings}.bak`, "previous backup");
  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /run npm run build/);
  assert.equal(readFileSync(settings, "utf8"), original);
  assert.equal(readFileSync(`${settings}.bak`, "utf8"), "previous backup");
});

test("install-hook.sh explains an outdated adapter before changing settings", shellOnly, (t) => {
  const { root, run, settings } = checkout(t);
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  const adapter = join(root, "packages", "daemon", "dist", "cli", "adapters", "claude-code.js");
  mkdirSync(resolve(adapter, ".."), { recursive: true });
  writeFileSync(adapter, "export const hookDefinitions = () => []; export const planHookEntries = () => ({ after: {}, leftAlone: undefined });\n");
  writeFileSync(settings, "{}\n");
  writeFileSync(`${settings}.bak`, "previous backup");
  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /hook adapter is outdated; run npm run build/);
  assert.doesNotMatch(result.stderr, /TypeError/);
  assert.equal(readFileSync(settings, "utf8"), "{}\n");
  assert.equal(readFileSync(`${settings}.bak`, "utf8"), "previous backup");
});
