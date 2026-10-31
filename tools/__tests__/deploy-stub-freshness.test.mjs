import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const root = new URL("../../", import.meta.url);
for (const [label, stamp, expected] of [
  ["fresh", {source_digest:"source",statusline_digest:"bundle"},0],
  ["stale hook", {source_digest:"old",statusline_digest:"bundle"},1],
  ["stale statusline", {source_digest:"source",statusline_digest:"old"},1],
  ["unstamped", {},1],
]) test(`release verification rejects drift: ${label}`, t => {
  const dir=mkdtempSync(join(tmpdir(), "bastra-release-stub-"));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  mkdirSync(join(dir,"scripts"));
  copyFileSync(new URL("packages/daemon/scripts/verify-stub-build.mjs",root), join(dir,"scripts/verify-stub-build.mjs"));
  writeFileSync(join(dir,"scripts/stub-source-digest.mjs"),'export const stubSourceDigest=()=>"source"; export const statuslineBundleDigest=()=>"bundle";');
  // Node is the executable; its version-call replacement prints a fixture stamp.
  const binary=join(dir,"binary");
  writeFileSync(binary, `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify(stamp))});`,{mode:0o755});
  const run=spawnSync(process.execPath,[join(dir,"scripts/verify-stub-build.mjs"),binary],{encoding:"utf8"});
  assert.equal(run.status,expected,run.stderr);
});
test("deploy explicitly compiles then verifies the hook; ordinary builds remain lightweight", () => {
  const pkg=JSON.parse(readFileSync(new URL("package.json",root)));
  assert.match(pkg.scripts["build:deploy"],/npm run build .*npm run build:stub .*verify-stub-build/);
  assert.doesNotMatch(pkg.scripts.build,/build:stub/);
  const workflow=readFileSync(new URL(".github/workflows/publish-npm.yml",root),"utf8");
  assert.match(workflow,/verify-stub-build\.mjs.*matrix\.native/);
});
for (const mode of ["fresh", "build-fails", "compiler-fails", "stale-output"]) {
  test(`real npm deployment lifecycle: ${mode}`, t => {
    const dir = mkdtempSync(join(tmpdir(), "bastra-deploy-lifecycle-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const pkg = JSON.parse(readFileSync(new URL("package.json", root)));
    mkdirSync(join(dir, "packages/daemon/scripts"), { recursive: true });
    mkdirSync(join(dir, "packages/daemon/stub"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ private: true,
      workspaces: ["packages/daemon"], scripts: { "build:deploy": pkg.scripts["build:deploy"], build: "node build.cjs" } }));
    writeFileSync(join(dir, "build.cjs"), `require('node:fs').appendFileSync('order.log','build\\n'); if(process.env.DEPLOY_MODE==='build-fails')process.exit(8);`);
    writeFileSync(join(dir, "packages/daemon/package.json"), JSON.stringify({ name: "@bastra-recall/daemon", scripts: { "build:stub": "node compiler.cjs" } }));
    writeFileSync(join(dir, "packages/daemon/compiler.cjs"), `const fs=require('node:fs');fs.appendFileSync('../../order.log','compile\\n');if(process.env.DEPLOY_MODE==='compiler-fails')process.exit(9);const stamp={source_digest:process.env.DEPLOY_MODE==='stale-output'?'old':'source',statusline_digest:'bundle'};fs.writeFileSync('stub/bastra-hook',${JSON.stringify(`#!${process.execPath}\n`)}+'console.log('+JSON.stringify(JSON.stringify(stamp))+');',{mode:0o755});`);
    writeFileSync(join(dir, "packages/daemon/stub/bastra-hook"), "old binary", { mode: 0o755 });
    copyFileSync(new URL("packages/daemon/scripts/verify-stub-build.mjs", root), join(dir, "packages/daemon/scripts/verify-stub-build.mjs"));
    writeFileSync(join(dir, "packages/daemon/scripts/stub-source-digest.mjs"), `import{appendFileSync}from'node:fs'; export const stubSourceDigest=()=>{appendFileSync('order.log','verify\\n');return 'source'};export const statuslineBundleDigest=()=> 'bundle';`);
    const run = spawnSync("npm", ["run", "build:deploy"], { cwd: dir, encoding: "utf8",
      env: { ...process.env, DEPLOY_MODE: mode, npm_config_cache: join(dir, "cache") } });
    assert.equal(run.status === 0, mode === "fresh", run.stdout + run.stderr);
    const steps = readFileSync(join(dir, "order.log"), "utf8");
    assert.equal(steps, mode === "build-fails" ? "build\n" : mode === "compiler-fails" ? "build\ncompile\n" : "build\ncompile\nverify\n");
    if (mode.endsWith("fails")) assert.equal(readFileSync(join(dir, "packages/daemon/stub/bastra-hook"), "utf8"), "old binary");
  });
}
