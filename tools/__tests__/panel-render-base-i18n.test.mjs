import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderBase, loadedRows, compactRows } from '../../packages/statusline/src/panel/render-base.ts';
import { visibleLength } from '../../packages/statusline/src/utils/terminal.ts';

const palette = Object.fromEntries(['bg', 'white', 'soft', 'frame', 'cyan', 'purple', 'amber', 'pink'].map(key => [key, '0;0;0']));
const data = {
  mode: 'live', fresh: false, project: 'project', model: 'model', context: 24,
  usage5h: 12, usage: 70, usageResetsAt: 1700000000, now: 1700000001000,
  vault: 100, searches: 2, hits: 6, loads: 3, saves: 1,
  latency: 120, stage: 'Ready', loadedTitles: ['First', 'Latest'],
  git: { known: true, branch: 'main', sha: null, staged: 1, changed: 2, untracked: 3, conflicts: 4, ahead: 0, behind: 0 },
};
const plain = rows => rows.map(row => row.map(run => run.text).join(''));
const compact = (extra = {}, view = {}, width = 180, color = false) => compactRows({ ...data, ...extra }, width, 0, color, view, palette, 'PANEL');

test('loaded rows preserve German defaults and translate heading and empty state', () => {
  const { r } = createRenderBase(palette);
  assert.deepEqual(plain(loadedRows(data, r)), ['Zuletzt geladen', '◆ Latest', '◆ First']);
  assert.deepEqual(plain(loadedRows({ ...data, loadedTitles: [] }, r)), ['Zuletzt geladen', 'Noch nichts seit deiner letzten Nachricht']);
  assert.deepEqual(plain(loadedRows(data, r, 'en')), ['Last loaded', '◆ Latest', '◆ First']);
  assert.deepEqual(plain(loadedRows({ ...data, loadedTitles: [] }, r, 'en')), ['Last loaded', 'Nothing yet since your last message']);
  assert.deepEqual(plain(loadedRows({ ...data, loadedTitles: undefined }, r, 'en')), ['Last loaded', '—']);
  assert.deepEqual(plain(loadedRows({ ...data, loadedTitles: ['1', '2', '3', '4', '5', '6', '7'] }, r, 'en')).slice(1), ['◆ 7', '◆ 6', '◆ 5', '◆ 4', '◆ 3', '◆ 2']);
});

test('compact rows preserve the German snapshot by default', () => {
  const rows = compact().map(row => row.trimEnd());
  assert.equal(rows[0].trim().replace(/ +/g, ' '), 'PANEL · model / project wartet auf Daten');
  assert.deepEqual(rows.slice(1), [
    '─'.repeat(180),
    'Kontext 24 % · 5 Std 12 % · 7 Tage 70 % · RESET FÄLLIG',
    'Geladen: Latest',
    '○ Ready · 02 Suchen · 06 Treffer · 03 geladen · 01 gespeichert · Client 120 ms',
    '⑂ main · 1 staged · 2 geändert · 3 neu · 4 Konflikte · API —',
  ]);
  assert.deepEqual(compact(), compact({}, { lang: 'de' }));
});

test('English compact rows translate waiting, quotas, loaded, counters, git and timing', () => {
  const rows = compact({ mode: 'demo', loadedTitles: [] }, { lang: 'en' }).map(row => row.trimEnd());
  assert.equal(rows[2], 'Context 24 % · 5 h 12 % · 7 days 70 % · RESET DUE');
  assert.equal(rows[3], 'Loaded: nothing yet');
  assert.equal(rows[4], '◉ Ready · 02 searches · 06 hits · 03 loaded · 01 saved · Tool time 120 ms');
  assert.equal(rows[5], '⑂ main · 1 staged · 2 changed · 3 new · 4 conflicts · API —');
  assert.match(compact({}, { lang: 'en' })[0], /waiting for data/);
  assert.equal(compact({ loadedTitles: undefined }, { lang: 'en' })[3].trimEnd(), 'Loaded: —');
  const session = compact({ costUsd: 0.25, cachedInputRatio: 0.5, linesAdded: 3, linesRemoved: 2 }, { lang: 'en' })[5];
  assert.match(session, /Cost ≈\$0\.25 · Cached input 50% · Lines \+3\/−2/);
  const override = compactRows(data, 180, 0, false, { lang: 'de' }, palette, 'PANEL', 'en');
  assert.match(override[0], /waiting for data/);
});

test('translated compact rows fit every requested width with and without colors', () => {
  for (const lang of ['de', 'en']) for (const width of [1, 20, 55, 89, 90, 130, 180]) for (const color of [false, true]) {
    const rows = compact({}, { lang, compact: true }, width, color);
    assert.equal(rows.length, 6);
    for (const row of rows) assert.equal(visibleLength(row), width);
  }
});
