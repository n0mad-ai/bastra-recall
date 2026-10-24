import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bastraDataDir } from '../../packages/core/src/platform-paths.ts';
import { renderNeural, NEURAL_DEMO } from '../../packages/statusline/src/panel/neural.ts';
import { resolveLang } from '../../packages/statusline/src/panel/i18n.ts';
import { visibleLength } from '../../packages/statusline/src/utils/terminal.ts';

const data = {
  ...NEURAL_DEMO, mode: 'live', fresh: true, stage: 'Recall', context: 70,
  loadedTitles: [], costUsd: 0.12, now: 1_800_000_000_000, usageResetsAt: 1_800_000_000,
  git: { known: true, branch: 'main', staged: 1, changed: 2, untracked: 3, conflicts: 4, ahead: 0, behind: 0 },
};
const render = (lang, compact = false, width = 200, color = false) =>
  renderNeural(data, width, 0, color, 'ember', { lang, compact });

test('language resolution accepts English and safely defaults to German', () => {
  for (const value of [undefined, null, '', 'fr', 'de', 'unknown']) assert.equal(resolveLang(value), 'de');
  for (const value of ['en', 'EN', ' en ']) assert.equal(resolveLang(value), 'en');
});

test('Ember default output equals explicit German in full and compact views', () => {
  for (const compact of [false, true]) assert.deepEqual(render(undefined, compact), render('de', compact));
  const full = render('de').join('\n');
  for (const text of ['Zuletzt geladen', 'Noch nichts seit deiner letzten Nachricht', 'Context Rot: neu starten', '2 geändert', '3 neu', '4 Konflikte', 'Kosten']) assert.ok(full.includes(text), text);
  const compact = render('de', true).join('\n');
  for (const text of ['Kontext', '5 Std', '7 Tage', 'Suchen', 'gespeichert']) assert.ok(compact.includes(text), text);
});

test('Ember translates English full and compact views including shared helper labels', () => {
  const full = render('en').join('\n');
  for (const text of ['Last loaded', 'Nothing yet since your last message', 'Context rot: restart', '2 changed', '3 new', '4 conflicts', 'Cost', 'Reset due']) assert.ok(full.includes(text), text);
  const compact = render('en', true).join('\n');
  for (const text of ['Context', '5 h', '7 days', 'searches', 'saved', 'memories', 'found', 'loaded']) assert.ok(compact.includes(text), text);
  for (const output of [full, compact]) assert.doesNotMatch(output, /Kontext|Suchen|gespeichert|geändert|Konflikte/);
  // Module-level language state must reset on each render.
  assert.deepEqual(render(undefined), render('de'));
});

test('English Ember retains terminal widths across skins and compact/full layouts', () => {
  for (const width of [1, 20, 55, 89, 90, 130, 200]) for (const compact of [false, true]) for (const light of [false, true]) {
    for (const line of renderNeural(data, width, 0, true, 'ember', { lang: 'en', compact, light })) assert.equal(visibleLength(line), width);
  }
});

// The CLI default follows ~/.bastra/cli-settings.json, so each run gets its own HOME.
const homeWith = (primary) => {
  const home = mkdtempSync(join(tmpdir(), 'panel-cli-'));
  if (primary) {
    mkdirSync(bastraDataDir(home), { recursive: true });
    writeFileSync(join(bastraDataDir(home), 'cli-settings.json'), JSON.stringify({ language: { primary } }));
  }
  return home;
};
const germanHome = homeWith('de');
const emptyHome = homeWith();
const cliIn = (home, ...args) => spawnSync(process.execPath, ['--import', 'tsx', 'packages/statusline/src/recall-panel.ts', ...args], {
  cwd: new URL('../..', import.meta.url), encoding: 'utf8', timeout: 15_000, env: { ...process.env, HOME: home, USERPROFILE: home },
});
const cli = (...args) => cliIn(germanHome, ...args);

test('panel CLI validates --lang and defaults to the Recall language setting', () => {
  for (const value of ['fr', 'EN', '']) {
    const result = cli('--demo', '--lang', value);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /--lang muss de oder en sein/);
  }
  for (const compact of [false, true]) {
    const args = ['--demo', '--design', 'ember', '--no-color', ...(compact ? ['--compact'] : [])];
    const english = cli(...args, '--lang', 'en');
    assert.equal(english.status, 0, english.stderr);
    assert.match(english.stdout, /Demo with sample data/);
    assert.match(english.stdout, /context/i);
    assert.match(english.stdout, /Tool time 120 ms/);
    assert.doesNotMatch(english.stdout, /Toolzeit|Kontext|gespeichert/);
    const german = cli(...args);
    assert.equal(german.status, 0, german.stderr);
    assert.match(german.stdout, /Demo mit Beispieldaten/);
    assert.match(german.stdout, /Kontext/);
    assert.equal(cli(...args, '--lang', 'de').stdout, german.stdout);
    // Without a German setting the default is English; --lang still wins.
    assert.equal(cliIn(emptyHome, ...args).stdout, english.stdout);
    assert.equal(cliIn(emptyHome, ...args, '--lang', 'de').stdout, german.stdout);
  }
});
