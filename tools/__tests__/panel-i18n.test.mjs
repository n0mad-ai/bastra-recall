import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLang, render, stageFields, toolLabel, t } from '../../packages/statusline/src/panel/i18n.ts';
import { renderNeural, NEURAL_DEMO } from '../../packages/statusline/src/panel/neural.ts';

test('panel language defaults to German and accepts only en as English', () => {
  assert.deepEqual([resolveLang('en'), resolveLang(' EN '), resolveLang('de'), resolveLang('fr'), resolveLang(undefined), resolveLang(null)], ['en', 'en', 'de', 'de', 'de', 'de']);
  assert.equal(t('de', 'narrow.counts', { searches: 2, saves: 1 }), '2 Suchen, 1 gespeichert');
  assert.equal(t('en', 'context.free', {}), '{free} free'); // a missing value stays visible
});

test('stage texts keep the exact German wording and translate tool labels', () => {
  const labels = { recall: 'tool.recall' };
  assert.equal(stageFields({ key: 'stage.failedCalls', vars: { n: 3 } }).stage, '3 fehlgeschlagene Aufrufe');
  assert.equal(stageFields({ key: 'stage.recentError', ...toolLabel(labels, 'recall') }).stage, 'Zuletzt: Erinnerungen suchen · Fehler');
  assert.equal(render('en', { key: 'stage.recentError', ...toolLabel(labels, 'recall') }), 'Last: Search memories · error');
  assert.equal(render('en', { key: 'stage.recent', ...toolLabel(labels, 'constructor') }), 'Last: constructor'); // raw tool names stay raw
  assert.equal(render('en', { key: 'toString' }), null); // snapshots are external data
  assert.equal(render('en', { key: 'stage.tool', keys: { tool: 'nope' } }), null);
});

test('Ember renders the live stage in the panel language and falls back to the German stage', () => {
  const live = { ...NEURAL_DEMO, mode: 'snapshot', ...stageFields({ key: 'stage.claudeWorking' }) };
  const text = (lang, data = live) => renderNeural(data, 130, 1, false, 'ember', { lang }).join('\n');
  assert.match(text('en'), /Claude working · Recall ready/);
  assert.match(text('de'), /Claude arbeitet · Recall bereit/);
  assert.match(text('en', { ...live, stageText: { key: 'bogus' } }), /Claude arbeitet · Recall bereit/);
  assert.match(text('en', { ...live, stageText: undefined, stage: 'Feed-Text' }), /Feed-Text/);
});

test('panel language follows the Recall primary language unless --lang is given', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { bastraDataDir } = await import('../../packages/core/src/platform-paths.ts');
  const { panelLang } = await import('../../packages/statusline/src/panel/lang-setting.ts');
  const home = (content) => {
    const dir = mkdtempSync(join(tmpdir(), 'panel-lang-'));
    if (content !== undefined) {
      mkdirSync(bastraDataDir(dir), { recursive: true });
      writeFileSync(join(bastraDataDir(dir), 'cli-settings.json'), content);
    }
    return dir;
  };
  const setting = (primary) => home(JSON.stringify({ language: { primary } }));
  assert.equal(panelLang(undefined, setting('de')), 'de');
  assert.equal(panelLang(undefined, setting(' DE ')), 'de');
  for (const dir of [setting('en'), setting('fr'), setting(42), home('{}'), home(), home('{kaputt')]) assert.equal(panelLang(undefined, dir), 'en');
  assert.equal(panelLang('en', setting('de')), 'en');
  assert.equal(panelLang('de', setting('en')), 'de');
});
