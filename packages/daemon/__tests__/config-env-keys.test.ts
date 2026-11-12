import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdConfig } from '../src/cli/config-cmd.js';
import { parseArgs } from '../src/cli/commands.js';
import { readSettings, mutateSettings, settingsFilePath } from '../src/settings.js';

const run = (...args: string[]) => cmdConfig(parseArgs(['config', ...args]));

test('virtual env CLI keys merge daemon.env and reject invalid or externally pinned values', async t => {
  const home = await mkdtemp(join(tmpdir(), 'bastra-config-env-'));
  const savedHome = process.env.HOME;
  const savedFloor = process.env.BASTRA_RECALL_FLOOR;
  const savedHint = process.env.BASTRA_HINT_SUPPRESS;
  process.env.HOME = home;
  delete process.env.BASTRA_RECALL_FLOOR;
  delete process.env.BASTRA_HINT_SUPPRESS;
  t.after(async () => {
    process.env.HOME = savedHome;
    if (savedFloor === undefined) delete process.env.BASTRA_RECALL_FLOOR;
    else process.env.BASTRA_RECALL_FLOOR = savedFloor;
    if (savedHint === undefined) delete process.env.BASTRA_HINT_SUPPRESS;
    else process.env.BASTRA_HINT_SUPPRESS = savedHint;
    await rm(home, { recursive: true, force: true });
  });
  await mutateSettings(settingsFilePath(), current => ({ ...current, daemon: { env: { BASTRA_TRIGGER_EXPAND: 'off' } } }));
  assert.equal(await run('set', 'recall.floor', '35'), 0);
  assert.equal(await run('set', 'hint.suppress', 'off'), 0);
  assert.equal(await run('get', 'recall.floor'), 0);
  const expected = { BASTRA_TRIGGER_EXPAND: 'off', BASTRA_RECALL_FLOOR: '35', BASTRA_HINT_SUPPRESS: 'off' };
  assert.deepEqual((await readSettings()).daemon?.env, expected);
  assert.equal(await run('set', 'recall.floor', 'invalid'), 2);
  assert.equal(await run('set', 'recall.floor'), 2);
  assert.equal(await run('set', 'daemon.env', JSON.stringify({ ...expected, BASTRA_RECALL_FLOOR: 45 })), 2);
  process.env.BASTRA_RECALL_FLOOR = '45';
  assert.equal(await run('set', 'recall.floor', '40'), 2);
  assert.equal(await run('set', 'daemon.env', JSON.stringify({ ...expected, BASTRA_RECALL_FLOOR: '40' })), 2);
  assert.deepEqual((await readSettings()).daemon?.env, expected);
  assert.equal(await run('set', 'daemon.env', JSON.stringify({ ...expected, BASTRA_HINT_SUPPRESS: 'shadow' })), 0);
  assert.deepEqual((await readSettings()).daemon?.env, { ...expected, BASTRA_HINT_SUPPRESS: 'shadow' });
});
