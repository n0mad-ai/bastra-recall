import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test(
  "macOS staged login registration writes/removes a temporary plist without unloading; foreign plist remains untouched",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const home = await mkdtemp(join(tmpdir(), "settings-autostart-stage-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true });
    const program = join(home, "daemon-fixture.js");
    await writeFile(program, "");
    const cli = new URL("../src/cli/autostart.ts", import.meta.url).href;
    const ui = new URL("../src/settings-autostart.ts", import.meta.url).href;
    const script = `import assert from 'node:assert/strict';import {existsSync} from 'node:fs';import {readFile,writeFile} from 'node:fs/promises';import {autostartService,renderPlist,plistPath} from ${JSON.stringify(cli)};import {settingsAutostart} from ${JSON.stringify(ui)};
    const service=autostartService();const program=[process.execPath,${JSON.stringify(program)}];
    const installed=await service.install({BASTRA_AUTOSTART_MANAGED:'1'},program,{reload:false});assert.equal(installed.ok,true);
    assert.equal((await settingsAutostart.status()).installed,true);
    await settingsAutostart.set(false);assert.equal(existsSync(plistPath()),false);
    const foreign=renderPlist({},program);await writeFile(plistPath(),foreign);
    await assert.rejects(()=>settingsAutostart.set(false));assert.equal(await readFile(plistPath(),'utf8'),foreign);
  `;
    const result = spawnSync(
      process.execPath,
      ["--import", fileURLToPath(import.meta.resolve("tsx")), "--input-type=module", "-e", script],
      { env: { ...process.env, HOME: home, BASTRA_DB_PATH: join(home, "state.db") }, encoding: "utf8" }
    );
    assert.equal(result.status, 0, result.stderr);
  }
);
