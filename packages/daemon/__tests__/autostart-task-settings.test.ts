import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

test("#1422 autostart compares persisted task settings consistently and retains explicit environment drift", async () => {
  for (const enabled of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), "autostart-task-settings-"));
    const data = join(root, ".bastra");
    await mkdir(data);
    const dbPath = join(data, "recall.db");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE app_records(namespace TEXT,key TEXT,value TEXT)");
    db.prepare("INSERT INTO app_records VALUES('settings',?,?)").run(
      join(data, "cli-settings.json"), JSON.stringify({ text: JSON.stringify({ tasks: { enabled } }) }),
    );
    db.close();
    const before = await readFile(dbPath);
    const source = (file: string) => pathToFileURL(resolve("packages/daemon/src", file)).href;
    // A fresh process is necessary: feature settings are an import-time,
    // read-only snapshot. Stub homedir before importing any application code.
    const code = `
      import os from 'node:os';
      import { syncBuiltinESMExports } from 'node:module';
      import assert from 'node:assert/strict';
      os.homedir = () => ${JSON.stringify(root)};
      syncBuiltinESMExports();
      const { autostartWarning } = await import(${JSON.stringify(source("cli/autostart.ts"))});
      const { tasksEnabled } = await import(${JSON.stringify(source("tasks-enabled.ts"))});
      assert.equal(tasksEnabled(), ${enabled});
      const state = { exists: true, managed: true, loaded: true, path: 'fixture', program: [],
        env: {}, loadedEnv: {}, endpoint: null, danglingProgram: false, missingProgramPath: null };
      const service = { status: async () => state };
      const warning = env => autostartWarning(service, env, ${JSON.stringify(join(root, "empty-backups"))});
      assert.equal(await warning(process.env), null, 'same stored setting is not client/service drift');
      assert.equal(await warning({}), null, 'cloned client environment uses the same stored setting');
      state.loadedEnv = undefined;
      assert.equal(await warning(process.env), null, 'missing loaded environment falls back to plist');
      const matching = { BASTRA_TASKS: ${JSON.stringify(enabled ? "1" : "0")} };
      const opposite = { BASTRA_TASKS: ${JSON.stringify(enabled ? "0" : "1")} };
      state.loadedEnv = matching;
      assert.equal(await warning(process.env), null, 'explicit override equal to stored state agrees');
      state.loadedEnv = opposite;
      assert.match(await warning(process.env), /plist differs from launchd/);
      state.env = opposite;
      assert.match(await warning(process.env), /client environment/);
      assert.equal(await warning(opposite), null, 'matching explicit overrides win over stored state');
      state.env = matching;
      state.loadedEnv = matching;
      assert.match(await warning(opposite), /client environment/);
    `;
    const env: NodeJS.ProcessEnv = { ...process.env, BASTRA_DB_PATH: dbPath };
    delete env.BASTRA_TASKS;
    const outcome = await new Promise<{ status: number | null; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { env });
      let stderr = "";
      child.stderr.on("data", chunk => stderr += chunk);
      child.on("error", reject);
      child.on("close", status => resolve({ status, stderr }));
    });
    assert.equal(outcome.status, 0, `stored tasks.enabled=${enabled}: ${outcome.stderr}`);
    assert.deepEqual(await readFile(dbPath), before, "diagnostics never modify authoritative settings");
  }
});
