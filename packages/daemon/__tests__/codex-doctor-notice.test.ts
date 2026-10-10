/** Exercise the real adapter under a temporary HOME and a fake Codex CLI. */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { DoctorResult } from "../src/cli/types.js";

async function doctor(scenario: string): Promise<DoctorResult> {
  const home = await mkdtemp(join(tmpdir(), "codex-doctor-notice-"));
  try {
    const bin = join(home, "bin"); await mkdir(bin);
    const forwarder = join(home, "mcp-forwarder.js"); await writeFile(forwarder, "// fixture\n");
    await writeFile(join(bin, "codex"), `#!${process.execPath}\nprocess.stdout.write(process.env.CODEX_MCP_FIXTURE);\n`, { mode: 0o700 });
    const adapter = new URL("../src/cli/adapters/codex.ts", import.meta.url).href;
    const paths = new URL("../src/cli/paths.ts", import.meta.url).href;
    const program = `
      const { mkdir, writeFile, cp } = await import('node:fs/promises');
      const { join, basename } = await import('node:path');
      const { codexAdapter, planCodexHooks } = await import(${JSON.stringify(adapter)});
      const { SKILL_SOURCE_DIR, CODEX_SKILL_TARGET_DIR, CODEX_HOOKS, CODEX_CONFIG } = await import(${JSON.stringify(paths)});
      await cp(SKILL_SOURCE_DIR, CODEX_SKILL_TARGET_DIR, { recursive: true });
      await mkdir(join(process.env.HOME, '.codex'), { recursive: true });
      await writeFile(CODEX_CONFIG, ${JSON.stringify("[tools.update_plan]\nenabled = true\n")});
      const scenario = process.env.DOCTOR_SCENARIO;
      const hooks = planCodexHooks('install', {}, {
        includeStop: scenario !== 'optional-stop', stubPresent: false,
        mapBin: path => join(process.env.HOME, basename(path)),
      }).after;
      if (scenario !== 'healthy') hooks.PostToolUse = hooks.PostToolUse.filter(row => !row.matcher?.includes('save_memory'));
      if (scenario === 'missing-recall') hooks.UserPromptSubmit = [];
      if (scenario === 'wrong-matcher') hooks.PostToolUse.push({ matcher: '^recall$', hooks: [{ type: 'command', command: 'node ' + join(process.env.HOME, 'bash-fail-hook.js') }] });
      await writeFile(CODEX_HOOKS, scenario === 'malformed' ? '{' : JSON.stringify({ hooks }));
      process.stdout.write(JSON.stringify(await codexAdapter.doctor()));
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", program], {
      encoding: "utf8", timeout: 10_000,
      env: { ...process.env, HOME: home, USERPROFILE: home, PATH: `${bin}${delimiter}${process.env.PATH}`, DOCTOR_SCENARIO: scenario,
        BASTRA_DAEMON_URL: "http://127.0.0.1:1", CODEX_MCP_FIXTURE: JSON.stringify({ name: "bastra-recall", transport: { type: "stdio", args: [forwarder], env: { BASTRA_VAULT_PATH: home } } }) },
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  } finally { await rm(home, { recursive: true, force: true }); }
}

test("only a missing save notice keeps the installation and recall hooks healthy", { skip: process.platform === "win32" }, async () => {
  for (const scenario of ["missing-notice", "optional-stop", "wrong-matcher"]) {
    const result = await doctor(scenario);
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.ok(result.features); assert.ok(result.details);
    assert.equal(result.features.recallHooks, true);
    assert.equal(result.features.stopHook, scenario !== "optional-stop");
    assert.match(result.message, /save notice missing.*bastra install codex/);
    assert.match(result.details["save-notice-hook"], /MISSING/);
    assert.match(result.details["hook-trust"], /\/hooks/);
  }
});

test("healthy notices stay healthy; required recall and unreadable hooks still need repair", { skip: process.platform === "win32" }, async () => {
  const healthy = await doctor("healthy");
  assert.ok(healthy.features); assert.ok(healthy.details);
  assert.equal(healthy.status, "ok"); assert.equal(healthy.features.recallHooks, true);
  assert.equal(healthy.details["save-notice-hook"], "registered");
  assert.doesNotMatch(healthy.message, /missing/);
  for (const scenario of ["missing-recall", "malformed"]) {
    const result = await doctor(scenario);
    assert.ok(result.features);
    assert.equal(result.status, "broken"); assert.equal(result.features.recallHooks, false);
  }
});
