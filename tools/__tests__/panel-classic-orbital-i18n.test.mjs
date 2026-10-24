import test from 'node:test';
import assert from 'node:assert/strict';
import { renderNeural, NEURAL_DEMO } from '../../packages/statusline/src/panel/neural.ts';
import { visibleLength } from '../../packages/statusline/src/utils/terminal.ts';

const data = { ...NEURAL_DEMO, mode: 'live', fresh: false, recent: true, contextFree: 812345, contextTotal: 1e6, usage5h: 12, usage5hResetsAt: 1791150000,
  usageResetsAt: 1791400000, now: 1791140000000, apiDurationMs: 60000, loadedTitles: [], costUsd: 0.12, cachedInputRatio: 0.3, linesAdded: 3, linesRemoved: 1,
  durationMs: 4e6, stage: 'Zuletzt: Erinnerungen suchen', stageText: { key: 'stage.recent', keys: { tool: 'tool.recall' } },
  git: { known: true, branch: 'main', staged: 1, changed: 2, untracked: 3, conflicts: 4, ahead: 0, behind: 0 } };
const plain = (design, view, d = data, width = 120) => renderNeural(d, width, 0, false, design, view).map(line => line.trimEnd());
const views = { '': false, '-compact': true };

// Rendered from the sources before classic/orbital learned English; German must not change.
const GERMAN = {
  'classic': [
    '╭──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮',
    '│ ◉  B A S T R A  /  R E C A L L   L A B                                                LIVE / WARTE AUF DATEN  ◐   ▾  │',
    '│ OPUS 5.5  /  bastra-recall   ·   NEURAL CONSOLE                                                                      │',
    '│ ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────── │',
    '│ 01 / KONTEXT                         │ 02 / NUTZUNG · 7 TAGE                │ 03 / RECALL SIGNAL                     │',
    '│ ━━┓ ╻ ╻  812.345 FREI / 1.000.000    │ ━━┓ ┏━┓  RESET IN 3d 0h              │ ○ LEXIKALISCH                          │',
    '│ ┏━┛ ┗━┫                              │   ┃ ┃ ┃                              │ ○ SEMANTISCH                           │',
    '│ ┗━━   ╹ % BELEGT                     │   ╹ ┗━┛ % VERBRAUCHT                 │ ○ RANKING                              │',
    '│ ━━━━━━━━───────────────────────────  │ ━━━━━━━━━━━━━━━━━━━━━━━━━──────────  │ 1368 ERINNERUNGEN                      │',
    '│ ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────── │',
    '│ ⑂ main · 1 staged · 2 geändert · 3 neu · 4 Konflikte   /   Session 1h 6m · API 60 s · Kosten ≈$0.12 · Cache-Eingabe… │',
    '│ 5 Std 12 % · RESET IN 2h 47m   /   API 60 s                                                                          │',
    '│ ↳  02 SUCHEN  →  06 TREFFER  →  03 GELADEN    01 GESPEICHERT    Client 120 ms                                        │',
    '│ ⡀⣀⣄⣤⣦⣶⣦⣤⣄⣀⡀⣀⣄⣤⣦⣶⣦⣤⣄⣀  LIVE  /  Zuletzt: Erinnerungen suchen                                                          │',
    '│ Zuletzt geladen                                                                                                      │',
    '│ Noch nichts seit deiner letzten Nachricht                                                                            │',
    '╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯',
  ],
  'classic-compact': [
    '◉ Neural Console · OPUS 5.5 / bastra-recall                                                    wartet auf Daten  ◐   ▴',
    '────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────',
    'Kontext 24 % · 5 Std 12 % · 7 Tage 70 % · RESET IN 3d 0h',
    'Geladen: noch nichts',
    '◉ Zuletzt: Erinnerungen suchen · 02 Suchen · 06 Treffer · 03 geladen · 01 gespeichert · Client 120 ms',
    '⑂ main · 1 staged · 2 geändert · 3 neu · 4 Konflikte · Session 1h 6m · API 60 s · Kosten ≈$0.12 · Cache-Eingabe 30% · Z…',
  ],
  'orbital': [
    '╭──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮',
    '│ ⟐  B A S T R A  / /  M N E M O S Y N E                                                LIVE / WARTE AUF DATEN  ◐   ▾  │',
    '│ OPUS 5.5  /  bastra-recall   ∴   DEEP MEMORY INTERFACE                                                               │',
    '│ ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────── │',
    '│ ⌁  KONTEXT / NEURAL LOAD             │ ⟐  RECALL / MEMORY CORE              │ ⌁  NUTZUNG / 7 TAGE                    │',
    '│ ╶ · · · · · · · · · · · · · · · · ╴  │           ·◈····· ·······            │ ╶ · · · · · · · · · · · · · · · · · ╴  │',
    '│   ━━┓ ╻ ╻                            │      ·····∘∘∘∘∘∘∘∘∘∘∘∘∘∘∘·····       │   ━━┓ ┏━┓                              │',
    '│   ┏━┛ ┗━┫                            │   ╶  ·   ∘∘    ⟨ ◉ ⟩    ∘∘   ◆  ╴    │     ┃ ┃ ┃                              │',
    '│   ┗━━   ╹ % BELEGT                   │      ·····∘∘∘∘∘∘∘∘∘∘∘∘∘∘∘·····       │     ╹ ┗━┛ % VERBRAUCHT                 │',
    '│ ━━━━━━━━───────────────────────────  │           ·◈····· ·······            │ ━━━━━━━━━━━━━━━━━━━━━━━━━━───────────  │',
    '│ 812.345 FREI / 1.000.000             │ 1368 ERINNERUNGEN  ·  NACHKLANG      │ RESET IN 3d 0h                         │',
    '│ ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────── │',
    '│ ⑂ main · 1 staged · 2 geändert · 3 neu · 4 Konflikte   /   Session 1h 6m · API 60 s · Kosten ≈$0.12 · Cache-Eingabe… │',
    '│ 5 Std 12 % · RESET IN 2h 47m   /   API 60 s                                                                          │',
    '│ ↳  02 SUCHEN  →  06 TREFFER  →  03 GELADEN    01 GESPEICHERT    Client 120 ms                                        │',
    '│ ⣦⣶⣾⣾⣿⣿⣿⣾⣶⣦⣤⣄⣀⡀⡀⡀⣀⣀⣤⣦⣶⣾  LIVE  /  Zuletzt: Erinnerungen suchen                                                        │',
    '│ Zuletzt geladen                                                                                                      │',
    '│ Noch nichts seit deiner letzten Nachricht                                                                            │',
    '╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯',
  ],
  'orbital-compact': [
    '⟐ Mnemosyne · OPUS 5.5 / bastra-recall                                                         wartet auf Daten  ◐   ▴',
    '────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────',
    'Kontext 24 % · 5 Std 12 % · 7 Tage 70 % · RESET IN 3d 0h',
    'Geladen: noch nichts',
    '◉ Zuletzt: Erinnerungen suchen · 02 Suchen · 06 Treffer · 03 geladen · 01 gespeichert · Client 120 ms',
    '⑂ main · 1 staged · 2 geändert · 3 neu · 4 Konflikte · Session 1h 6m · API 60 s · Kosten ≈$0.12 · Cache-Eingabe 30% · Z…',
  ],
};

test('classic and orbital German output is unchanged, with and without explicit lang', () => {
  for (const design of ['classic', 'orbital']) for (const [suffix, compact] of Object.entries(views)) {
    assert.deepEqual(plain(design, { compact }), GERMAN[design + suffix], design + suffix);
    assert.deepEqual(plain(design, { compact, lang: 'de' }), GERMAN[design + suffix], design + suffix);
  }
});

// Every German word classic and orbital can show; English matches are whole words, case-insensitive.
const germanWords = ['Kontext', 'Nutzung', 'Tage', 'Std', 'belegt', 'verbraucht', 'frei', 'Erinnerungen', 'Erinnerung', 'lexikalisch', 'semantisch',
  'aktiv', 'Nachklang', 'bereit', 'Suchen', 'Treffer', 'geladen', 'gespeichert', 'Welle', 'Warte', 'wartet', 'Daten', 'keine', 'Messung', 'Zuletzt',
  'Noch', 'nichts', 'Nachricht', 'Geladen', 'geändert', 'neu', 'Konflikte', 'sauber', 'Kosten', 'Eingabe', 'Zeilen', 'Toolzeit', 'Semantik', 'abgleichen', 'FÄLLIG'];
const hasWord = (text, word) => new RegExp(`(?<![\\p{L}])${word}(?![\\p{L}])`, 'iu').test(text);

test('classic and orbital English output contains no German UI words in full and compact views', () => {
  assert.ok(hasWord(plain('classic', {}).join('\n'), 'Nutzung') && !hasWord('1 staged', 'Tage'));
  for (const design of ['classic', 'orbital']) for (const compact of [false, true]) for (const d of [data, NEURAL_DEMO, { ...data, fresh: true, active: true, loadedTitles: undefined }]) {
    const text = plain(design, { compact, lang: 'en' }, d, 220).join('\n');
    for (const word of germanWords) assert.ok(!hasWord(text, word), `${design}${compact ? ' compact' : ''}: ${word}`);
  }
  const full = plain('classic', { compact: false, lang: 'en' }).join('\n');
  for (const text of ['LIVE / WAITING FOR DATA', '01 / CONTEXT', '02 / USAGE · 7 DAYS', 'LEXICAL', '% USED', '% CONSUMED', '812,345 FREE / 1,000,000', '1368 MEMORIES',
    '2 changed · 3 new · 4 conflicts', 'Cost ≈$0.12', '5 h 12 %', '02 SEARCHES  →  06 HITS  →  03 LOADED    01 SAVED', 'Last loaded', 'Nothing yet since your last message']) assert.ok(full.includes(text), text);
  const orbital = plain('orbital', { compact: false, lang: 'en' }).join('\n');
  for (const text of ['⌁  CONTEXT / NEURAL LOAD', '⌁  USAGE / 7 DAYS', '1368 MEMORIES  ·  AFTERGLOW', '812,345 FREE / 1,000,000']) assert.ok(orbital.includes(text), text);
  assert.match(plain('orbital', { lang: 'en' }, { ...data, active: true }).join('\n'), /MEMORIES  ·  ACTIVE/);
  assert.match(plain('orbital', { lang: 'en' }, { ...data, recent: false }).join('\n'), /MEMORIES  ·  READY/);
  assert.match(plain('classic', { lang: 'en' }, NEURAL_DEMO).join('\n'), /DEMO WAVE  \/  Matching semantics   ·   not measured live/);
  assert.match(plain('orbital', { lang: 'en' }, NEURAL_DEMO).join('\n'), /DEMO SIGNAL  \/  Matching semantics   ·   not measured live/);
});

test('classic and orbital translate the live stage and fall back to the German stage', () => {
  for (const design of ['classic', 'orbital']) for (const compact of [false, true]) {
    assert.match(plain(design, { compact, lang: 'en' }).join('\n'), /Last: Search memories/);
    const raw = { ...data, stage: 'Eigener Text', stageText: undefined };
    assert.match(plain(design, { compact, lang: 'en' }, raw).join('\n'), /Eigener Text/);
    const unknown = { ...data, stage: 'Alter Snapshot', stageText: { key: 'stage.gone' } };
    assert.match(plain(design, { compact, lang: 'en' }, unknown).join('\n'), /Alter Snapshot/);
  }
});

test('English classic and orbital keep exact terminal widths', () => {
  for (const design of ['classic', 'orbital']) for (const width of [1, 20, 55, 56, 70, 89, 90, 120, 200]) for (const compact of [undefined, false, true]) for (const light of [false, true]) {
    for (const line of renderNeural(data, width, 0, true, design, { lang: 'en', compact, light })) assert.equal(visibleLength(line), width, `${design} ${width}`);
  }
});
