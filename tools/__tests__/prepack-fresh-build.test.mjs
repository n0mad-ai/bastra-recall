import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = new URL("../../", import.meta.url);
const dirs = ["core", "statusline", "daemon"];

function fixture(t) {
  const path = mkdtempSync(join(tmpdir(), "bastra-prepack-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  writeFileSync(join(path, "package.json"), JSON.stringify({ private: true, workspaces: dirs.map(dir => `packages/${dir}`) }));
  writeFileSync(join(path, "build.mjs"), `import {appendFileSync,writeFileSync} from 'node:fs';
const name=process.cwd().split('/').at(-1);
appendFileSync('../../builds.log', name+'\\n');
if(process.env.FAIL_BUILD===name) process.exit(7);
writeFileSync('dist/index.js','fresh');\n`);
  for (const dir of dirs) {
    const pkg = JSON.parse(readFileSync(new URL(`packages/${dir}/package.json`, root)));
    mkdirSync(join(path, `packages/${dir}/dist`), { recursive: true });
    writeFileSync(join(path, `packages/${dir}/dist/index.js`), "stale");
    // Exercise the production lifecycle commands through real npm; only the
    // compilers are replaced to keep this regression isolated and inexpensive.
    writeFileSync(join(path, `packages/${dir}/package.json`), JSON.stringify({
      name: pkg.name, version: "0.0.0", files: ["dist"],
      scripts: { build: "node ../../build.mjs", ...(pkg.scripts.prepack ? { prepack: pkg.scripts.prepack } : {}),
        "prepare:package-assets": "node -e ''" },
    }));
  }
  return path;
}

for (const dir of dirs) {
  test(`npm pack ${dir} rebuilds stale output before packing`, t => {
    const path = fixture(t);
    const run = spawnSync("npm", ["pack", "--dry-run", "--json", `--workspace=@bastra-recall/${dir}`], { cwd: path, encoding: "utf8", env: { ...process.env, npm_config_cache: join(path, "cache") } });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(readFileSync(join(path, `packages/${dir}/dist/index.js`), "utf8"), "fresh");
    if (dir !== "core") assert.equal(readFileSync(join(path, "packages/core/dist/index.js"), "utf8"), "fresh");
    if (dir === "daemon") assert.equal(readFileSync(join(path, "packages/statusline/dist/index.js"), "utf8"), "fresh");
  });
}

test("npm pack refuses stale daemon output when a dependency build fails", t => {
  const path = fixture(t);
  const run = spawnSync("npm", ["pack", "--dry-run", "--json", "--workspace=@bastra-recall/daemon"], {
    cwd: path, encoding: "utf8", env: { ...process.env, npm_config_cache: join(path, "cache"), FAIL_BUILD: "core" },
  });
  assert.notEqual(run.status, 0, "packing must fail when the required build fails");
  assert.equal(readFileSync(join(path, "packages/daemon/dist/index.js"), "utf8"), "stale");
});
