import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, appendFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { nativeSnapshot, publishNative, snapshotPath, ClaudeCalls, ClaudeLiveSource } from '../../packages/statusline/src/panel/claude-data.ts';
import { renderNeural, toggleHit, NEURAL_DEMO } from '../../packages/statusline/src/panel/neural.ts';
import { visibleLength } from '../../packages/statusline/src/utils/terminal.ts';
import { TerminalFrame } from '../../packages/statusline/src/panel/terminal-frame.ts';
import { resetCountdown } from '../../packages/statusline/src/panel/reset-time.ts';
import { sessionForSurface } from '../../packages/statusline/src/panel/follow.ts';

const row = (type, content, extra = {}) => ({ type, sessionId: 's', timestamp: '2026-10-04T18:00:00Z', message: { content }, ...extra });
const call = (id, name) => row('assistant', [{ type: 'tool_use', id, name: 'mcp__bastra-recall__' + name }]);
const result = (id, content = {}, error = false) => row('user', [{ type: 'tool_result', tool_use_id: id, content: JSON.stringify(content), is_error: error }], { timestamp: '2026-10-04T18:00:00.120Z' });
const native = { session_id: 's', workspace: { project_dir: '/project/bastra' }, model: { display_name: 'Opus' },
  context_window: { used_percentage: 24, total_input_tokens: 50, total_output_tokens: 10, context_window_size: 100 },
  rate_limits: { seven_day: { used_percentage: 70 } } };

test('native values win; missing/null values stay unknown; invalid identity is refused', () => {
  assert.equal(nativeSnapshot(native).context, 24);
  assert.equal(nativeSnapshot(native).usage, 70);
  assert.equal(nativeSnapshot({ session_id: 's' }).context, null);
  assert.equal(nativeSnapshot({ ...native, rate_limits: { seven_day: { used_percentage: null } } }).usage, null);
  assert.equal(nativeSnapshot({ ...native, context_window: { ...native.context_window, used_percentage: undefined } }).context, 50);
  assert.throws(() => snapshotPath('../s')); assert.throws(() => nativeSnapshot({}));
});
test('Claude counts results once, isolates session/sidechain, resets on a new real prompt', () => {
  const c = new ClaudeCalls('s');
  const prompt = row('user', 'Hi', { promptId: 'p' }); c.accept(prompt);
  c.accept(call('a', 'recall')); c.accept(result('a', { hits: [{}, {}] })); c.accept(result('a', { hits: [{}] }));
  c.accept(call('b', 'load_memory')); c.accept(result('b'));
  c.accept(call('x', 'save_memory')); c.accept(result('x', {}, true));
  c.accept({ ...call('other', 'recall'), sessionId: 'other' });
  c.accept({ ...call('side', 'recall'), isSidechain: true });
  c.accept(prompt);
  assert.equal(c.searches, 1); assert.equal(c.hits, 2); assert.equal(c.loads, 1); assert.equal(c.saves, 0); assert.equal(c.errors, 1);
  assert.equal(c.ms, 360); assert.equal(c.pending.size, 0);
  c.accept(row('user', 'Next', { promptId: 'new', timestamp: '2026-10-04T18:01:00Z' }));
  c.accept(result('old')); assert.equal(c.loads, 0); assert.equal(c.ms, 0);
});
test('live source incrementally reads exact session; stale native values and unreadable transcript stay unknown', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'claude-panel-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'transcript.jsonl');
  await writeFile(file, [row('user', 'Hi', { promptId: 'p' }), call('a', 'load_memory'), result('a')].map(JSON.stringify).join('\n') + '\n');
  await publishNative({ ...native, transcript_path: file }, dir);
  const source = new ClaudeLiveSource('s', dir, dir);
  let d = await source.poll(); assert.equal(d.loads, 1); assert.equal(d.context, 24); assert.equal(d.latency, 120);
  d = await source.poll(); assert.equal(d.loads, 1);
  await appendFile(file, JSON.stringify(call('b', 'recall')) + '\n');
  d = await source.poll(); assert.equal(d.active, true);
  d = await source.poll(Date.now() + 11000); assert.equal(d.context, null); assert.equal(d.loads, null);
  await publishNative({ ...native, transcript_path: path.join(dir, 'absent') }, dir);
  d = await source.poll(); assert.equal(d.context, 24); assert.equal(d.loads, null);
});
test('classic/orbital are interchangeable and snapshots do not animate fake activity', () => {
  assert.match(renderNeural(NEURAL_DEMO, 130, 0, false, 'classic').join('\n'), /NEURAL CONSOLE/);
  assert.match(renderNeural(NEURAL_DEMO, 130, 0, false, 'orbital').join('\n'), /MEMORY CORE/);
  for (const design of ['classic', 'orbital']) {
    for (const w of [1, 20, 55, 56, 90, 130, 180]) {
      for (const line of renderNeural(NEURAL_DEMO, w, 2, true, design)) assert.ok(visibleLength(line) <= w);
    }
    const snapshot = { ...NEURAL_DEMO, mode: 'snapshot' };
    assert.deepEqual(renderNeural(snapshot, 130, 1, true, design), renderNeural(snapshot, 130, 20, true, design));
  }
});

test('short calls between polls leave a visible afterglow without claiming to be running', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'claude-pulse-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'transcript.jsonl');
  const now = Date.now();
  const records = [row('user', 'Hi', { promptId: 'p', timestamp: new Date(now - 200).toISOString() }),
    { ...call('a', 'recall'), timestamp: new Date(now - 60).toISOString() },
    { ...result('a', { hits: [{}, {}] }), timestamp: new Date(now - 10).toISOString() }];
  await writeFile(file, records.map(JSON.stringify).join('\n') + '\n');
  await publishNative({ ...native, transcript_path: file }, dir);
  const source = new ClaudeLiveSource('s', dir, dir);
  const d = await source.poll(now + 5);
  assert.equal(d.active, false); assert.equal(d.recent, true); assert.equal(d.searches, 1); assert.equal(d.hits, 2);
  assert.match(d.stage, /Zuletzt/);
  assert.notDeepEqual(renderNeural(d, 130, 1, false, 'orbital'), renderNeural(d, 130, 15, false, 'orbital'));
  assert.equal((await source.poll(now + 5100)).recent, false);
});

test('general Claude tools animate the activity signal without animating Recall as a live search', () => {
  const c = new ClaudeCalls('s');
  const b = call('b', 'recall'); b.message.content[0].name = 'Bash';
  c.accept(b); assert.equal(c.pendingTools.size, 1); assert.equal(c.pending.size, 0);
  c.accept(result('b')); assert.equal(c.pendingTools.size, 0); assert.equal(c.searches, 0);
  const d = { ...NEURAL_DEMO, mode: 'live', fresh: true, active: false, recent: false, agentActive: true };
  const a = renderNeural(d, 130, 1, false, 'orbital'), z = renderNeural(d, 130, 15, false, 'orbital');
  assert.deepEqual(a.slice(5, 10), z.slice(5, 10)); // core stays quiet
  assert.notEqual(a.at(-2), z.at(-2)); // activity signal moves
});

test('incremental painter skips idle frames, batches changes, never clears the screen or the last corner', () => {
  const p = new TerminalFrame();
  const first = p.paint(['top', 'bottom╯'], 7, 2);
  assert.match(first, /bottom╯/); assert.ok(first.endsWith('\x1b[?2026l'));
  assert.equal(p.paint(['top', 'bottom╯'], 7, 2), '');
  const changed = p.paint(['top', 'change╯'], 7, 2);
  assert.doesNotMatch(changed, /top/); assert.match(changed, /\x1b\[2;1Hchange╯/);
  assert.doesNotMatch(first + changed, /\x1b\[(?:2J|J|K)/);
  const shorter = p.paint(['top'], 7, 2);
  assert.match(shorter, /\x1b\[2;1H {7}/);
});

test('weekly reset uses native Unix seconds, counts down accurately and distinguishes absent/expired', () => {
  const now = 1791140000000;
  const reset = now / 1000 + 3 * 86400 + 18 * 3600;
  assert.equal(resetCountdown(reset, now), 'RESET IN 3d 18h');
  assert.equal(resetCountdown(now / 1000 + 65 * 60, now), 'RESET IN 1h 5m');
  assert.equal(resetCountdown(now / 1000 + 20, now), 'RESET IN 1m');
  assert.equal(resetCountdown(now / 1000, now), 'RESET FÄLLIG');
  assert.equal(resetCountdown(undefined, now), 'RESET —');
  assert.equal(resetCountdown(NaN, now), 'RESET —');
  assert.equal(nativeSnapshot({ ...native, rate_limits: { seven_day: { used_percentage: 70, resets_at: reset } } }).usageResetsAt, reset);
  for (const design of ['classic', 'orbital']) {
    assert.match(renderNeural({ ...NEURAL_DEMO, usageResetsAt: reset, now }, 140, 0, false, design).join('\n'), /RESET IN 3d 18h/);
  }
});

test('free context is exact native input tokens subtracted from reported total, not a rounded percent estimate', () => {
  const d = nativeSnapshot({ ...native, context_window: { used_percentage: 8, context_window_size: 1_000_000, total_input_tokens: 82821, total_output_tokens: 1234 } });
  assert.equal(d.contextFree, 917179); assert.equal(d.contextTotal, 1_000_000);
  assert.equal(nativeSnapshot({ session_id: 's' }).contextFree, null);
  assert.equal(nativeSnapshot({ session_id: 's', context_window: { context_window_size: 100, total_input_tokens: 200 } }).contextFree, 0);
  for (const design of ['classic', 'orbital']) {
    assert.match(renderNeural({ ...NEURAL_DEMO, contextFree: d.contextFree, contextTotal: d.contextTotal }, 150, 0, false, design).join('\n'), /917.179 FREI \/ 1.000.000/);
  }
});

test('ember is a third selectable design: exact width, honest unknowns, motion only for real activity', () => {
  const now = 1791140000000, reset = now / 1000 + 3 * 86400 + 18 * 3600;
  const live = { ...NEURAL_DEMO, mode: 'live', fresh: true, contextFree: 917179, contextTotal: 1_000_000, usageResetsAt: reset, now,
    usage5h: 42, usage5hResetsAt: now / 1000 + 7800, apiDurationMs: 1260000, loadedTitles: ['Alt', 'Neu'] };
  const rows = renderNeural(live, 145, 0, false, 'ember'), text = rows.join('\n');
  assert.match(text, /Kontext belegt/); assert.match(text, /917\.179 frei/); assert.match(text, /von 1\.000\.000/);
  assert.match(text, /7 Tage +70 %.*Reset 3d 18h/); assert.match(text, /5 Std +42 %.*Reset 2h 10m/);
  assert.match(text, /1\.368 +6 +3\b/); assert.match(text, /Erinnerungen +gefunden +geladen/); // the sieve reads as a sentence
  assert.equal(rows.slice(4, 12).join('').match(/●/g).length, 9); // one large dot per found and per loaded memory
  assert.match(text, /davon API 21m/);
  assert.ok(text.indexOf('◆ Neu') < text.indexOf('◆ Alt')); // newest loaded title first
  assert.equal(rows.length, 19); assert.equal(rows[0].trim(), ''); // breathing room above and below
  assert.doesNotMatch(renderNeural({ ...live, loadedTitles: undefined }, 145, 0, false, 'ember').join('\n'), /Zuletzt geladen/);
  for (const w of [1, 20, 89, 90, 110, 145, 180]) {
    for (const line of renderNeural({ ...live, project: '記憶\u0007' + 'x'.repeat(200), loadedTitles: ['記'.repeat(90)] }, w, 2, true, 'ember')) assert.equal(visibleLength(line), w);
  }
  const unknown = renderNeural({ ...live, fresh: false, context: null, usage: null, usage5h: null, vault: null, searches: null, hits: null, loads: null, saves: null, contextFree: null, usageResetsAt: null }, 145, 0, false, 'ember').join('\n');
  assert.match(unknown, /Suchen —/); assert.match(unknown, /wartet auf Daten/); assert.match(unknown, /7 Tage +— %.*Reset —/);
  assert.doesNotMatch(unknown.split('\n').slice(4, 12).join(''), /●|[⠁-⣿]/); // no cloud and no dots without data
  for (const still of [{ ...NEURAL_DEMO, mode: 'snapshot' }, live]) {
    assert.deepEqual(renderNeural(still, 145, 1, true, 'ember'), renderNeural(still, 145, 20, true, 'ember'));
  }
  const agent = { ...live, agentActive: true }, a = renderNeural(agent, 145, 1, true, 'ember'), z = renderNeural(agent, 145, 12, true, 'ember');
  assert.deepEqual(a.slice(0, 13), z.slice(0, 13)); // funnel stays quiet for general tools
  assert.notEqual(a[14], z[14]); // activity signal moves
  assert.equal(rows[13].trim() + rows[15].trim() + rows[17].trim(), ''); // half-row padding around the Recall and repository rows
  assert.match(rows[16], /Git —.*davon API/); assert.equal(rows[18].trim(), ''); // no cost data in this fixture
  assert.match(a[13], /▄{145}/); assert.match(a[15], /─{145}/); assert.match(a[17], /▃{145}/); // seams and the hairline are drawn only in colour
  for (const moving of [{ ...live, active: true }, { ...live, recent: true }]) {
    assert.notDeepEqual(renderNeural(moving, 145, 1, true, 'ember').slice(4, 12), renderNeural(moving, 145, 12, true, 'ember').slice(4, 12));
  }
});

test('ember paints its canvas in the terminal background it is given', () => {
  const live = { ...NEURAL_DEMO, mode: 'live', fresh: true };
  assert.match(renderNeural(live, 145, 0, true, 'ember', { paper: [30, 30, 30] })[0], /48;2;30;30;30m/);
  assert.match(renderNeural(live, 145, 0, true, 'ember')[0], /48;2;13;10;20m/); // falls back to its own ink
});

test('ember compact view keeps the gauges, the Recall chain and the activity row; the switch is clickable', () => {
  const live = { ...NEURAL_DEMO, mode: 'live', fresh: true, usage5h: 42 };
  const full = renderNeural(live, 145, 0, false, 'ember', { compact: false }), small = renderNeural(live, 145, 0, false, 'ember', { compact: true });
  assert.equal(full.length, 19); assert.equal(small.length, 6);
  assert.match(full[1], /◐ {3}▾ {3}$/); assert.match(small[0], /^ {3}▂▄▆ bastra recall.*◐ {3}▴ {3}$/);
  assert.doesNotMatch(renderNeural(live, 145, 0, false, 'ember')[1], /[◐▾▴]/); // no switch where nothing can click it
  assert.match(small[2], /Kontext 24 %.*5 Std 42 %.*7 Tage 70 %.*1\.368 Erinnerungen +› +6 gefunden +› +3 geladen/);
  assert.match(small[4], /Semantik abgleichen.*Suchen 2/);
  assert.doesNotMatch(small.join('\n'), /Kontext belegt|Zuletzt geladen|Git|[⠁-⣿]/);
  assert.match(renderNeural(live, 90, 0, false, 'ember', { compact: true })[2], /7 Tage 70 %/); // gauges win over the chain when narrow
  for (const w of [90, 110, 145]) for (const line of renderNeural(live, w, 3, true, 'ember', { paper: [30, 30, 30], compact: true })) assert.equal(visibleLength(line), w);
  assert.deepEqual([toggleHit(145, 141, 1), toggleHit(145, 144, 0), toggleHit(145, 140, 0), toggleHit(145, 139, 1), toggleHit(145, 136, 2), toggleHit(145, 135, 1), toggleHit(145, 140, 3), toggleHit(80, 76, 1)],
    ['view', 'view', 'view', 'skin', 'skin', null, null, null]);
  const pale = renderNeural(live, 145, 0, true, 'ember', { paper: [30, 30, 30], compact: false, light: true });
  assert.match(pale[0], /48;2;247;242;233m/); assert.doesNotMatch(pale.join(''), /48;2;30;30;30m/); // light skin owns its canvas
  assert.match(renderNeural(live, 145, 0, false, 'ember', { compact: false, light: true })[1], /◑ {3}▾ {3}$/);
  assert.match(renderNeural(live, 145, 0, true, 'ember', { paper: [30, 30, 30] })[0], /48;2;30;30;30m/); // and the next dark render gets its own back
});

test('loaded titles are collected per turn from tool results, never from arguments', () => {
  const c = new ClaudeCalls('s');
  c.accept(row('user', 'Hi', { promptId: 'p' }));
  c.accept(call('a', 'load_memory')); c.accept(result('a', { id: 'slug', frontmatter: { title: 'Titel A' } }));
  c.accept(call('b', 'load_memory')); c.accept(result('b', { id: 'nur-id' }));
  c.accept(call('e', 'load_memory')); c.accept(result('e', { title: 'x' }, true));
  assert.deepEqual(c.loaded, ['Titel A', 'nur-id']);
  c.accept(row('user', 'Next', { promptId: 'q', timestamp: '2026-10-04T18:01:00Z' }));
  assert.deepEqual(c.loaded, []);
  const five = nativeSnapshot({ ...native, rate_limits: { five_hour: { used_percentage: 12, resets_at: 99 } }, cost: { total_api_duration_ms: 5 } });
  assert.equal(five.usage5h, 12); assert.equal(five.usage5hResetsAt, 99); assert.equal(five.apiDurationMs, 5);
  assert.equal(nativeSnapshot(native).usage5h, null);
});

test('a followed pane resolves the tab to its current session across Claude and Codex', () => {
  const claude = { activeSessionsBySurface: { 'AAA': { sessionId: 'new', updatedAt: 20 } },
    sessions: { old: { sessionId: 'old', surfaceId: 'AAA', updatedAt: 30 }, new: { sessionId: 'new', surfaceId: 'AAA', updatedAt: 10, transcriptPath: '/t' }, bad: { sessionId: '../x', surfaceId: 'CCC', updatedAt: 1 } } };
  const codex = { sessions: { c1: { sessionId: 'c1', surfaceId: 'bbb', updatedAt: 5, transcriptPath: '/r' }, c0: { sessionId: 'c0', surfaceId: 'BBB', updatedAt: 4 }, c2: { sessionId: 'c2', surfaceId: 'AAA', updatedAt: 15 } } };
  assert.deepEqual(sessionForSurface({ claude, codex }, 'aaa'), { client: 'claude', sessionId: 'new', transcript: '/t' }); // active marker beats a newer stale record
  assert.deepEqual(sessionForSurface({ claude, codex }, 'BBB'), { client: 'codex', sessionId: 'c1', transcript: '/r' });
  assert.equal(sessionForSurface({ claude, codex: { sessions: { c2: { sessionId: 'c2', surfaceId: 'AAA', updatedAt: 25 } } } }, 'AAA').client, 'codex'); // newest client in the tab wins
  assert.equal(sessionForSurface({ claude, codex }, 'CCC'), null); assert.equal(sessionForSurface({}, 'AAA'), null);
});

test('unknown Recall counts are a dash in every design, never a zero-padded dash', () => {
  const unknown = { ...NEURAL_DEMO, mode: 'live', searches: null, hits: null, loads: null, saves: null };
  for (const design of ['classic', 'orbital', 'ember']) {
    const text = renderNeural(unknown, 130, 0, false, design).join('\n');
    assert.doesNotMatch(text, /0—/); assert.match(text, /— S|Suchen —/i);
  }
  assert.match(renderNeural(NEURAL_DEMO, 130, 0, false, 'orbital').join('\n'), /02 SUCHEN {2}→ {2}06 TREFFER/);
});
