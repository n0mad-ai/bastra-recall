/** Real adapter, invented registrations and temporary homes only. */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DoctorResult } from "../src/cli/types.js";

async function doctor(scenario: string): Promise<DoctorResult> {
  const home = await mkdtemp(join(tmpdir(), "claude-doctor-notice-"));
  try {
    const adapter = new URL("../src/cli/adapters/claude-code.ts", import.meta.url).href;
    const paths = new URL("../src/cli/paths.ts", import.meta.url).href;
    const program = `
      const { mkdir, writeFile, readFile, cp } = await import('node:fs/promises');
      const { join, basename } = await import('node:path');
      const { claudeCodeAdapter, planHookEntries } = await import(${JSON.stringify(adapter)});
      const { SKILL_SOURCE_DIR, SKILL_TARGET_DIR, CLAUDE_CODE_CONFIG, CLAUDE_CODE_SETTINGS } = await import(${JSON.stringify(paths)});
      await cp(SKILL_SOURCE_DIR, SKILL_TARGET_DIR, { recursive: true });
      const home = process.env.HOME, forwarder = join(home, 'mcp-forwarder.js');
      await writeFile(forwarder, '// invented fixture');
      await writeFile(CLAUDE_CODE_CONFIG, JSON.stringify({ mcpServers: { 'bastra-recall': {
        command: process.execPath, args: [forwarder], env: { BASTRA_VAULT_PATH: home }
      } } }));
      const scenario = process.env.DOCTOR_SCENARIO;
      const hooks = planHookEntries('install', {}, {
        includeStop: scenario !== 'optional-stop', stubPresent: false,
        mapBin: path => join(home, basename(path)),
      }).after;
      for (const file of ['session-hook.js', 'prompt-hook.js', 'hook.js', 'todo-hook.js', 'bash-pre-hook.js', 'bash-fail-hook.js', 'stop-hook.js'])
        await writeFile(join(home, file), '// invented fixture');
      if (scenario !== 'healthy' && scenario !== 'missing-bash')
        hooks.PostToolUse = hooks.PostToolUse.filter(row => !row.matcher?.includes('save_memory'));
      if (scenario === 'missing-recall') hooks.UserPromptSubmit = [];
      if (scenario === 'missing-bash') hooks.PostToolUse = hooks.PostToolUse.filter(row => row.matcher !== 'Bash');
      if (scenario === 'wrong-matcher') hooks.PostToolUse.push({ matcher: '^recall$', hooks: [{ type: 'command', command: 'node ' + join(home, 'bash-fail-hook.js') }] });
      const raw = scenario === 'malformed' ? '{' : JSON.stringify({ hooks });
      await writeFile(CLAUDE_CODE_SETTINGS, raw);
      const result = await claudeCodeAdapter.doctor();
      if (await readFile(CLAUDE_CODE_SETTINGS, 'utf8') !== raw) throw new Error('doctor changed the registration');
      process.stdout.write(JSON.stringify(result));
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", program], {
      encoding: "utf8", timeout: 10_000,
      env: { ...process.env, HOME: home, USERPROFILE: home, DOCTOR_SCENARIO: scenario, BASTRA_DAEMON_URL: "http://127.0.0.1:1" },
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  } finally { await rm(home, { recursive: true, force: true }); }
}

test("Claude doctor keeps recall healthy when only the save notice is absent", async () => {
  for (const scenario of ["missing-notice", "optional-stop", "wrong-matcher"]) {
    const result = await doctor(scenario);
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.ok(result.features); assert.ok(result.details);
    assert.equal(result.features.recallHooks, true);
    assert.equal(result.features.stopHook, scenario !== "optional-stop");
    assert.match(result.message, /save notice missing.*bastra install claude-code/);
    assert.match(result.details["save-notice-hook"], /MISSING/);
  }
});

test("Claude doctor still refuses missing recall registrations and malformed settings", async () => {
  const healthy = await doctor("healthy");
  assert.equal(healthy.status, "ok"); assert.equal(healthy.features?.recallHooks, true);
  assert.equal(healthy.details?.["save-notice-hook"], "registered");
  for (const scenario of ["missing-recall", "missing-bash", "malformed"]) {
    const result = await doctor(scenario);
    assert.equal(result.status, "broken", JSON.stringify(result));
    assert.equal(result.features?.recallHooks, false);
  }
});
