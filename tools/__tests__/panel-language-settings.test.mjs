import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bastraDataDir } from '@bastra-recall/core/platform-paths';
import { panelLang, readPrimaryLanguage } from '../../packages/statusline/src/panel/lang-setting.ts';
import { mutateSettings } from '../../packages/daemon/src/settings-file.ts';
import { deleteAppRecord } from '../../packages/daemon/src/app-record-store.ts';

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'panel-language-'));
  const data = bastraDataDir(home);
  await mkdir(data, { recursive: true });
  return { home, data, path: join(data, 'cli-settings.json') };
}

test('#1417 panel language reads DB-only settings and explicit --lang still wins', async () => {
  const { home, path } = await fixture();
  await mutateSettings(path, settings => ({ ...settings, language: { primary: 'de' } }));
  await assert.rejects(readFile(path), { code: 'ENOENT' });
  assert.equal(readPrimaryLanguage(home), 'de');
  assert.equal(panelLang(undefined, home), 'de');
  assert.equal(panelLang('en', home), 'en');
  await writeFile(path, JSON.stringify({ language: { primary: 'en' } }));
  assert.equal(panelLang(undefined, home), 'de', 'DB record supersedes a retained legacy file');
  deleteAppRecord('settings', path);
  await writeFile(path, JSON.stringify({ language: { primary: 'de' } }));
  assert.equal(panelLang(undefined, home), 'en', 'a tombstone must not revive stale legacy settings');
});

test('#1417 panel retains legacy language fallback without creating a database', async () => {
  const { home, data, path } = await fixture();
  assert.equal(panelLang(undefined, home), 'en');
  await writeFile(path, JSON.stringify({ language: { primary: ' DE ' } }));
  assert.equal(panelLang(undefined, home), 'de');
  await assert.rejects(readFile(join(data, 'recall.db')), { code: 'ENOENT' });
});

test('#1417 unavailable authoritative database never revives legacy panel language', async () => {
  const { home, data, path } = await fixture();
  await writeFile(path, JSON.stringify({ language: { primary: 'de' } }));
  await writeFile(join(data, 'recall.db'), 'not a database');
  assert.equal(panelLang(undefined, home), 'en');
});
