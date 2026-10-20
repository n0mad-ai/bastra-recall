import test from "node:test";
import assert from "node:assert/strict";
import { hookStubBin } from "../src/cli/paths.js";
import { decorateHookPayload } from "../src/hook-surface.js";
import { planHookEntries, statuslineCommand } from "../src/cli/adapters/claude-code.js";
import { planCodexHooks } from "../src/cli/adapters/codex.js";
import { hookWrapper, runsOurHookRunner, windowsHookToken } from "../src/cli/adapters/command-paths.js";

function commands(hooks: Record<string, unknown>): string[] {
  return Object.values(hooks).flatMap((entries) => (entries as { hooks: { command: string }[] }[]).flatMap((e) => e.hooks.map((h) => h.command)));
}

test("installer stub path uses native Windows separators and .exe; Mac path stays unchanged", () => {
  assert.equal(hookStubBin("C:\\Program Files\\Bastra", "win32"), "C:\\Program Files\\Bastra\\stub\\bastra-hook.exe");
  assert.equal(hookStubBin("/usr/local/lib/bastra", "darwin"), "/usr/local/lib/bastra/stub/bastra-hook");
});

for (const stubPresent of [true, false]) {
  test(`Windows registrations call ${stubPresent ? "compiled stub directly" : "Node fallback"} with argv marker`, () => {
    for (const [client, plan] of [["claude-code", planHookEntries], ["codex", planCodexHooks]] as const) {
      const opts = { includeStop: true, stubPresent, platform: "win32", mapBin: (bin: string) => `C:\\Program Files\\Bastra\\daemon\\dist\\${bin.split("/").pop()}` };
      const first = plan("install", {}, opts);
      const cmds = commands(first.after);
      assert.ok(cmds.length >= 7);
      for (const cmd of cmds) {
        assert.ok(cmd.endsWith(`--client=${client}`), cmd);
        assert.ok(!cmd.includes("BASTRA_HOOK_CLIENT="), cmd);
        assert.ok(!cmd.includes("'"), cmd);
        assert.equal(cmd.startsWith("node "), !stubPresent, cmd);
        if (!stubPresent) assert.match(cmd, /^node "C:\/Program Files\/Bastra\/daemon\/dist\//);
      }
      // Install/doctor/uninstall must still recognize the new command shape.
      const second = plan("install", first.after, opts);
      assert.deepEqual(commands(second.after), cmds);
      assert.equal(commands(plan("uninstall", first.after, opts).after).length, 0);
    }
  });
}

test("Windows command recognition and wrapper extraction retain user suffix only", () => {
  const cmd = 'node "C:/Program Files/Bastra/daemon/dist/session-hook.js" --client=codex >> log.txt';
  assert.ok(runsOurHookRunner(cmd, ["session-hook.js"], "BASTRA_HOOK_CLIENT=codex"));
  assert.deepEqual(hookWrapper(cmd, "session-hook.js", "session"), { prefix: "", suffix: " >> log.txt" });
  assert.equal(windowsHookToken('C:\\Program Files\\Bastra\\bastra-hook.exe'), '"C:/Program Files/Bastra/bastra-hook.exe"');
  assert.equal(statuslineCommand('C:\\Program Files\\Bastra\\index.mjs', false, "win32"), 'node "C:/Program Files/Bastra/index.mjs" --style=powerline');
});

test("registration argv marker reaches hook payload for both stub and Node clients", () => {
  const original = process.argv;
  const env = process.env.BASTRA_HOOK_CLIENT;
  try {
    process.env.BASTRA_HOOK_CLIENT = "claude-code";
    for (const args of [["node", "session-hook.js", "--client=codex"], ["deno", "bastra-hook.exe", "session", "--client=codex"]]) {
      process.argv = args;
      assert.deepEqual(decorateHookPayload({ session_id: "s" }), { session_id: "s", bastra_client: "codex" });
    }
    process.argv = ["node", "hook.js", "--client=invalid"];
    assert.deepEqual(decorateHookPayload({}), { bastra_client: "claude-code" });
  } finally {
    process.argv = original;
    if (env === undefined) delete process.env.BASTRA_HOOK_CLIENT;
    else process.env.BASTRA_HOOK_CLIENT = env;
  }
});
