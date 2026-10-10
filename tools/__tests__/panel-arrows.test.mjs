import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PanelGitReader } from '../../packages/statusline/src/panel/git-status.ts';
import { gitLabel } from '../../packages/statusline/src/panel/details.ts';
import { renderNeural, NEURAL_DEMO } from '../../packages/statusline/src/panel/neural.ts';
const exec = promisify(execFile);

test('#1135 only independently positive counts appear in every Neural design for both clients', () => {
  for (const client of ['claude', 'codex']) for (const design of ['classic', 'orbital', 'ember']) {
    for (const [ahead, behind, expected] of [[0,0,''],[2,0,'↑2'],[0,3,'↓3'],[2,3,'↑2 ↓3'],[null,null,''],[2,null,'↑2'],[null,3,'↓3']]) {
      const data = { ...NEURAL_DEMO, mode: 'live', fresh: true, client, git: { known: true, branch: 'fixture', staged: 0, changed: 0, untracked: 0, conflicts: 0, ahead, behind } };
      const label = gitLabel(data); assert.ok(label.endsWith(expected)); assert.doesNotMatch(label, /↑0|↓0|↑null|↓null/);
      if (!expected) assert.doesNotMatch(label, /[↑↓]/);
      const rows = renderNeural(data, 180, 0, false, design).join('\n');
      assert.doesNotMatch(rows, /↑0|↓0|↑null|↓null/);
      for (const arrow of expected.split(' ').filter(Boolean)) assert.ok(rows.includes(arrow), `${client}/${design}: ${arrow}`);
    }
  }
});

test('#1135 local ahead commits and stale remote state are reproduced without a panel fetch', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'panel-arrows-')); t.after(() => rm(root, { recursive: true, force: true }));
  const remote = path.join(root, 'remote.git'), local = path.join(root, 'local'), other = path.join(root, 'other');
  const git = async (cwd, ...args) => (await exec('git', args, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } })).stdout;
  await git(root, 'init', '--bare', remote); await git(root, 'clone', remote, local);
  for (const cwd of [local]) { await git(cwd, 'config', 'user.name', 'Fixture'); await git(cwd, 'config', 'user.email', 'fixture@example.invalid'); }
  await writeFile(path.join(local, 'seed'), 'invented seed'); await git(local, 'add', 'seed'); await git(local, 'commit', '-m', 'seed');
  await git(local, 'push', '-u', 'origin', 'HEAD'); await git(root, 'clone', remote, other);
  await git(other, 'config', 'user.name', 'Fixture'); await git(other, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(path.join(other, 'remote-only'), 'invented remote'); await git(other, 'add', '.'); await git(other, 'commit', '-m', 'remote only'); await git(other, 'push');
  const upstream = (await git(local, 'rev-parse', '@{upstream}')).trim();
  const read = () => new PanelGitReader().read(local); // Fresh reader avoids its documented five-second cache.
  let g = await read(); assert.equal(g.ahead, 0); assert.equal(g.behind, 0); assert.doesNotMatch(gitLabel({git:g}), /[↑↓]/);
  assert.equal((await git(local, 'rev-parse', '@{upstream}')).trim(), upstream, 'panel did not update local remote refs');
  await writeFile(path.join(local, 'local-only'), 'invented local'); await git(local, 'add', '.'); await git(local, 'commit', '-m', 'local only');
  g = await read(); assert.equal(g.ahead, 1); assert.equal(g.behind, 0); assert.match(gitLabel({git:g}), /↑1/); assert.doesNotMatch(gitLabel({git:g}), /↓/);
  await git(local, 'fetch', 'origin'); // Explicit operator fetch, never a panel operation.
  g = await read(); assert.equal(g.ahead, 1); assert.equal(g.behind, 1); assert.match(gitLabel({git:g}), /↑1 ↓1/);
});
