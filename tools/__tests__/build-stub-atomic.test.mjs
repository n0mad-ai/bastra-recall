import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const script = new URL('../../packages/daemon/scripts/build-stub.mjs', import.meta.url);
for (const mode of ['fresh', 'compile-failure', 'stale-output', 'empty-output']) test(`stub publication preserves old executable until verified: ${mode}`, t => {
  const root = mkdtempSync(join(tmpdir(), 'bastra-atomic-stub-'));
  t.after(() => rmSync(root, { recursive:true, force:true }));
  for (const dir of ['scripts','stub','bin']) mkdirSync(join(root,dir));
  copyFileSync(script,join(root,'scripts/build-stub.mjs'));
  writeFileSync(join(root,'scripts/stub-source-digest.mjs'), `export const STUB_BUILD_INFO=${JSON.stringify(join(root,'stub/build-info.ts'))};export const stubSourceDigest=()=> 'source';export const statuslineBundleDigest=()=> 'bundle';export const stubSourcesDirty=()=>false;`);
  const placeholder = 'export const STUB_BUILD_INFO: StubBuildInfo = {\n};';
  writeFileSync(join(root,'stub/build-info.ts'),placeholder);
  writeFileSync(join(root,'stub/bastra-hook'),'old executable');
  writeFileSync(join(root,'bin/deno'), `#!${process.execPath}\nconst fs=require('node:fs');const out=process.argv[process.argv.indexOf('--output')+1];fs.writeFileSync('observed.json',JSON.stringify({old:fs.readFileSync('stub/bastra-hook','utf8'),out}));const stamp={source_digest:${JSON.stringify(mode==='stale-output'?'old':'source')},statusline_digest:'bundle'};fs.writeFileSync(out,${JSON.stringify(mode==='empty-output'?'':`#!${process.execPath}\n`)}${mode==='empty-output'?'':`+'console.log('+JSON.stringify(JSON.stringify(stamp))+');'`},{mode:0o755});${mode==='compile-failure'?'process.exit(9);':''}`,{mode:0o755});
  const run=spawnSync(process.execPath,[join(root,'scripts/build-stub.mjs')],{encoding:'utf8',env:{...process.env,PATH:`${join(root,'bin')}:${process.env.PATH}`}});
  assert.equal(run.status===0,mode==='fresh',run.stdout+run.stderr);
  const observed=JSON.parse(readFileSync(join(root,'observed.json'),'utf8'));
  assert.equal(observed.old,'old executable');
  assert.notEqual(join(root,observed.out),join(root,'stub/bastra-hook'),'compiler must not write the live path');
  if(mode!=='fresh') assert.equal(readFileSync(join(root,'stub/bastra-hook'),'utf8'),'old executable');
  else assert.match(readFileSync(join(root,'stub/bastra-hook'),'utf8'),/console.log/);
  assert.equal(readFileSync(join(root,'stub/build-info.ts'),'utf8'),placeholder);
  assert.deepEqual(readdirSync(join(root,'stub')).sort(),['bastra-hook','build-info.ts']);
});

test('explicit stub output creates missing parent directories before staging', t => {
  const root = mkdtempSync(join(tmpdir(), 'bastra-nested-stub-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ['scripts', 'stub', 'bin']) mkdirSync(join(root, dir));
  copyFileSync(script, join(root, 'scripts/build-stub.mjs'));
  writeFileSync(join(root, 'scripts/stub-source-digest.mjs'), `export const STUB_BUILD_INFO=${JSON.stringify(join(root, 'stub/build-info.ts'))};export const stubSourceDigest=()=> 'source';export const statuslineBundleDigest=()=> 'bundle';export const stubSourcesDirty=()=>false;`);
  const placeholder = 'export const STUB_BUILD_INFO: StubBuildInfo = {\n};';
  writeFileSync(join(root, 'stub/build-info.ts'), placeholder);
  writeFileSync(join(root, 'stub/bastra-hook'), 'old executable');
  writeFileSync(join(root, 'bin/deno'), `#!${process.execPath}\nconst fs=require('node:fs');const out=process.argv[process.argv.indexOf('--output')+1];fs.writeFileSync(out,${JSON.stringify(`#!${process.execPath}\nconsole.log(JSON.stringify({source_digest:'source',statusline_digest:'bundle'}));`)},{mode:0o755});`, { mode: 0o755 });
  const output = join(root, 'missing', 'nested', 'bastra-hook');
  const run = spawnSync(process.execPath, [join(root, 'scripts/build-stub.mjs'), '--output', output], { encoding: 'utf8', env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}` } });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(readFileSync(output, 'utf8'), /console.log/);
  assert.equal(readFileSync(join(root, 'stub/bastra-hook'), 'utf8'), 'old executable');
  assert.equal(readFileSync(join(root, 'stub/build-info.ts'), 'utf8'), placeholder);
  assert.deepEqual(readdirSync(join(root, 'missing', 'nested')), ['bastra-hook']);
});

test('interrupted stub staging directories are ignored by git', () => {
  const repo = new URL('../../', import.meta.url);
  const run = spawnSync('git', ['check-ignore', '--no-index', 'packages/daemon/stub/.bastra-hook-build-interrupted/bastra-hook'], { cwd: repo, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
});
